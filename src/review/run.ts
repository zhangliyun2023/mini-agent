import type { UserMemoryStore } from "../memory/user-memory.js";
import type { SessionStore } from "../session/store.js";
import { interpret } from "../machine/interpreter.js";
import { reviewMachine, TERMINAL_STATUS, type ReviewEvent, type ReviewFacts, type ReviewMachine, type ReviewState } from "../../contracts/review.machine.js";
import { collectYesterday, type CollectResult } from "./collect.js";
import type { ReviewJournalStore } from "./journal.js";
import { present, type PresentResult } from "./present.js";
import type { ReviewEffect, ReviewTraceSink } from "./trace.js";
import type { TranscriptLine, TranscriptStore } from "./transcript.js";
import type { Consolidation, ReviewJournal, TranscriptReader } from "./types.js";
import { yesterdayWindow } from "./window.js";

// #19 R6 + R7：复盘编排，由 contracts/review.machine.ts 驱动（闸）。
//   每一步先 interpret：allowed 才往下走，noop 停留，未列 (状态, 事件) = unknown → 不执行后续副作用、记一条 status=unknown 的 trace、
//   以 failed_partial 收尾（journal 记 partial_read 并写明未建模转移；unknownTransition: "throw" 时再抛出，测试用）。
//   一次 interpret 一行写到 trace/reviews/<user>-<date>.jsonl（deps.trace，trace_id = review/<user>/<date>）；不给 trace 就不落盘。
//   ③ 幂等键 userId + date：journal 已有同键 → REPLAYED，只把 attempts + 1 存回，不重跑整合、不重写记忆、不重发；返回原 journal 并标 replayed。
//   ⑥ 三态：coverage none → skipped_no_chat（不调整合器、不写记忆）；partial → 照常整合但终态 failed_partial（journal partial_read，写明 unreadable）；full → delivered（ok）。
//   ⑪ 昨天对话里的文字只是材料：接收人只由 opts.deliverTo 决定，整合器 / 转写里出现的「发给 B」不参与任何决定。
//   终态 ↔ journal.status 由 TERMINAL_STATUS 一一对应（不变量 terminal_matches_journal_status）。

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
  /** 复盘 trace（trace/reviews/<user>-<date>.jsonl）；不给就不落盘 */
  trace?: ReviewTraceSink;
  /** 默认 contracts/review.machine.ts；测试用残缺表验证闸拦得住 */
  machine?: ReviewMachine;
  /** 未列转移：默认 "fail"（记 trace、journal partial_read、正常返回）；"throw" 在收尾之后抛出（测试模式） */
  unknownTransition?: "fail" | "throw";
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
  const machine = deps.machine ?? reviewMachine;
  const unknownTransition = deps.unknownTransition ?? "fail";
  const { userId, date, tz } = opts;
  const traceId = `review/${userId}/${date}`;

  const existing = deps.journal.get(userId, date);
  const attempt = (existing?.attempts ?? 0) + 1;
  let facts: ReviewFacts = { existing: existing?.status ?? null, coverage: null, readable: 0 };
  let state: ReviewState = machine.initial;
  let seq = 0;

  // 各步的产物：只在对应转移 allowed 之后才会被填上
  let collected: CollectResult | undefined;
  let consolidation: Consolidation | undefined;
  let presented: PresentResult | undefined;
  let entries_written = 0;
  let conflicts = 0;
  const delivered_to: string[] = [];
  let journal: ReviewJournal | undefined;
  let replayed = false;

  /** 终态收尾：journal.status 由终态定（TERMINAL_STATUS）；重跑只把 attempts + 1 存回；unknown 收尾把未建模转移写进 warnings */
  function finish(to: ReviewState, unknownReason?: string): ReviewJournal {
    const updatedAt = now().toISOString();
    const extraWarnings = unknownReason ? [unknownReason] : [];
    if (existing) {
      replayed = true;
      const warnings = [...(existing.warnings ?? []), ...extraWarnings];
      return { ...existing, attempts: attempt, ...(warnings.length ? { warnings } : {}), updatedAt };
    }
    const status = TERMINAL_STATUS[to as keyof typeof TERMINAL_STATUS] ?? "partial_read";
    const warnings = [...(presented?.warnings ?? []), ...extraWarnings];
    return {
      userId,
      date,
      tz,
      attempts: attempt,
      coverage: collected?.coverage ?? "none",
      ...(collected?.unreadable.length ? { unreadable: collected.unreadable } : {}),
      status,
      entries_written,
      brief: presented?.brief ?? null,
      delivered_to,
      ...(consolidation ? { method: consolidation.method } : {}),
      ...(warnings.length ? { warnings } : {}),
      updatedAt,
    };
  }

  /** 闸：先 interpret，再决定要不要收尾；一次 interpret 一行 trace。返回新状态。 */
  function transition(event: ReviewEvent, effects: ReviewEffect[]): ReviewState {
    const t = interpret(machine, state, event, facts);
    const to: ReviewState = t.status === "unknown" ? "failed_partial" : t.to;
    const all = [...effects];
    if (machine.isTerminal(to)) {
      journal = finish(to, t.status === "unknown" ? `未建模的状态转移：${state} + ${event}（${t.reason}）` : undefined);
      deps.journal.save(journal);
      all.push({ kind: "journal", status: journal.status, attempts: journal.attempts });
    }
    seq += 1;
    deps.trace?.write({ ts: now().toISOString(), trace_id: traceId, feature: "review", userId, date, attempt, seq, from: state, to, event, status: t.status, reason: t.reason, reject_code: t.reject_code, transition: t.row?.id ?? null, effects: all });
    if (t.status === "unknown" && unknownTransition === "throw") throw new Error(`未建模的状态转移：${state} + ${event}（${t.reason}）`);
    state = to;
    return state;
  }

  while (!machine.isTerminal(state)) {
    if (state === "scheduled") {
      // ③ 幂等：同键已有 → REPLAYED，直接落原终态，只记一次尝试
      transition(existing ? "REPLAYED" : "START", []);
      continue;
    }
    if (state === "collecting") {
      collected = collectYesterday(transcriptReader(deps.transcripts), userId, yesterdayWindow(date, tz));
      facts = { ...facts, coverage: collected.coverage, readable: collected.sessions.length };
      const lines = collected.sessions.reduce((n, s) => n + s.lines.length, 0);
      transition("COLLECTED", [{ kind: "collect", coverage: collected.coverage, sessions: collected.sessions.length, lines, unreadable: [...collected.unreadable] }]);
      continue;
    }
    if (state === "consolidating") {
      // ① 整合 → entries 写回记忆（同 key 异值走 conflict，不覆盖）
      consolidation = await deps.consolidate({ userId, date, sessions: collected!.sessions });
      for (const e of consolidation.entries) {
        const written = deps.memory.upsert(userId, e);
        entries_written++;
        if (written.status === "conflict") conflicts++;
      }
      transition("CONSOLIDATED", [
        { kind: "consolidate", method: consolidation.method, entries: consolidation.entries.length, highlights: consolidation.highlights.length, warnings: consolidation.warnings.length },
        { kind: "memory", written: entries_written, conflicts },
      ]);
      continue;
    }
    if (state === "presenting") {
      // ⑤ 呈现门槛 → brief（可为 null）；PRESENTED 是 noop，停留等交付
      presented = present(consolidation!, collected!.sessions.flatMap((s) => s.lines));
      if (transition("PRESENTED", [{ kind: "present", kept: presented.brief?.highlights.length ?? 0, dropped: presented.dropped.length, brief: presented.brief !== null }]) !== "presenting") continue;
      // ⑩ 交付：接收人只由 opts.deliverTo 决定（⑪）
      const effects: ReviewEffect[] = [];
      if (opts.deliverTo && presented.brief) {
        const target = deps.sessions.get(userId, opts.deliverTo);
        target.history.push({ role: "assistant", content: presented.brief.text, kind: "review_brief" });
        deps.sessions.save(target);
        delivered_to.push(opts.deliverTo);
        effects.push({ kind: "deliver", sessionId: opts.deliverTo });
      }
      transition("DELIVERED", effects);
      continue;
    }
    throw new Error(`runReview 不认识状态 ${state}`);
  }
  return { journal: journal!, replayed };
}
