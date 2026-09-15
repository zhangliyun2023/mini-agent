import { defineMachine } from "../src/machine/interpreter.js";

// ③ 会话并发（idle / busy / queued / executing）：诚实建模而不实现（docs/product/SPEC-state-machines.md §2 D6）。
// busy 状态下收到新输入的行为仍标 kind:'unknown'——契约 JSON 里能一眼看到没做。
// #19 ⑦（Q4）：复盘触发（ASYNC_DONE）时用户正在聊 → 排队到本轮结束后执行，不打断；空闲 → 立即执行。
// 这两格只改表、不接运行时：单进程 CLI 串行 for-await，ASYNC_DONE 在运行时不可达；covered_by 指向解释器级测试。

export type SessionRuntimeState = "idle" | "busy" | "queued" | "executing";
export type SessionRuntimeEvent = "INPUT" | "TURN_DONE" | "ASYNC_DONE" | "REVIEW_DONE";

const CONTRACTS = "test/unit/contracts.test.ts";
const Q4 = `${CONTRACTS}::session-runtime（#19 ⑦ Q4）：busy + ASYNC_DONE → queued、idle + ASYNC_DONE → executing、queued + TURN_DONE → executing 三格 allowed；busy + INPUT 仍 declared_unknown；运行时不接`;
const NOT_WIRED = "单进程 CLI 不可达，表已建模、运行时不接";

export const sessionRuntimeMachine = defineMachine<SessionRuntimeState, SessionRuntimeEvent, Record<string, never>>({
  feature: "session-runtime",
  anchor: "docs/SPEC.md#out-of-scope → HTTP 服务与并发 busy 状态处理",
  initial: "idle",
  states: ["idle", "busy", "queued", "executing"],
  terminal: [],
  events: ["INPUT", "TURN_DONE", "ASYNC_DONE", "REVIEW_DONE"],
  rows: [
    { id: "sr-input", from: "idle", event: "INPUT", to: "busy", kind: "allowed", priority: "P1", reason: "开始一轮" },
    { id: "sr-turn-done-idle", from: "idle", event: "TURN_DONE", to: "idle", kind: "noop", priority: "P1", reason: "没有进行中的轮，忽略" },
    { id: "sr-turn-done", from: "busy", event: "TURN_DONE", to: "idle", kind: "allowed", priority: "P1", reason: "本轮结束（任一终态）" },
    { id: "sr-input-while-busy", from: "busy", event: "INPUT", to: "busy", kind: "unknown", priority: "P1", reason: "忙时来新输入：排队 / 拒绝 / 打断 均未决定，不实现" },
    { id: "sr-async-while-busy", from: "busy", event: "ASYNC_DONE", to: "queued", kind: "allowed", priority: "P1", reason: `#19 ⑦：复盘触发时用户正在聊 → 排队到本轮结束后执行，不打断本轮（${NOT_WIRED}）`, covered_by: [Q4] },
    { id: "sr-async-idle", from: "idle", event: "ASYNC_DONE", to: "executing", kind: "allowed", priority: "P1", reason: `#19 ⑦：空闲时复盘触发 → 立即执行（${NOT_WIRED}）`, covered_by: [Q4] },
    { id: "sr-queued-turn-done", from: "queued", event: "TURN_DONE", to: "executing", kind: "allowed", priority: "P1", reason: `#19 ⑦：本轮结束，执行排队的复盘（${NOT_WIRED}）`, covered_by: [Q4] },
    { id: "sr-queued-async", from: "queued", event: "ASYNC_DONE", to: "queued", kind: "noop", priority: "P1", reason: "已有排队的复盘：合并，不排第二个" },
    { id: "sr-queued-input", from: "queued", event: "INPUT", to: "queued", kind: "unknown", priority: "P1", reason: "排队中来新输入：与 busy + INPUT 同样未决定" },
    { id: "sr-executing-done", from: "executing", event: "REVIEW_DONE", to: "idle", kind: "allowed", priority: "P1", reason: "复盘执行完（任一终态）回到空闲" },
    { id: "sr-executing-input", from: "executing", event: "INPUT", to: "executing", kind: "unknown", priority: "P1", reason: "复盘执行中来新输入：排队 / 拒绝 均未决定" },
    { id: "sr-executing-async", from: "executing", event: "ASYNC_DONE", to: "executing", kind: "unknown", priority: "P1", reason: "复盘执行中再触发：合并 / 排队 未决定" },
  ],
  invariants: [
    { id: "no_concurrent_turns_per_session", priority: "P1", status: "planned", text: "同一会话同一时刻至多一轮在跑，复盘不打断进行中的轮", note: "单进程 CLI 串行 for-await，天然成立；#19 ⑦ 的 busy / idle + ASYNC_DONE 与 queued + TURN_DONE 三格已在表里建模（queued / executing），但单进程 CLI 不可达、运行时不接；多进程 / HTTP 服务时需要锁（NEXT_STEPS 4、10）" },
  ],
});
