import type { ReviewEvent, ReviewState } from "../../contracts/review.machine.js";
import { FileTraceSink, type BaseTransitionRecord } from "../runtime/trace.js";
import type { Coverage, ReviewJournal } from "./types.js";

// #19 R7 / Q5：复盘 trace 单独目录 trace/reviews/<user>-<date>.jsonl，trace_id = review/<user>/<date>，feature = "review"。
// 打点单位仍是「一次 interpret 一行」；effects 挂在报告该步结果的那条转移上（见 contracts/review.machine.ts 顶部的声明）。
// 白名单落盘：只写计数、状态、会话 id；记忆值、亮点原文、brief 全文一律不进 trace。
// evals/judge.py 与 test/unit/live-evidence.test.ts 只看 evals/live-trace/（turn）；本目录不在其下（NEXT_STEPS：证据工具按 feature 分表）。

export const REVIEW_TRACE_DIR = "trace/reviews";

export type ReviewEffect =
  | { kind: "collect"; coverage: Coverage; sessions: number; lines: number; unreadable: string[] }
  | { kind: "consolidate"; method: "llm" | "rule"; entries: number; highlights: number; warnings: number }
  | { kind: "memory"; written: number; conflicts: number }
  | { kind: "present"; kept: number; dropped: number; brief: boolean }
  | { kind: "deliver"; sessionId: string }
  | { kind: "journal"; status: ReviewJournal["status"]; attempts: number };

export interface ReviewTransitionRecord extends BaseTransitionRecord {
  feature: "review";
  userId: string;
  /** 计划日期（幂等键的一半） */
  date: string;
  /** 同键第几次跑（= journal.attempts）；同一 trace_id 下按它分次 */
  attempt: number;
  from: ReviewState;
  to: ReviewState;
  event: ReviewEvent;
  effects: ReviewEffect[];
}

export interface ReviewTraceSink {
  write(record: ReviewTransitionRecord): void;
}

/** 复盘的文件 sink：`<dir>/<user>-<date>.jsonl` */
export function reviewTraceSink(dir = REVIEW_TRACE_DIR, echo = false): ReviewTraceSink {
  return new FileTraceSink(dir, echo, (r) => `${String(r.userId)}-${String(r.date)}`);
}
