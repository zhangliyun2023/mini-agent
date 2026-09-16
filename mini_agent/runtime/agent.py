"""表驱动的 turn runner（闸）：transition() 先 interpret，allowed → apply，blocked → on_blocked。

RunResult（dict）：{answer, steps: [{kind: llm|tool, detail}], stoppedBy: final|max_steps|error, turn, traceId}
"""
import json
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from contracts.turn_machine import TERMINAL_STOPPED_BY, TurnFacts, turn_machine, turn_runner_protocol  # noqa: F401
from ..llm.errors import classify_llm_error, describe_llm_error, is_retryable
from ..llm.types import NATIVE, ChatMessage, tool_mode_of
from ..machine.interpreter import Machine, interpret
from ..memory.user_memory import MemoryUserMemoryStore, UserMemoryStore, render_memory
from ..protocol.parser import parse_assistant_output
from ..protocol.prompt import build_system_prompt
from ..review.transcript import MemoryTranscriptStore
from ..session.context import DEFAULT_CONTEXT, ContextOptions, assemble_messages, compact_session, needs_compaction, strip_think
from ..session.store import MemorySessionStore
from ..tools.calculator import calculator_tool
from ..tools.registry import ToolRegistry
from ..tools.remember import create_remember_tool
from ..tools.search import search_tool
from ..tools.todo import create_todo_tool
from ..util import iso, iso_now, now_utc
from .trace import MemoryTraceSink, new_request_id, preview

# 重试退避基数：第 n 次失败后等 300ms × 2^n（n 从 0 起）
BACKOFF_BASE_MS = 300


class LlmCallFailed(Exception):
    """模型调用重试耗尽或遇到不可重试错误：message 是给用户看的一行（含类别与状态码），tries 是逐次尝试明细（进 trace）"""

    def __init__(self, message: str, tries: List[dict]):
        super().__init__(message)
        self.message = message
        self.tries = tries


def default_tools(memory: UserMemoryStore) -> ToolRegistry:
    return ToolRegistry().register(calculator_tool).register(search_tool).register(create_todo_tool()).register(create_remember_tool(memory))


def _from_native_tool_calls(calls: List[dict]) -> Dict[str, Any]:
    """原生 function calling 的 tool_calls → 与文本协议同一形状的 ParsedOutput（#10）：runtime 下游的闸、trace、工具执行一条路径。
    arguments 不是合法 JSON 的调用不执行，记进 errors 回喂（与文本协议里坏 JSON 的处置一致）。"""
    runtime_calls: List[dict] = []
    errors: List[str] = []
    for c in calls:
        try:
            args = json.loads(c["arguments"])
        except ValueError as e:
            errors.append(f"tool_call {c['name']}（{c['id']}）的 arguments 不是合法 JSON：{e}；原文：{c['arguments'][:200]}")
            continue
        runtime_calls.append({"name": c["name"], "arguments": args if isinstance(args, dict) else {}, "ref": c})
    return {"parsed": {"toolCalls": [{"name": c["name"], "arguments": c["arguments"]} for c in runtime_calls], "errors": errors, "warnings": []}, "runtime_calls": runtime_calls}


