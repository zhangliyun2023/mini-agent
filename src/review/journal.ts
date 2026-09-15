import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewJournal } from "./types.js";

// #19 ③ / ⑩：复盘日志（journal）按幂等键 userId + date 存一条；文件版落 `data/reviews/<user>/<date>.json`。
// 重跑同键只递增 attempts（见 run.ts），所以 save 是整条覆盖，不追加。

export interface ReviewJournalStore {
  get(userId: string, date: string): ReviewJournal | null;
  save(journal: ReviewJournal): void;
}

/** 内存版：测试与单进程服务用 */
export class MemoryReviewJournalStore implements ReviewJournalStore {
  private map = new Map<string, ReviewJournal>();
  private key(u: string, d: string) {
    return `${u}::${d}`;
  }
  get(userId: string, date: string): ReviewJournal | null {
    const j = this.map.get(this.key(userId, date));
    return j ? JSON.parse(JSON.stringify(j)) : null;
  }
  save(journal: ReviewJournal): void {
    this.map.set(this.key(journal.userId, journal.date), JSON.parse(JSON.stringify(journal)));
  }
}

/** 文件版：`<root>/<user>/<date>.json`，一键一文件 */
export class FileReviewJournalStore implements ReviewJournalStore {
  constructor(private root: string) {}
  private path(u: string, d: string) {
    return join(this.root, encodeURIComponent(u), `${encodeURIComponent(d)}.json`);
  }
  get(userId: string, date: string): ReviewJournal | null {
    const p = this.path(userId, date);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8")) as ReviewJournal;
  }
  save(journal: ReviewJournal): void {
    const p = this.path(journal.userId, journal.date);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(journal, null, 2));
  }
}
