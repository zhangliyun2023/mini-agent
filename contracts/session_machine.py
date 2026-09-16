"""② 会话生命周期：只建表 + 契约 JSON，不接代码（docs/product/SPEC-state-machines.md §2 D6）。
现状：runtime 里 new/active 由 SessionStore.get 隐式处理，compacting 是 run() 开头的一段同步代码。
这张表把这些隐式状态写出来，供 NEXT_STEPS 里「接代码」时对账。
"""
from mini_agent.machine.interpreter import Invariant, define_machine, row

session_machine = define_machine(
    feature="session",
    anchor="docs/SPEC.md#实现决策 → 会话存储 / 压缩",
    initial="new",
    states=["new", "active", "compacting"],
    terminal=[],
    events=["FIRST_INPUT", "INPUT", "COMPACT_NEEDED", "COMPACT_DONE", "COMPACT_FAILED"],
    rows=[
        row("s-first-input", "new", "FIRST_INPUT", "active", "allowed", priority="P1", reason="首次输入：建会话文件、turns=1"),
        row("s-compact-on-empty", "new", "COMPACT_NEEDED", "new", "rejected", reject_code="EMPTY_HISTORY", priority="P1", reason="空会话无历史可压"),
        row("s-input", "active", "INPUT", "active", "allowed", priority="P1", reason="新一轮 turn（见 turn 表）"),
        row("s-compact-needed", "active", "COMPACT_NEEDED", "compacting", "allowed", priority="P1", reason="历史超条数/字符阈值，新一轮开始前先压"),
        row("s-compact-done-noop", "active", "COMPACT_DONE", "active", "noop", priority="P1", reason="没有进行中的压缩，忽略"),
        row("s-compact-done", "compacting", "COMPACT_DONE", "active", "allowed", priority="P1", reason="模型摘要成功，summary 累积"),
        row("s-compact-failed", "compacting", "COMPACT_FAILED", "active", "allowed", priority="P1", reason="模型摘要失败，退回规则压缩后继续"),
        row("s-input-while-compacting", "compacting", "INPUT", "compacting", "unknown", priority="P1", reason="压缩期间来新输入：单进程 CLI 不会发生，未建模"),
    ],
    invariants=[
        Invariant("compaction_never_touches_current_turn", "压缩只动历史，不碰本轮消息", "P1", "planned", note="压缩在 run() 开头、本轮 working 建立之前同步执行，结构上碰不到本轮；表接代码后再写 oracle"),
    ],
)