@dataclass
class Agent:
    llm: Any
    tools: Optional[ToolRegistry] = None
    sessions: Any = None
    memory: Optional[UserMemoryStore] = None
    trace: Any = None
    # 逐轮转写（Raw 层，#19）：轮末把本轮消息原样追加，不压缩；默认内存版，CLI 传文件版 `data/transcripts`
    transcripts: Any = None
    # 一次用户输入内最多经过多少次 LLM 决策（每次决策可带多个工具调用）——防死循环的安全阀
    max_tool_steps: int = 8
    # LLM 调用失败的重试次数（只对可重试类生效：限流 / 服务端 / 超时 / 网络 / 未知；认证 / 请求格式 / 不存在一次即终）
    llm_retries: int = 2
    # 重试前的等待（默认真等 time.sleep；测试注入成记录用的假函数，不真等）
    sleep: Optional[Callable[[int], None]] = None
    context: Optional[ContextOptions] = None
    # 表里没列的 (状态, 事件) 怎么处理（D8）："error" = 记 trace，本轮以 error 终态结束（默认；运行时不读任何测试环境变量，#11）；"throw" = 记 trace 后抛出
    unknown_transition: str = "error"
    # 只给测试用：注入一张残缺的表，验证闸真的拦得住
    machine: Optional[Machine] = None

    def __post_init__(self) -> None:
        self.memory = self.memory if self.memory is not None else MemoryUserMemoryStore()
        self.tools = self.tools if self.tools is not None else default_tools(self.memory)
        self.sessions = self.sessions if self.sessions is not None else MemorySessionStore()
        self.trace = self.trace if self.trace is not None else MemoryTraceSink()
        self.transcripts = self.transcripts if self.transcripts is not None else MemoryTranscriptStore()
        self.sleep = self.sleep or (lambda ms: time.sleep(ms / 1000))
        self.context = self.context or DEFAULT_CONTEXT
        self.machine = self.machine or turn_machine
        # 工具给法由 LLM 客户端决定（#10）：原生模式下 system prompt 不教标签协议
        self.mode = tool_mode_of(self.llm)

    def _call_llm(self, messages: List[ChatMessage]) -> Dict[str, Any]:
        """模型调用 + 按错误类型重试（#11）：可重试类指数退避 300ms × 2^n，不可重试类一次即终。
        成功返回 {res, attempts, tries}；全部失败抛 LlmCallFailed，把逐次尝试明细带给 trace。"""
        tries: List[dict] = []
        attempt = 0
        while True:
            try:
                return {"res": self.llm.chat(messages), "attempts": attempt + 1, "tries": tries}
            except Exception as e:  # noqa: BLE001 —— 任何抛出物都先分类再决定重不重试
                error_class = classify_llm_error(e)
                again = is_retryable(error_class) and attempt < self.llm_retries
                wait_ms = BACKOFF_BASE_MS * (2 ** attempt) if again else 0
                tries.append({"n": attempt + 1, "errorClass": error_class, "waitMs": wait_ms})
                if not again:
                    raise LlmCallFailed(describe_llm_error(e, error_class), tries)
                self.sleep(wait_ms)
                attempt += 1

    def run(self, user_id: str, session_id: str, input: str) -> Dict[str, Any]:
        started_at = time.monotonic()
        started_at_iso = iso_now()
        session = self.sessions.get(user_id, session_id)
        session["turns"] += 1
        turn = session["turns"]
        trace_id = f"{user_id}/{session_id}/{turn}"
        steps: List[dict] = []
        machine, protocol, mode, ctx_opts = self.machine, turn_runner_protocol, self.mode, self.context

        st = {"state": machine.initial, "facts": protocol.initial_facts(self.max_tool_steps), "seq": 0, "pending_effects": [], "result": None}

        # 新一轮开始前先看要不要压缩——压的是历史，不碰本轮
        if needs_compaction(session, ctx_opts):
            st["pending_effects"].append({"kind": "compact", **compact_session(session, self.llm, ctx_opts)})

        memory_block = render_memory(self.memory.entries(user_id), ctx_opts.memory_max_chars)
        if memory_block.get("truncated"):
            st["pending_effects"].append({"kind": "memory_truncated", **memory_block["truncated"], "limit": ctx_opts.memory_max_chars})
        system_prompt = build_system_prompt(self.tools.specs(), memory_block["block"], mode)
        working: List[ChatMessage] = [{"role": "user", "content": input}]
        tool_ctx = {"sessionState": session["state"], "userId": user_id, "sessionId": session_id, "turn": turn}
        pending_calls: List[dict] = []

        def max_steps_answer() -> str:
            last_tools = "\n".join(f"{m.get('name')}: {preview(m['content'], 200)}" for m in [m for m in working if m["role"] == "tool"][-3:])
            return f"已达到单轮工具调用上限（{self.max_tool_steps} 次），先把目前拿到的结果给你：\n{last_tools}"

        def transition(event: str, effects: List[dict], apply: Optional[Callable[[], None]] = None, on_blocked: Optional[Callable[[], None]] = None, final: Optional[str] = None, error: Optional[str] = None):
            """闸：先解释——allowed 才执行 apply 里的副作用；blocked（rejected 行）只跑 on_blocked（回喂消息，状态不变）；
            noop 什么都不跑；落到终态就在同一条记录里收尾（写历史、存盘、answer 副作用）。
            unknown：不执行任何副作用，记 trace，本轮强制 error 终态（或按配置抛出）。"""
            st["facts"] = protocol.advance(st["facts"], event)
            state = st["state"]
            t = interpret(machine, state, event, st["facts"])
            if t.status == "allowed" and apply:
                apply()
            if t.status == "blocked" and on_blocked:
                on_blocked()
            to = "error" if t.status == "unknown" else t.to
            all_effects = [*st["pending_effects"], *effects]
            st["pending_effects"] = []
            if machine.is_terminal(to):
                stopped_by = TERMINAL_STOPPED_BY[to]
                if t.status == "unknown":
                    answer = f"运行时遇到未建模的状态转移：{state} + {event}（{t.reason}）"
                elif to == "done":
                    answer = final if final is not None else ""
                elif to == "max_steps":
                    answer = max_steps_answer()
                else:
                    answer = error if error is not None else "未知错误"
                # 原生模式的历史里不出现标签：模型没被教过 <final>，回放时也不该看到
                working.append({"role": "assistant", "content": answer if mode == NATIVE else f"<final>{answer}</final>"})
                finished = strip_think(working)
                session["history"].extend(finished)
                self.sessions.save(session)
                # 转写与写进 history 的是同一批消息：user 的 ts = 轮开始，其余 = 轮结束
                ended_at = iso_now()
                self.transcripts.append([
                    {"ts": started_at_iso if m["role"] == "user" else ended_at, "userId": user_id, "sessionId": session_id, "turn": turn, "traceId": trace_id, "role": m["role"], "content": m["content"], **({"name": m["name"]} if m.get("name") is not None else {})}
                    for m in finished
                ])
                all_effects.append({"kind": "answer", "stoppedBy": stopped_by, "answer": answer, "totalMs": int((time.monotonic() - started_at) * 1000)})
                st["result"] = {"answer": answer, "steps": steps, "stoppedBy": stopped_by, "turn": turn, "traceId": trace_id}
            st["seq"] += 1
            self.trace.write({
                "ts": iso_now(), "trace_id": trace_id, "feature": machine.feature, "userId": user_id, "sessionId": session_id, "turn": turn, "seq": st["seq"], "step": st["facts"].step,
                "from": state, "to": to, "event": event, "status": t.status, "reason": t.reason, "reject_code": t.reject_code, "transition": t.row.id if t.row else None, "effects": all_effects,
            })
            if t.status == "unknown" and self.unknown_transition == "throw":
                raise RuntimeError(f"未建模的状态转移：{state} + {event}（{t.reason}）")
            st["state"] = to
            return t

        while not machine.is_terminal(st["state"]):
            if st["state"] == "deciding":
                messages = assemble_messages(system_prompt, session, working)
                t0 = time.monotonic()
                step = st["facts"].step + 1
                request_id = new_request_id()
                try:
                    called = self._call_llm(messages)
                except LlmCallFailed as failed:
                    transition("LLM_FAILED", [{"kind": "llm", "request_id": request_id, "step": step, "model": self.llm.model, "mode": mode, "messages": len(messages), "attempts": len(failed.tries), "tries": failed.tries, "durationMs": int((time.monotonic() - t0) * 1000), "outputPreview": "", "error": failed.message}], error=f"模型调用失败：{failed.message}")
                    continue
                res = called["res"]
                text = res.get("text", "")
                native_calls = res.get("nativeToolCalls") or []
                # 原生调用没有文本形态，预览里把它们按 name + 原始 arguments 列出，让 trace 与 steps 看得见模型做了什么
                shown = " ".join(x for x in [text, *(f"[tool_call {c['name']} {c['arguments']}]" for c in native_calls)] if x) if native_calls else text
                usage = res.get("usage") or {}
                transition("LLM_OK", [{"kind": "llm", "request_id": request_id, "step": step, "model": self.llm.model, "mode": mode, "messages": len(messages), "attempts": called["attempts"], "tries": called["tries"], "promptTokens": usage.get("promptTokens"), "completionTokens": usage.get("completionTokens"), "durationMs": int((time.monotonic() - t0) * 1000), "outputPreview": preview(shown)}])
                if st["state"] != "deciding":
                    continue
                steps.append({"kind": "llm", "detail": preview(shown)})

                # 原生模式：厂商给了 tool_calls 就直接转成统一的 ParsedOutput；没给（纯文本回答，或模型把调用写成了文本）仍走同一个解析器
                if native_calls:
                    conv = _from_native_tool_calls(native_calls)
                    parsed, runtime_calls = conv["parsed"], conv["runtime_calls"]
                else:
                    parsed, runtime_calls = parse_assistant_output(text), None
                parse_effect = {"kind": "parse", "step": step, "toolCalls": len(parsed["toolCalls"]), "hasFinal": "final" in parsed, "errors": parsed["errors"], "warnings": parsed["warnings"]}
                if not parsed["toolCalls"]:
                    if "final" in parsed:
                        transition("PARSED_FINAL", [parse_effect], final=parsed["final"])
                    else:
                        # 没有工具调用也没有 final：只能是解析错误。表里这是 rejected 行 → blocked，回喂放在 on_blocked 里；
                        # 步数用尽时命中的是无守卫兜底行（allowed → max_steps），不回喂
                        def on_blocked(text: str = text, step: int = step, parsed: dict = parsed) -> None:
                            working.append({"role": "assistant", "content": text})
                            working.append({"role": "tool", "name": "parser", "toolCallId": f"parse-{step}", "content": f"你的上一条输出无法解析：{'；'.join(parsed['errors'])}。请按协议重新输出。"})

                        transition("PARSED_ERROR", [parse_effect], on_blocked=on_blocked)
                    continue

                def apply(text: str = text, step: int = step, parsed: dict = parsed, runtime_calls: Any = runtime_calls) -> None:
                    nonlocal pending_calls
                    # 本轮 assistant 消息保留 think，让模型在同一轮里能看见自己的推理；轮次结束时再剥
                    # 原生模式：assistant 消息带上被接受的 tool_calls（坏 JSON 的那些不带，避免厂商要求每个 id 都有 tool 回复）
                    accepted = [c["ref"] for c in (runtime_calls or []) if c.get("ref")]
                    working.append({"role": "assistant", "content": text, **({"toolCalls": accepted} if accepted else {})})
                    if parsed["errors"]:
                        working.append({"role": "tool", "name": "parser", "toolCallId": f"parse-{step}", "content": "；".join(parsed["errors"])})
                    pending_calls = runtime_calls if runtime_calls is not None else parsed["toolCalls"]

                transition("PARSED_TOOL_CALLS", [parse_effect], apply=apply)
                continue

            if st["state"] == "executing_tools":
                # 工具只在这个状态里跑；进到这里的唯一通道是 allowed 的 PARSED_TOOL_CALLS（P0 不变量 ①）
                effects: List[dict] = []
                for i, call in enumerate(pending_calls):
                    request_id = new_request_id()
                    r = self.tools.invoke(call["name"], call["arguments"], tool_ctx)
                    content = r["content"] if r["ok"] else f"[error] {r['content']}"
                    # 原生模式用厂商给的 tool_call id 对齐（回放时 role=tool + tool_call_id），文本模式用 runtime 自己的 step-index
                    ref = call.get("ref")
                    working.append({"role": "tool", "name": call["name"], "toolCallId": ref["id"] if ref else f"{st['facts'].step}-{i}", "content": content})
                    steps.append({"kind": "tool", "detail": f"{call['name']} {'ok' if r['ok'] else 'fail'}"})
                    effects.append({"kind": "tool", "request_id": request_id, "step": st["facts"].step, "name": call["name"], "args": self.tools.redact(call["name"], call["arguments"]), "ok": r["ok"], "durationMs": r["durationMs"], "resultPreview": preview(r["content"])})
                pending_calls = []
                transition("TOOLS_DONE", effects)
                continue

            # 不该到这里：状态集合就这五个。走闸让它以 unknown 被记录下来。
            transition("LLM_FAILED", [], error=f"runtime 处于未知状态 {st['state']}")

        assert st["result"] is not None
        return st["result"]


def create_agent(**kw: Any) -> Agent:
    return Agent(**kw)
