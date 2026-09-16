"""context 管理的三条规则：
1. 进 context 的是：system、（压缩摘要）、历史用户输入、历史工具调用 + 精简后的工具结果、历史最终答案、本轮全部消息。
2. 历史轮的 <think> 在轮次结束时剥掉——思考过程只对当轮有用，留着只会占位。
3. 超阈值时把最老的部分压成一条摘要，最近几轮保留原文，保证追问仍然有上下文可接。
"""
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from ..llm.types import ChatMessage


@dataclass
class ContextOptions:
    # history 里最多保留多少条消息，超过触发压缩
    max_history_messages: int = 40
    # history 总字符数上限（粗略代替 token 数），超过触发压缩
    max_history_chars: int = 12_000
    # 压缩时保留最近多少条消息原文
    keep_recent_messages: int = 12
    # system prompt 里记忆块的字符上限（与 max_history_chars 同一把尺子）。超限按写入顺序保留最新的条目，截断事实记 trace。
    # 选字符数而不是条目数：预算单位本来就是字符，几条长 value 就能撑爆条目数上限却仍「合规」；字符上限直接约束的就是占用。
    # 默认 = max_history_chars 的 10%。
    memory_max_chars: int = 1_200


DEFAULT_CONTEXT = ContextOptions()
THINK_BLOCK = re.compile(r"<think>.*?</think>\s*", re.S)
_SENTENCE_END = re.compile(r"[。\n]")


def strip_think(messages: List[ChatMessage]) -> List[ChatMessage]:
    """轮次结束后调用：剥掉 assistant 消息里的思考过程"""
    return [{**m, "content": THINK_BLOCK.sub("", m["content"]).strip()} if m["role"] == "assistant" else m for m in messages]


def needs_compaction(session: dict, opts: ContextOptions) -> bool:
    chars = sum(len(m["content"]) for m in session["history"])
    return len(session["history"]) > opts.max_history_messages or chars > opts.max_history_chars


def compact_session(session: dict, llm: Any, opts: ContextOptions) -> Dict[str, Any]:
    """把 history 的老部分压成摘要，追加到 session["summary"]；最近 keep_recent_messages 条保留。
    切点会对齐到 user 消息，避免把一轮 tool_call/tool 对话从中间切断。返回 {before, after, method}。"""
    history = session["history"]
    before = len(history)
    cut = max(0, before - opts.keep_recent_messages)
    while 0 < cut < before and history[cut]["role"] != "user":
        cut -= 1
    old = history[:cut]
    if not old:
        return {"before": before, "after": before, "method": "rule"}
    try:
        summary = _summarize_with_llm(old, llm, session.get("summary"))
        method = "llm"
    except Exception:  # noqa: BLE001 —— 摘要接口挂了就退回规则压缩
        summary = summarize_by_rule(old, session.get("summary"))
        method = "rule"
    session["summary"] = summary
    session["history"] = history[cut:]
    return {"before": before, "after": len(session["history"]), "method": method}


def _summarize_with_llm(old: List[ChatMessage], llm: Any, prev: Optional[str]) -> str:
    transcript = "\n".join(f"[{m['role']}{':' + m['name'] if m.get('name') else ''}] {_render_content(m)}" for m in old)
    res = llm.chat([
        {"role": "system", "content": "你是对话压缩器。把下面的对话压成一段要点式摘要，只保留：用户提过的目标与约束、已经查到/算出的关键结果、未完成的事项、用户偏好。不要评论，不要加标签，200 字以内。"},
        {"role": "user", "content": (f"此前摘要：\n{prev}\n\n新增对话：\n" if prev else "") + transcript},
    ])
    text = re.sub(r"</?final>", "", THINK_BLOCK.sub("", res["text"])).strip()
    if not text:
        raise ValueError("空摘要")
    return text


def _render_content(m: ChatMessage) -> str:
    """原生模式的 assistant 消息把调用放在 toolCalls 里而不是 content 的标签里；转写时补上，摘要器才知道做过什么"""
    calls = "；".join(f"调用 {c['name']}({c['arguments']})" for c in (m.get("toolCalls") or []))
    return " ".join(x for x in [m["content"], calls] if x)


def _is_tool_call_message(m: ChatMessage) -> bool:
    """这条 assistant 消息是不是在发工具调用（文本协议看标签，原生模式看 toolCalls）"""
    return m["role"] == "assistant" and ("<tool_call>" in m["content"] or bool(m.get("toolCalls")))


def summarize_by_rule(old: List[ChatMessage], prev: Optional[str] = None) -> str:
    """规则兜底：保留每条用户原话和每条最终答案的首句，丢掉工具中间过程"""
    lines: List[str] = []
    for m in old:
        if m["role"] == "user":
            lines.append(f"用户：{m['content'][:80]}")
        elif m["role"] == "assistant" and not _is_tool_call_message(m) and m["content"].strip():
            first = _SENTENCE_END.split(m["content"])[0][:80]
            lines.append(f"助手：{first}")
    return "\n".join(x for x in [prev, *lines] if x)


def assemble_messages(system_prompt: str, session: dict, working: List[ChatMessage]) -> List[ChatMessage]:
    """组装一次 LLM 调用的完整消息列表"""
    msgs: List[ChatMessage] = [{"role": "system", "content": system_prompt}]
    if session.get("summary"):
        msgs.append({"role": "system", "content": f"此前对话摘要（已压缩）：\n{session['summary']}"})
    msgs.extend(session["history"])
    msgs.extend(working)
    return msgs
