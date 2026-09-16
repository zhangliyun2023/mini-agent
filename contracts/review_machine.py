"""④ 复盘（review）状态表——#19 R7。这张表就是 run_review 的控制流（闸）：
每一步先 interpret，一次 interpret 一行写到 trace/reviews/<user>-<date>.jsonl（trace_id = review/<user>/<date>）；
allowed 才往下走，noop 停留，未列 (状态, 事件) = unknown → 不执行后续副作用，以 failed_partial 收尾。

事件按 run.py 的步骤命名：事件 = 上一步的结果报告，effects 挂在报告它的那条转移上（与 turn 表同法）：
  START        同键没有 journal，开始取数
  REPLAYED     同键已有 journal：不重跑，只把 attempts + 1 存回，直接落到原终态（③ 幂等）
  COLLECTED    取数完成，带 coverage 三态（⑥）
  CONSOLIDATED 整合完成、条目已按 R3 规则写回记忆
  PRESENTED    呈现门槛完成（brief 可为 null）；noop，停留在 presenting 等交付
  DELIVERED    交付（若 deliver_to 给了且 brief 非空）+ journal 落盘
终态 ↔ journal.status 一一对应（TERMINAL_STATUS）：delivered = ok，skipped_no_chat = no_chat，failed_partial = partial_read。
"""
from dataclasses import dataclass
from typing import Optional

from mini_agent.machine.interpreter import Invariant, define_machine, row


@dataclass(frozen=True)
class ReviewFacts:
    """facts 只有 runner 自己知道的三个量：同键已有 journal 的状态、本次 coverage、可读且区间内有行的会话数"""

    existing: Optional[str]
    coverage: Optional[str]
    readable: int


REVIEW_STATES = ["scheduled", "collecting", "consolidating", "presenting", "delivered", "skipped_no_chat", "failed_partial"]
REVIEW_TERMINAL = ["delivered", "skipped_no_chat", "failed_partial"]
REVIEW_EVENTS = ["START", "REPLAYED", "COLLECTED", "CONSOLIDATED", "PRESENTED", "DELIVERED"]

# 终态 ↔ journal.status 的一一对应（不变量 terminal_matches_journal_status 的依据）
TERMINAL_STATUS = {"delivered": "ok", "skipped_no_chat": "no_chat", "failed_partial": "partial_read"}

RUN = "tests/unit/test_review_run.py"
T_OK = f"{RUN}::test_full_ok_entries_written_and_brief"
T_CONFLICT = f"{RUN}::test_same_key_different_value_marks_conflict"
T_REPLAY = f"{RUN}::test_same_date_twice_is_idempotent"
T_NO_CHAT = f"{RUN}::test_no_chat_status"
T_PARTIAL = f"{RUN}::test_partial_read_with_bad_line"
T_UNREADABLE = f"{RUN}::test_only_bad_transcript_is_partial_read"
T_DELIVER = f"{RUN}::test_recipient_only_from_opts"
T_ANSWER_KEY = f"{RUN}::test_trace_sequence_equals_answer_key"

# effects 声明 = 该行命中时 runtime 会往这条转移记录上挂的副作用种类（上界；不变量 effects_declared 按行 id 对账）：
#   collect      取数（读转写）：挂在 COLLECTED 上
#   consolidate  整合（模型或规则）：挂在 CONSOLIDATED 上
#   memory       条目写回记忆（R3 upsert）：挂在 CONSOLIDATED 上
#   present      呈现门槛：挂在 PRESENTED 上
#   deliver      往目标会话追加 review_brief：挂在 DELIVERED 上（deliver_to 给了且 brief 非空才有）
#   journal      journal 落盘：落终态的行都带（含重跑的 attempts + 1）

