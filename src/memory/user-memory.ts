import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 用户级长期记忆：跨 session 共享的键值对（称呼、偏好、常用城市…）。
// 写入：模型显式调 remember 工具。召回：每轮组 context 时整块放进 system prompt 尾部。
// 这题不做向量检索——条目少，全量注入比检索更稳，也让「召回时机/放置方式」一句话说清。

export interface UserMemoryStore {
  load(userId: string): Record<string, string>;
  set(userId: string, key: string, value: string): void;
}

export class MemoryUserMemoryStore implements UserMemoryStore {
  private map = new Map<string, Record<string, string>>();
  load(userId: string) {
    return { ...(this.map.get(userId) ?? {}) };
  }
  set(userId: string, key: string, value: string) {
    const cur = this.map.get(userId) ?? {};
    cur[key] = value;
    this.map.set(userId, cur);
  }
}

export class FileUserMemoryStore implements UserMemoryStore {
  constructor(private root: string) {}
  private path(u: string) {
    mkdirSync(this.root, { recursive: true });
    return join(this.root, `${encodeURIComponent(u)}.memory.json`);
  }
  load(userId: string) {
    const p = this.path(userId);
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, string>) : {};
  }
  set(userId: string, key: string, value: string) {
    const cur = this.load(userId);
    cur[key] = value;
    writeFileSync(this.path(userId), JSON.stringify(cur, null, 2));
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

/**
 * 渲染记忆块。limit 是整块（含 <memory> 标签）的字符上限：超限时按写入顺序从最新一条往回收，装不下的最老条目丢掉。
 * 写入顺序 = 对象插入序（内存实现与文件实现读回 JSON 都保序；只有整数样式的 key 会被 JS 排到最前，remember 的 key 不这么起）。
 * 不做时间衰减、不做检索（见 docs/NEXT_STEPS.md）。
 */
export function renderMemory(mem: Record<string, string>, limit = Infinity): RenderedMemory {
  const lines = Object.entries(mem).map(([k, v]) => `- ${k}: ${v}`);
  if (lines.length === 0) return { block: "" };
  const wrap = MEMORY_OPEN.length + MEMORY_CLOSE.length;
  let used = wrap;
  let start = lines.length;
  while (start > 0) {
    const next = lines[start - 1].length + (start < lines.length ? 1 : 0); // 换行符
    if (used + next > limit) break;
    used += next;
    start -= 1;
  }
  const kept = lines.slice(start);
  const block = kept.length ? `${MEMORY_OPEN}${kept.join("\n")}${MEMORY_CLOSE}` : "";
  return start === 0 ? { block } : { block, truncated: { total: lines.length, kept: kept.length } };
}
