import type { UserMemoryStore } from "../memory/user-memory.js";
import type { SessionStore } from "../session/store.js";
import { collectYesterday } from "./collect.js";
import type { ReviewJournalStore } from "./journal.js";
import { present } from "./present.js";
import type { TranscriptLine, TranscriptStore } from "./transcript.js";
import type { Consolidation, ReviewJournal, TranscriptReader } from "./types.js";
import { yesterdayWindow } from "./window.js";

// #19 R6：复盘编排。一次 runReview = 取昨天（R2）→ 整合（R4，注入）→ 写记忆（R3 的 upsert 规则）→ 呈现门槛（R5）→ 交付（⑩）→ journal 落盘。
//   ③ 幂等键 userId + date：journal 已有同键 → 只把 attempts + 1 存回，不重跑整合、不重写记忆、不重发；返回原 journal 并标 replayed。
//   ⑥ 三态：coverage none → no_chat（不调整合器、不写记忆）；partial → 照常整合但 status partial_read，journal 写明 unreadable；full → ok。
//   ⑪ 昨天对话里的文字只是材料：接收人只由 opts.deliverTo 决定，整合器 / 转写里出现的「发给 B」不参与任何决定。
//   本片不写 trace（R7 接表后再落 trace/reviews/），不做 CLI（R8）。

/** R4 的 consolidate 入参（签名：({userId, date, sessions}) → Promise<Consolidation>） */
export type ConsolidateInput = { userId: string; date: string; sessions: Array<{ sessionId: string; lines: TranscriptLine[] }> };
export type ConsolidateFn = (input: ConsolidateInput) => Promise<Consolidation>;

export interface ReviewDeps {
  transcripts: TranscriptStore;
  memory: UserMemoryStore;
  sessions: SessionStore;
  journal: ReviewJournalStore;
  consolidate: ConsolidateFn;
  now?: () => Date;
}

export interface ReviewOpts {
  userId: string;
  /** 计划日期 YYYY-MM-DD（今天）；「昨天」由它 + tz 算出，重跑 / 补跑仍用原计划日期 */
  date: string;
  tz: string;
  /** 交付目标会话 id；给了且 brief 非空才追加 review_brief。接收人只由这里决定（⑪） */
  deliverTo?: string;
}

export interface ReviewResult {
  journal: ReviewJournal;
  /** true = 同键已有 journal，本次只递增 attempts，没有重跑 */
  replayed: boolean;
}

/**
 * 把 R1 的 TranscriptStore 适配成 R2 要的 TranscriptReader：
 * FileTranscriptStore.read 对缺失文件返回 []（= 没聊），对坏行抛错 → 这里接成 null（= 读不出，计入 partial_read）。
 */
export function transcriptReader(store: TranscriptStore): TranscriptReader {
  return {
    list: (userId) => store.list(userId),
    read: (userId, sessionId) => {
      try {
        return store.read(userId, sessionId);
      } catch {
        return null;
      }
    },
  };
}

export async function runReview(deps: ReviewDeps, opts: ReviewOpts): Promise<ReviewResult> {
  const now = deps.now ?? (() => new Date());
  const { userId, date, tz } = opts;

  // ③ 幂等：同键已有 → 只记一次尝试
  const existing = deps.journal.get(userId, date);
  if (existing) {
    const replay: ReviewJournal = { ...existing, attempts: existing.attempts + 1, updatedAt: now().toISOString() };
    deps.journal.save(replay);
    return { journal: replay, replayed: true };
  }

  const window = yesterdayWindow(date, tz);
  const collected = collectYesterday(transcriptReader(deps.transcripts), userId, window);
  const base = { userId, date, tz, attempts: 1, coverage: collected.coverage, ...(collected.unreadable.length ? { unreadable: collected.unreadable } : {}) };

  // ⑥ none → no_chat：不调整合器、不写记忆、不交付
  if (collected.coverage === "none") {
    const journal: ReviewJournal = { ...base, status: "no_chat", entries_written: 0, brief: null, delivered_to: [], updatedAt: now().toISOString() };
    deps.journal.save(journal);
    return { journal, replayed: false };
  }

  const status: ReviewJournal["status"] = collected.coverage === "partial" ? "partial_read" : "ok";

  // partial 且一个可读会话都没有：没有材料可整合，但状态仍是 partial_read（不冒充 no_chat）
  if (collected.sessions.length === 0) {
    const journal: ReviewJournal = { ...base, status, entries_written: 0, brief: null, delivered_to: [], updatedAt: now().toISOString() };
    deps.journal.save(journal);
    return { journal, replayed: false };
  }

  // ① 整合 → entries 写回记忆（同 key 异值走 conflict，不覆盖）
  const consolidation = await deps.consolidate({ userId, date, sessions: collected.sessions });
  let entries_written = 0;
  for (const e of consolidation.entries) {
    deps.memory.upsert(userId, e);
    entries_written++;
  }

  // ⑤ 呈现门槛 → brief（可为 null）
  const yesterdayLines = collected.sessions.flatMap((s) => s.lines);
  const presented = present(consolidation, yesterdayLines);

  // ⑩ 交付：接收人只由 opts.deliverTo 决定（⑪）
  const delivered_to: string[] = [];
  if (opts.deliverTo && presented.brief) {
    const target = deps.sessions.get(userId, opts.deliverTo);
    target.history.push({ role: "assistant", content: presented.brief.text, kind: "review_brief" });
    deps.sessions.save(target);
    delivered_to.push(opts.deliverTo);
  }

  const journal: ReviewJournal = {
    ...base,
    status,
    entries_written,
    brief: presented.brief,
    delivered_to,
    method: consolidation.method,
    ...(presented.warnings.length ? { warnings: presented.warnings } : {}),
    updatedAt: now().toISOString(),
  };
  deps.journal.save(journal);
  return { journal, replayed: false };
}