review_machine = define_machine(
    feature="review",
    anchor="docs/SPEC.md#复盘 → 昨日记忆整合（#19）",
    initial="scheduled",
    states=REVIEW_STATES,
    terminal=REVIEW_TERMINAL,
    events=REVIEW_EVENTS,
    guards={
        "replayOk": lambda f: f.existing == "ok",
        "replayNoChat": lambda f: f.existing == "no_chat",
        "coverageNone": lambda f: f.coverage == "none",
        "nothingReadable": lambda f: f.readable == 0,
        "coveragePartial": lambda f: f.coverage == "partial",
    },
    rows=[
        row("rv-start", "scheduled", "START", "collecting", "allowed", priority="P0", reason="同键没有 journal：开始取昨天的转写", effects=[], covered_by=[T_OK]),
        row("rv-replay-ok", "scheduled", "REPLAYED", "delivered", "allowed", guard="replayOk", priority="P0",
            reason="同键已有 ok 的 journal：不重跑整合、不重写记忆、不重发，只把 attempts + 1 存回，直接落原终态", effects=["journal"], covered_by=[T_REPLAY]),
        row("rv-replay-no-chat", "scheduled", "REPLAYED", "skipped_no_chat", "allowed", guard="replayNoChat", priority="P0",
            reason="同键已有 no_chat 的 journal：只记一次尝试，落原终态", effects=["journal"], covered_by=[T_ANSWER_KEY]),
        row("rv-replay-partial", "scheduled", "REPLAYED", "failed_partial", "allowed", priority="P0",
            reason="其余即 partial_read 的 journal：只记一次尝试，落原终态（partial 不自动补跑，见 R6 报告「没做」）", effects=["journal"], covered_by=[T_ANSWER_KEY]),
        row("rv-collected-none", "collecting", "COLLECTED", "skipped_no_chat", "allowed", guard="coverageNone", priority="P0",
            reason="昨天一个会话都没有且没有读失败：不调整合器、不写记忆、不交付，journal 记 no_chat", effects=["collect", "journal"], covered_by=[T_NO_CHAT]),
        row("rv-collected-unreadable", "collecting", "COLLECTED", "failed_partial", "allowed", guard="nothingReadable", priority="P0",
            reason="有读失败但一个可读会话都没有：没有材料可整合，journal 记 partial_read 并写明 unreadable（不冒充 no_chat）", effects=["collect", "journal"], covered_by=[T_UNREADABLE]),
        row("rv-collected-partial", "collecting", "COLLECTED", "consolidating", "allowed", guard="coveragePartial", priority="P0",
            reason="部分会话读不出但有可读材料：照常整合，journal 最终记 partial_read 并写明 unreadable", effects=["collect"], covered_by=[T_PARTIAL]),
        row("rv-collected-full", "collecting", "COLLECTED", "consolidating", "allowed", priority="P0",
            reason="其余即 full：有区间内的行且全部读得出，进入整合", effects=["collect"], covered_by=[T_OK]),
        row("rv-consolidated", "consolidating", "CONSOLIDATED", "presenting", "allowed", priority="P0",
            reason="整合结果的条目已按 R3 规则逐条 upsert（同 key 异值走 conflict，不覆盖），进入呈现门槛", effects=["consolidate", "memory"], covered_by=[T_OK, T_CONFLICT]),
        row("rv-presented", "presenting", "PRESENTED", "presenting", "noop", priority="P0",
            reason="呈现门槛跑完（why_today + source 必备、不复述原话；空则 brief null），状态不变，等交付", effects=["present"], covered_by=[T_OK]),
        row("rv-delivered-partial", "presenting", "DELIVERED", "failed_partial", "allowed", guard="coveragePartial", priority="P0",
            reason="交付完成但本次 coverage 是 partial：journal 记 partial_read（brief / entries 照常保留）", effects=["deliver", "journal"], covered_by=[T_PARTIAL]),
        row("rv-delivered", "presenting", "DELIVERED", "delivered", "allowed", priority="P0",
            reason="其余即 full：交付完成，journal 记 ok；接收人只由 opts.deliver_to 决定（⑪）", effects=["deliver", "journal"], covered_by=[T_OK, T_DELIVER]),
    ],
    invariants=[
        Invariant("idempotent", "幂等：同键（userId + date）跑 N 次，盘上 journal 恰一份、attempts == N、记忆条目数与第一次之后相同", "P0", "enforced",
                  evidence=["mini_agent/review/invariants.py::idempotent", "tests/unit/test_review_invariants.py::test_inv1_idempotent"]),
        Invariant("no_overwrite_on_conflict", "同 key 异值不覆盖：复盘前 active 的每条 (key, value) 复盘后仍 active；同 key 的新值只能以 conflict 存在且 conflictWith 指向旧值", "P0", "enforced",
                  evidence=["mini_agent/review/invariants.py::no_overwrite_on_conflict", "tests/unit/test_review_invariants.py::test_inv2_no_overwrite_on_conflict"]),
        Invariant("every_highlight_has_source", "每条亮点的 source 都指向昨天转写里真实存在的 (sessionId, turn)", "P0", "enforced",
                  evidence=["mini_agent/review/invariants.py::every_highlight_has_source", "tests/unit/test_review_invariants.py::test_inv3_every_highlight_has_source"]),
        Invariant("brief_not_verbatim", "brief 不复述原话：任何亮点文本都不与昨天某行去空白后相等，也不是该行 ≥ 20 字的连续子串", "P0", "enforced",
                  evidence=["mini_agent/review/invariants.py::brief_not_verbatim", "tests/unit/test_review_invariants.py::test_inv4_brief_not_verbatim"]),
        Invariant("unknown_never_silent", "未列 (状态, 事件) 在运行时被拦下：不执行后续副作用、记一条 status=unknown 的 trace、以 failed_partial 收尾（journal 写明未建模转移；throw 模式抛出）", "P0", "enforced",
                  evidence=["mini_agent/review/run.py::unknown_transition", "tests/unit/test_review_machine.py::test_gate_without_collected"]),
        Invariant("terminal_matches_journal_status", "终态 ↔ journal.status 一一对应：delivered = ok、skipped_no_chat = no_chat、failed_partial = partial_read；trace 末条落终态且恰一条", "P0", "enforced",
                  evidence=["contracts/review_machine.py::TERMINAL_STATUS", "mini_agent/review/run.py::TERMINAL_STATUS", "tests/unit/test_review_run.py::test_trace_sequence_equals_answer_key"]),
        Invariant("recipient_only_from_opts", "⑪ 接收人只由 opts.deliver_to 决定：整合结果与转写里的「发给 B」不参与任何决定", "P1", "planned",
                  note="run.py 不读整合结果里的任何接收人字段（Consolidation 里也没有），暂无独立 oracle；靠 test_review_run ⑪ 那条（B 的会话没被创建）观察"),
    ],
)
