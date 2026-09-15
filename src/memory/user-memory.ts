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

export function renderMemory(mem: Record<string, string>): string {
  const entries = Object.entries(mem);
  if (entries.length === 0) return "";
  return `<memory>\n${entries.map(([k, v]) => `- ${k}: ${v}`).join("\n")}\n</memory>`;
}
