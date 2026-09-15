import { defineMachine } from "../src/machine/interpreter.js";

// ② 会话生命周期：只建表 + 契约 JSON，不接代码（docs/product/SPEC-state-machines.md §2 D6）。
// 现状：runtime 里 new/active 由 SessionStore.get 隐式处理，compacting 是 run() 开头的一段同步代码。
// 这张表把这些隐式状态写出来，供 NEXT_STEPS 里「接代码」时对账。

export type SessionState = "new" | "active" | "compacting";
export type SessionEvent = "FIRST_INPUT" | "INPUT" | "COMPACT_NEEDED" | "COMPACT_DONE" | "COMPACT_FAILED";

export const sessionMachine = defineMachine<SessionState, SessionEvent, Record<string, never>>({
  feature: "session",
  anchor: "docs/SPEC.md#实现决策 → 会话存储 / 压缩",
  initial: "new",
  states: ["new", "active", "compacting"],
  terminal: [],
  events: ["FIRST_INPUT", "INPUT", "COMPACT_NEEDED", "COMPACT_DONE", "COMPACT_FAILED"],
  rows: [
    { id: "s-first-input", from: "new", event: "FIRST_INPUT", to: "active", kind: "allowed", priority: "P1", reason: "首次输入：建会话文件、turns=1" },
    { id: "s-compact-on-empty", from: "new", event: "COMPACT_NEEDED", to: "new", kind: "rejected", priority: "P1", reason: "空会话无历史可压" },
    { id: "s-input", from: "active", event: "INPUT", to: "active", kind: "allowed", priority: "P1", reason: "新一轮 turn（见 turn 表）" },
    { id: "s-compact-needed", from: "active", event: "COMPACT_NEEDED", to: "compacting", kind: "allowed", priority: "P1", reason: "历史超条数/字符阈值，新一轮开始前先压" },
    { id: "s-compact-done-noop", from: "active", event: "COMPACT_DONE", to: "active", kind: "noop", priority: "P1", reason: "没有进行中的压缩，忽略" },
    { id: "s-compact-done", from: "compacting", event: "COMPACT_DONE", to: "active", kind: "allowed", priority: "P1", reason: "模型摘要成功，summary 累积" },
    { id: "s-compact-failed", from: "compacting", event: "COMPACT_FAILED", to: "active", kind: "allowed", priority: "P1", reason: "模型摘要失败，退回规则压缩后继续" },
    { id: "s-input-while-compacting", from: "compacting", event: "INPUT", to: "compacting", kind: "unknown", priority: "P1", reason: "压缩期间来新输入：单进程 CLI 不会发生，未建模" },
  ],
  invariants: [
    { id: "compaction_never_touches_current_turn", priority: "P1", status: "planned", text: "压缩只动历史，不碰本轮消息" },
  ],
});
