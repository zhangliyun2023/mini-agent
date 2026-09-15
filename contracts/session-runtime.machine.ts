import { defineMachine } from "../src/machine/interpreter.js";

// ③ 会话并发（idle / busy）：诚实建模而不实现（docs/product/SPEC-state-machines.md §2 D6）。
// busy 状态下收到新输入或异步完成的行为在表里标 kind:'unknown'——契约 JSON 里能一眼看到没做。

export type SessionRuntimeState = "idle" | "busy";
export type SessionRuntimeEvent = "INPUT" | "TURN_DONE" | "ASYNC_DONE";

export const sessionRuntimeMachine = defineMachine<SessionRuntimeState, SessionRuntimeEvent, Record<string, never>>({
  feature: "session-runtime",
  anchor: "docs/SPEC.md#out-of-scope → HTTP 服务与并发 busy 状态处理",
  initial: "idle",
  states: ["idle", "busy"],
  terminal: [],
  events: ["INPUT", "TURN_DONE", "ASYNC_DONE"],
  rows: [
    { id: "sr-input", from: "idle", event: "INPUT", to: "busy", kind: "allowed", priority: "P1", reason: "开始一轮" },
    { id: "sr-turn-done-idle", from: "idle", event: "TURN_DONE", to: "idle", kind: "noop", priority: "P1", reason: "没有进行中的轮，忽略" },
    { id: "sr-turn-done", from: "busy", event: "TURN_DONE", to: "idle", kind: "allowed", priority: "P1", reason: "本轮结束（任一终态）" },
    { id: "sr-input-while-busy", from: "busy", event: "INPUT", to: "busy", kind: "unknown", priority: "P1", reason: "忙时来新输入：排队 / 拒绝 / 打断 均未决定，不实现" },
    { id: "sr-async-while-busy", from: "busy", event: "ASYNC_DONE", to: "busy", kind: "unknown", priority: "P1", reason: "忙时异步完成（如后台压缩）：未建模" },
    { id: "sr-async-idle", from: "idle", event: "ASYNC_DONE", to: "idle", kind: "unknown", priority: "P1", reason: "空闲时异步完成：未建模" },
  ],
  invariants: [
    { id: "no_concurrent_turns_per_session", priority: "P1", status: "planned", text: "同一会话同一时刻至多一轮在跑" },
  ],
});
