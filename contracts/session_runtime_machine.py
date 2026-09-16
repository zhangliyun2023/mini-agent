"""③ 会话并发（idle / busy / queued / executing）：诚实建模而不实现（docs/product/SPEC-state-machines.md §2 D6）。
busy 状态下收到新输入的行为仍标 kind:'unknown'——契约 JSON 里能一眼看到没做。
#19 ⑦（Q4）：复盘触发（ASYNC_DONE）时用户正在聊 → 排队到本轮结束后执行，不打断；空闲 → 立即执行。
这两格只改表、不接运行时：单进程 CLI 串行读 stdin，ASYNC_DONE 在运行时不可达；covered_by 指向解释器级测试。
"""
from mini_agent.machine.interpreter import Invariant, define_machine, row

CONTRACTS = "tests/unit/test_contracts.py"
Q4 = f"{CONTRACTS}::test_session_runtime_q4_three_cells_allowed"
NOT_WIRED = "单进程 CLI 不可达，表已建模、运行时不接"

session_runtime_machine = define_machine(
    feature="session-runtime",
    anchor="docs/SPEC.md#out-of-scope → HTTP 服务与并发 busy 状态处理",
    initial="idle",
    states=["idle", "busy", "queued", "executing"],
    terminal=[],
    events=["INPUT", "TURN_DONE", "ASYNC_DONE", "REVIEW_DONE"],
    rows=[
        row("sr-input", "idle", "INPUT", "busy", "allowed", priority="P1", reason="开始一轮"),
        row("sr-turn-done-idle", "idle", "TURN_DONE", "idle", "noop", priority="P1", reason="没有进行中的轮，忽略"),
        row("sr-turn-done", "busy", "TURN_DONE", "idle", "allowed", priority="P1", reason="本轮结束（任一终态）"),
        row("sr-input-while-busy", "busy", "INPUT", "busy", "unknown", priority="P1", reason="忙时来新输入：排队 / 拒绝 / 打断 均未决定，不实现"),
        row("sr-async-while-busy", "busy", "ASYNC_DONE", "queued", "allowed", priority="P1", reason=f"#19 ⑦：复盘触发时用户正在聊 → 排队到本轮结束后执行，不打断本轮（{NOT_WIRED}）", covered_by=[Q4]),
        row("sr-async-idle", "idle", "ASYNC_DONE", "executing", "allowed", priority="P1", reason=f"#19 ⑦：空闲时复盘触发 → 立即执行（{NOT_WIRED}）", covered_by=[Q4]),
        row("sr-queued-turn-done", "queued", "TURN_DONE", "executing", "allowed", priority="P1", reason=f"#19 ⑦：本轮结束，执行排队的复盘（{NOT_WIRED}）", covered_by=[Q4]),
        row("sr-queued-async", "queued", "ASYNC_DONE", "queued", "noop", priority="P1", reason="已有排队的复盘：合并，不排第二个"),
        row("sr-queued-input", "queued", "INPUT", "queued", "unknown", priority="P1", reason="排队中来新输入：与 busy + INPUT 同样未决定"),
        row("sr-executing-done", "executing", "REVIEW_DONE", "idle", "allowed", priority="P1", reason="复盘执行完（任一终态）回到空闲"),
        row("sr-executing-input", "executing", "INPUT", "executing", "unknown", priority="P1", reason="复盘执行中来新输入：排队 / 拒绝 均未决定"),
        row("sr-executing-async", "executing", "ASYNC_DONE", "executing", "unknown", priority="P1", reason="复盘执行中再触发：合并 / 排队 未决定"),
    ],
    invariants=[
        Invariant("no_concurrent_turns_per_session", "同一会话同一时刻至多一轮在跑，复盘不打断进行中的轮", "P1", "planned",
                  note="单进程 CLI 串行读 stdin，天然成立；#19 ⑦ 的 busy / idle + ASYNC_DONE 与 queued + TURN_DONE 三格已在表里建模（queued / executing），但单进程 CLI 不可达、运行时不接；多进程 / HTTP 服务时需要锁（NEXT_STEPS 4、10）"),
    ],
)
