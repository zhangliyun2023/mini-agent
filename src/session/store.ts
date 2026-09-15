import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../llm/types.js";

// Session = 一个窗口。同一用户的两个窗口是两个 session，各自有历史、状态袋、轮次计数。
export interface Session {
  userId: string;
  sessionId: string;
  /** 已完成轮次的对话历史（已剥掉历史 think，工具结果已精简） */
  history: ChatMessage[];
  /** 压缩产生的摘要，放在 history 之前 */
  summary?: string;
  /** 有状态工具（todo 等）的数据袋 */
  state: Record<string, unknown>;
  /** 用户输入次数 */
  turns: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionStore {
  get(userId: string, sessionId: string): Session;
  save(session: Session): void;
  list(userId: string): string[];
}

function fresh(userId: string, sessionId: string): Session {
  const now = new Date().toISOString();
  return { userId, sessionId, history: [], state: {}, turns: 0, createdAt: now, updatedAt: now };
}

/** 内存版：测试与单进程 HTTP 服务用 */
export class MemorySessionStore implements SessionStore {
  private map = new Map<string, Session>();
  private key(u: string, s: string) {
    return `${u}::${s}`;
  }
  get(userId: string, sessionId: string): Session {
    let s = this.map.get(this.key(userId, sessionId));
    if (!s) {
      s = fresh(userId, sessionId);
      this.map.set(this.key(userId, sessionId), s);
    }
    return s;
  }
  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    this.map.set(this.key(session.userId, session.sessionId), session);
  }
  list(userId: string): string[] {
    return [...this.map.values()].filter((s) => s.userId === userId).map((s) => s.sessionId);
  }
}

/** 文件版：每个 session 一个 JSON，CLI 多开终端时靠它接着聊 */
export class FileSessionStore implements SessionStore {
  constructor(private root: string) {}
  private path(u: string, s: string) {
    const dir = join(this.root, encodeURIComponent(u));
    mkdirSync(dir, { recursive: true });
    return join(dir, `${encodeURIComponent(s)}.json`);
  }
  get(userId: string, sessionId: string): Session {
    const p = this.path(userId, sessionId);
    if (!existsSync(p)) return fresh(userId, sessionId);
    return JSON.parse(readFileSync(p, "utf8")) as Session;
  }
  save(session: Session): void {
    session.updatedAt = new Date().toISOString();
    writeFileSync(this.path(session.userId, session.sessionId), JSON.stringify(session, null, 2));
  }
  list(userId: string): string[] {
    const dir = join(this.root, encodeURIComponent(userId));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => decodeURIComponent(f.replace(/\.json$/, "")));
  }
}

export function appendJsonl(path: string, obj: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, JSON.stringify(obj) + "\n");
}
