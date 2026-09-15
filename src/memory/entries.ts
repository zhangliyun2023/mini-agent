import type { MemoryEntry } from "../review/types.js";

// 记忆条目集合的 upsert 规则（#19 ④ / Q3）。纯函数：输入旧集合与一条新条目，返回新集合，不改入参。
//   同 key 且 value 相同 → 刷新那条的 date / source（kind / confidence / status 不动）
//   同 key 不同 value   → 追加一条 status: "conflict"、conflictWith: 旧 value 的新条目；旧条目保留 active，不覆盖
//   不同 key            → 原样追加
// 集合顺序 = 写入顺序（渲染截断时「最老」按这个顺序算，与 #12 的对象插入序同义）。

export type UpsertOutcome = "refreshed" | "conflict" | "appended";

export interface UpsertResult {
  entries: MemoryEntry[];
  /** 写进集合后的那条（conflict 时 status 已是 "conflict"） */
  stored: MemoryEntry;
  outcome: UpsertOutcome;
}

export function upsertEntry(entries: readonly MemoryEntry[], incoming: MemoryEntry): UpsertResult {
  const sameValueAt = entries.findIndex((e) => e.key === incoming.key && e.value === incoming.value);
  if (sameValueAt >= 0) {
    const stored: MemoryEntry = { ...entries[sameValueAt], date: incoming.date, source: { ...incoming.source } };
    return { entries: entries.map((e, i) => (i === sameValueAt ? stored : e)), stored, outcome: "refreshed" };
  }
  const active = entries.find((e) => e.key === incoming.key && e.status === "active");
  if (active) {
    const stored: MemoryEntry = { ...incoming, source: { ...incoming.source }, status: "conflict", conflictWith: active.value };
    return { entries: [...entries, stored], stored, outcome: "conflict" };
  }
  const stored: MemoryEntry = { ...incoming, source: { ...incoming.source } };
  return { entries: [...entries, stored], stored, outcome: "appended" };
}

/** KV 视图：只取 active 且 stated 的条目，key → value（兼容 #12 之前的 load() 调用方） */
export function kvView(entries: readonly MemoryEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries) if (e.status === "active" && e.kind === "stated") out[e.key] = e.value;
  return out;
}
