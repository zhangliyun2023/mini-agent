"""① 轮循环（turn）状态表——这张表就是 loop 的控制流（docs/product/SPEC-state-machines.md §3）。
runtime 每一步先 interpret：allowed 才执行副作用，rejected 行命中 = blocked（只回喂、状态不变），noop 不跑；未列组合 = unknown → 本轮 error 终态。
"""
from dataclasses import dataclass, replace
from typing import List, Optional

from mini_agent.machine.interpreter import Invariant, define_machine, row

TURN_STATES = ["deciding", "executing_tools", "done", "max_steps", "error"]
TURN_TERMINAL = ["done", "max_steps", "error"]
TURN_EVENTS = ["LLM_OK", "LLM_FAILED", "PARSED_TOOL_CALLS", "PARSED_FINAL", "PARSED_ERROR", "TOOLS_DONE"]

# 终态 ↔ RunResult.stoppedBy 的一一对应（P0 不变量 ③ 的依据）
TERMINAL_STOPPED_BY = {"done": "final", "max_steps": "max_steps", "error": "error"}


@dataclass(frozen=True)
class TurnFacts:
    """facts 只有机器自己维护的两个数：本轮已发出的模型调用次数、上限"""

    step: int
    max_steps: int


LOOP = "tests/unit/test_agent_loop.py"

# effects 声明 = 该行命中时 runtime 会往这条转移记录上挂的副作用种类（不变量 ⑤ effects_declared 按行 id 对账）：
#   llm     模型调用，挂在 LLM_OK / LLM_FAILED 上
#   compact 轮首压缩：发生在本轮第一次模型调用之前，没有独立事件，挂在本轮第一条转移（LLM_OK / LLM_FAILED）上；只有轮首那条会带
#   parse   输出解析，挂在 PARSED_* 上
#   tool    工具执行，只挂在 TOOLS_DONE 上
#   answer  终态收尾，落终态的行都带
# 声明是上界：记录上出现的种类 ⊆ 声明；表没声明的种类 = unmodeled，oracle 点名。

