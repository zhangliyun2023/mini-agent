import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryEntry, Source } from "../review/types.js";
import { kvView, upsertEntry } from "./entries.js";

// 用户级长期记忆：跨 session 共享的条目集合（#19 ④：stated / inferred、confidence、source、conflict 不覆盖）。
// 写入：模型显式调 remember 工具（stated / 1 / 当前轮）；复盘生成器写 inferred（R4）。召回：每轮组 context 时整块放进 system prompt 尾部。
// 这题不做向量检索——条目少，全量注入比检索更稳，也让「召回时机/放置方式」一句话说清。

export interface UserMemoryStore {
  /** 全部条目（含 conflict），写入顺序 */
  entries(userId: string): MemoryEntry[];
  /** 按 entries.ts 的规则写一条；返回写进集合后的那条（status 告诉调用方是否成了 conflict） */
  upsert(userId: string, entry: MemoryEntry): MemoryEntry;
  /** KV 视图：active 且 stated 的 key → value（兼容 #12 之前的调用方） */
  load(userId: string): Record<string, string>;
  /** 便捷写法：stated / confidence 1 / 直接写入（没有会话来源）；同样走 upsert 规则，同 key 不同值不覆盖 */
  set(userId: string, key: string, value: string, source?: Source): MemoryEntry;
}

/** 旧格式（纯 KV 对象）读入时的来源：不知道是哪一轮说的 */
export const LEGACY_SOURCE: Source = { sessionId: "legacy", turn: 0 };
/** set() 直接写入时的来源（测试 / 脚本），不是某一轮对话 */
export const DIRECT_SOURCE: Source = { sessionId: "direct", turn: 0 };
export const todayISO = (now = new Date()) => now.toISOString().slice(0, 10);

abstract class EntryStore implements UserMemoryStore {
  protected abstract read(userId: string): MemoryEntry[];
  protected abstract write(userId: string, entries: MemoryEntry[]): void;
  entries(userId: string) {
    return this.read(userId).map((e) => ({ ...e, source: { ...e.source } }));
  }
  upsert(userId: string, entry: MemoryEntry) {
    const r = upsertEntry(this.read(userId), entry);
    this.write(userId, r.entries);
    return r.stored;
  }
  load(userId: string) {
    return kvView(this.read(userId));
  }
  set(userId: string, key: string, value: string, source: Source = DIRECT_SOURCE) {
    return this.upsert(userId, { key, value, kind: "stated", confidence: 1, source, date: todayISO(), status: "active" });
  }
}

export class MemoryUserMemoryStore extends EntryStore {
  private map = new Map<string, MemoryEntry[]>();
  protected read(userId: string) {
    return this.map.get(userId) ?? [];
  }
  protected write(userId: string, entries: MemoryEntry[]) {
    this.map.set(userId, entries);
  }
}

/** 盘上格式：`{ "entries": MemoryEntry[] }`。读到旧格式（纯 KV 对象）时视为 stated / confidence 1 / source legacy，date 取文件 mtime；下次写入即转成新格式。 */
export class FileUserMemoryStore extends EntryStore {
  constructor(private root: string) {
    super();
  }
  private path(u: string) {
    mkdirSync(this.root, { recursive: true });
    return join(this.root, `${encodeURIComponent(u)}.memory.json`);
  }
  protected read(userId: string): MemoryEntry[] {
    const p = this.path(userId);
    if (!existsSync(p)) return [];
    const parsed = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && Array.isArray((parsed as { entries?: unknown }).entries)) return (parsed as { entries: MemoryEntry[] }).entries;
    const date = todayISO(statSync(p).mtime);
    return Object.entries((parsed ?? {}) as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value), kind: "stated" as const, confidence: 1, source: { ...LEGACY_SOURCE }, date, status: "active" as const }));
  }
  protected write(userId: string, entries: MemoryEntry[]) {
    writeFileSync(this.path(userId), JSON.stringify({ entries }, null, 2));
  }
}

export interface RenderedMemory {
  /** 放进 system prompt 的块；没有记忆时为空串 */
  block: string;
  /** 超限被截时才有：总条数与实际保留条数 */
  truncated?: { total: number; kept: number };
}

const MEMORY_OPEN = "<memory>\n";
const MEMORY_CLOSE = "\n</memory>";

/** 一条条目在记忆块里的样子：stated 原样；inferred 标「（推断）」；conflict 渲染成「待确认」，两个值都给模型看，等用户下次出现时确认 */
export function renderEntryLine(e: MemoryEntry): string {
  if (e.status === "conflict") return `- ${e.key}（待确认：昨天说 ${e.value}，之前记 ${e.conflictWith ?? "?"}）`;
  if (e.kind === "inferred") return `- ${e.key}: ${e.value}（推断）`;
  return `- ${e.key}: ${e.value}`;
}

function toEntries(mem: MemoryEntry[] | Record<string, string>): MemoryEntry[] {
  if (Array.isArray(mem)) return mem;
  return Object.entries(mem).map(([key, value]) => ({ key, value, kind: "stated" as const, confidence: 1, source: { ...DIRECT_SOURCE }, date: "", status: "active" as const }));
}

/**
 * 预算不够时的丢弃顺序（#19 Q6）：先丢 conflict，再丢 inferred（confidence 低的先），stated 之间最老的先丢；同级按写入顺序最老先。
 * 返回条目下标序列，前面的先丢。全 stated 时就是「最老先丢」= #12 的行为。
 */
export function dropOrder(entries: readonly MemoryEntry[]): number[] {
  const rank = (e: MemoryEntry) => (e.status === "conflict" ? 0 : e.kind === "inferred" ? 1 : 2);
  return entries
    .map((_, i) => i)
    .sort((a, b) => rank(entries[a]) - rank(entries[b]) || (rank(entries[a]) === 1 ? entries[a].confidence - entries[b].confidence : 0) || a - b);
}

/**
 * 渲染记忆块。limit 是整块（含 <memory> 标签）的字符上限：超限时按 dropOrder 逐条丢到装得下为止，保留的条目仍按写入顺序排。
 * 也接受 #12 的 KV 对象（视为 stated，此时退化为「最老先丢」）。不做时间衰减、不做检索（见 docs/NEXT_STEPS.md）。
 */
export function renderMemory(mem: MemoryEntry[] | Record<string, string>, limit = Infinity): RenderedMemory {
  const entries = toEntries(mem);
  if (entries.length === 0) return { block: "" };
  const lines = entries.map(renderEntryLine);
  const blockOf = (kept: Set<number>) => {
    const idx = [...kept].sort((a, b) => a - b);
    return idx.length ? `${MEMORY_OPEN}${idx.map((i) => lines[i]).join("\n")}${MEMORY_CLOSE}` : "";
  };
  const kept = new Set(entries.map((_, i) => i));
  for (const i of dropOrder(entries)) {
    if (blockOf(kept).length <= limit) break;
    kept.delete(i);
  }
  const block = blockOf(kept);
  return kept.size === entries.length ? { block } : { block, truncated: { total: entries.length, kept: kept.size } };
}