turn_machine = define_machine(
    feature="turn",
    anchor="docs/SPEC.md#实现决策 → 循环",
    initial="deciding",
    states=TURN_STATES,
    terminal=TURN_TERMINAL,
    events=TURN_EVENTS,
    guards={"hasStepsLeft": lambda f: f.step < f.max_steps},
    rows=[
        row("t-llm-ok", "deciding", "LLM_OK", "deciding", "noop", priority="P0",
            reason="模型返回了文本，状态不变，进入解析", effects=["compact", "llm"],
            covered_by=[f"{LOOP}::test_direct_reply_calls_llm_once"]),
        row("t-llm-failed", "deciding", "LLM_FAILED", "error", "allowed", priority="P0",
            reason="重试用尽仍失败，以可读错误结束本轮", effects=["compact", "llm", "answer"],
            covered_by=[f"{LOOP}::test_llm_exception_returns_readable_error"]),
        row("t-final", "deciding", "PARSED_FINAL", "done", "allowed", priority="P0",
            reason="无工具调用且有 final：本轮结束", effects=["parse", "answer"],
            covered_by=[f"{LOOP}::test_direct_reply_calls_llm_once"]),
        row("t-tools", "deciding", "PARSED_TOOL_CALLS", "executing_tools", "allowed", priority="P0",
            reason="解析出工具调用，进入执行；工具只在 executing_tools 里跑", effects=["parse"],
            covered_by=[f"{LOOP}::test_tool_result_fed_back_then_final"]),
        row("t-parse-error", "deciding", "PARSED_ERROR", "deciding", "rejected", reject_code="PARSE_ERROR", guard="hasStepsLeft", priority="P0",
            reason="解析失败且还有步数：本步被拦下（blocked），把错误当 tool 消息回喂让模型重来；不执行任何工具", effects=["parse"],
            covered_by=[f"{LOOP}::test_bad_json_fed_back_as_tool_message"]),
        row("t-parse-error-cap", "deciding", "PARSED_ERROR", "max_steps", "allowed", priority="P0",
            reason="解析失败且步数用尽：交还已有结果", effects=["parse", "answer"],
            covered_by=[f"{LOOP}::test_unparseable_until_cap_ends_max_steps"]),
        row("t-tools-done", "executing_tools", "TOOLS_DONE", "deciding", "allowed", guard="hasStepsLeft", priority="P0",
            reason="工具结果已回填，还有步数：回到模型决策", effects=["tool"],
            covered_by=[f"{LOOP}::test_tool_result_fed_back_then_final"]),
        row("t-tools-done-cap", "executing_tools", "TOOLS_DONE", "max_steps", "allowed", priority="P0",
            reason="工具结果已回填但步数用尽：以「已达上限 + 最近三条工具结果」结束。上限在工具跑完后才拦（拍板②）：把结果交还用户比省一次工具调用更有价值", effects=["tool", "answer"],
            covered_by=[f"{LOOP}::test_tools_until_cap_returns_partial"]),
    ],
    invariants=[
        Invariant("no_tool_after_parse_error", "无工具执行于解析失败之后：tool 副作用只出现在 executing_tools 发出的 TOOLS_DONE 转移上，且其前一条必是 allowed 的 PARSED_TOOL_CALLS", "P0", "enforced",
                  evidence=["mini_agent/machine/invariants.py::no_tool_after_parse_error", "tests/unit/test_invariants.py::test_inv1_no_tool_after_parse_error"]),
        Invariant("exactly_one_final_answer", "一轮恰一个最终答案：trace 里恰一条终态转移且是末条、恰一个 answer 副作用；历史里本轮恰追加一条 <final>", "P0", "enforced",
                  evidence=["mini_agent/machine/invariants.py::exactly_one_final_answer", "tests/unit/test_invariants.py::test_inv2_exactly_one_final_answer"]),
        Invariant("terminal_states_distinct", "三终态互斥可区分：done/max_steps/error 与 stoppedBy final/max_steps/error 一一对应，一轮只落一个终态", "P0", "enforced",
                  evidence=["mini_agent/machine/invariants.py::terminal_states_distinct", "tests/unit/test_invariants.py::test_inv3_terminal_states_distinct"]),
        Invariant("answer_alignment", "答案 == 盘上历史末条 == trace 末次决策：RunResult.answer、session.history 末条 <final>、trace 末条 answer 副作用三处一致", "P0", "enforced",
                  evidence=["mini_agent/machine/invariants.py::answer_aligned", "tests/unit/test_invariants.py::test_inv4_answer_alignment"]),
        Invariant("effects_declared", "副作用对账：每条转移记录上出现的 effects[].kind ⊆ 记录 transition 行 id 命中行声明的 effects；compact 只在轮首第一条转移上；表没声明的副作用即 unmodeled，不得静默", "P0", "enforced",
                  evidence=["mini_agent/machine/invariants.py::effects_declared", "tests/unit/test_invariants.py::test_inv5_effects_declared"]),
        Invariant("unknown_never_silent", "未列 (状态, 事件) 在运行时被拦下：不执行副作用、记 trace、本轮 error 终态（测试模式直接失败）", "P0", "enforced",
                  evidence=["mini_agent/runtime/agent.py::unknown_transition", "tests/unit/test_agent_loop.py::test_unlisted_transition_blocked_at_runtime"]),
        Invariant("api_key_never_in_trace", "API key 不进 trace：trace 只写模型名、耗时、token、预览，不写配置", "P1", "planned",
                  note="还没有「把可辨认的假 key 放进配置跑一轮再 grep 产物」的自动测试；现在靠 test_invariants ④ 里的弱断言（trace 文件不含 api_key|OPENAI）+ CLI 冒烟手工看"),
        Invariant("compaction_cut_on_user", "压缩切点对齐到 user 消息，不把一轮 tool_call/tool 从中间切断", "P1", "planned",
                  note="compact_session 按条数切，尚未按轮边界对齐；等 session 表接代码时一起做（NEXT_STEPS 3）"),
    ],
)


class TurnRunnerProtocol:
    """runner 协议：表说「哪些转移被允许」，这里说「runtime 在哪个状态会发出哪些事件、facts 怎么推进」。
    agent 运行时与路径生成器共用同一份，保证生成的答案卷与真实 runtime 是同一套规则。"""

    @staticmethod
    def initial_facts(max_steps: int = 8) -> TurnFacts:
        return TurnFacts(step=0, max_steps=max_steps)

    @staticmethod
    def advance(facts: TurnFacts, event: str) -> TurnFacts:
        """每次向模型发起调用（成功或失败）算一步"""
        return replace(facts, step=facts.step + 1) if event in ("LLM_OK", "LLM_FAILED") else facts

    @staticmethod
    def next(state: str, last: Optional[str]) -> List[str]:
        """在某状态、上一事件之后，runtime 可能发出的事件（生成器的分支点）"""
        if state == "deciding":
            return ["PARSED_FINAL", "PARSED_TOOL_CALLS", "PARSED_ERROR"] if last == "LLM_OK" else ["LLM_OK", "LLM_FAILED"]
        if state == "executing_tools":
            return ["TOOLS_DONE"]
        return []


turn_runner_protocol = TurnRunnerProtocol()
