import { randomBytes } from "node:crypto";
import { appendJsonl } from "../session/store.js";
import type { TurnEvent, TurnState } from "../../contracts/turn.machine.js";
import type { Verdict } from "../machine/interpreter.js";
import type { LlmErrorClass } from "../llm/errors.js";
import type { ToolMode } from "../llm/types.js";

// trace 的单位是「一次状态转移」（docs/product/SPEC-state-machines.md §2 D4）：
//   {trace_id, step, from, to, event, status, reason, effects}
// llm / tool / compact / parse 调用作为 effects 挂在触发它们的那条转移上；
// 旧的 stop 记录被终态转移取代——终态转移的 effects 里带一条 answer。
// 本地全量落盘、不采样；API key 从不进 trace。

/** 一次失败的模型调用尝试（#11）：第几次、错误类别、这次失败后等了多久再试（最后一次或不重试时为 0） */
export interface LlmTry {
  n: number;
  errorClass: LlmErrorClass;
  waitMs: number;
}

export type Effect =
  | { kind: "compact"; before: number; after: number; method: "llm" | "rule" }
  /** 记忆块超 memoryMaxChars 被截：总条数、保留条数（最新的）、上限——warning，挂在轮首第一条转移上 */
  | { kind: "memory_truncated"; total: number; kept: number; limit: number }
  | { kind: "llm"; request_id: string; step: number; model: string; mode: ToolMode; messages: number; attempts: number; tries: LlmTry[]; promptTokens?: number; completionTokens?: number; durationMs: number; outputPreview: string; error?: string }
  | { kind: "parse"; step: number; toolCalls: number; hasFinal: boolean; errors: string[]; warnings: string[] }
  | { kind: "tool"; request_id: string; step: number; name: string; args: Record<string, unknown>; ok: boolean; durationMs: number; resultPreview: string }
  | { kind: "answer"; stoppedBy: "final" | "max_steps" | "error"; answer: string; totalMs: number };

export interface TransitionRecord extends Record<string, unknown> {
  ts: string;
  /** 用户/会话/轮次 */
  trace_id: string;
  /** 哪张表（答案卷按 feature 过滤） */
  feature: string;
  userId: string;
  sessionId: string;
  turn: number;
  /** 本轮第几条转移，从 1 起 */
  seq: number;
  /** 解释时的 facts.step（本轮已发起的模型调用次数） */
  step: number;
  from: TurnState;
  to: TurnState;
  event: TurnEvent;
  status: Verdict;
  reason?: string;
  /** blocked 时的机器可读原因（行的 reject_code） */
  reject_code?: string;
  /** 命中的行 id；unknown 为 null */
  transition: string | null;
  effects: Effect[];
}

export interface TraceSink {
  write(record: TransitionRecord): void;
}

/** 答案卷与 trace 序列都用这个格式：行 id（unknown 没有行，退回 `from --EVENT--> to`），非 allowed 追加 ` [status]` */
export function formatTransition(r: { from: string; event: string; to: string; status: Verdict; transition?: string | null }): string {
  const head = r.transition ?? `${r.from} --${r.event}--> ${r.to}`;
  return `${head}${r.status === "allowed" ? "" : ` [${r.status}]`}`;
}

export class MemoryTraceSink implements TraceSink {
  readonly records: TransitionRecord[] = [];
  write(r: TransitionRecord) {
    this.records.push(r);
  }
  /** 转移序列（可选按 trace_id 过滤） */
  sequence(traceId?: string): string[] {
    return this.records.filter((r) => !traceId || r.trace_id === traceId).map(formatTransition);
  }
  /** 拍平所有转移上的某类副作用 */
  effects<K extends Effect["kind"]>(kind: K): Extract<Effect, { kind: K }>[] {
    return this.records.flatMap((r) => r.effects).filter((e): e is Extract<Effect, { kind: K }> => e.kind === kind);
  }
}

export class FileTraceSink implements TraceSink {
  constructor(private dir: string, private echo = false) {}
  write(r: TransitionRecord) {
    appendJsonl(`${this.dir}/${encodeURIComponent(r.sessionId)}.jsonl`, r);
    if (this.echo) {
      const fx = r.effects.map(describeEffect).filter(Boolean).join(" · ");
      process.stderr.write(`  ⎿ #${r.seq} ${formatTransition(r)}${fx ? " · " + fx : ""}\n`);
    }
  }
}

function describeEffect(e: Effect): string {
  switch (e.kind) {
    case "llm":
      return `llm#${e.step} ${e.durationMs}ms${e.attempts > 1 ? ` (${e.attempts} 次)` : ""} ${e.error ?? e.outputPreview}`;
    case "tool":
      return `tool ${e.name}(${JSON.stringify(e.args)}) ${e.ok ? "ok" : "FAIL"} ${e.durationMs}ms → ${e.resultPreview}`;
    case "compact":
      return `compact ${e.before}→${e.after} msgs (${e.method})`;
    case "memory_truncated":
      return `memory_truncated ${e.kept}/${e.total} 条 (limit ${e.limit} chars)`;
    case "parse":
      return e.errors.length || e.warnings.length ? `parse ${[...e.errors, ...e.warnings].join(" | ")}` : "";
    case "answer":
      return `answer(${e.stoppedBy}) ${e.totalMs}ms`;
  }
}

export const preview = (s: string, n = 120) => s.replace(/\s+/g, " ").slice(0, n);

/** 一次外部调用（模型 / 工具）一个 id：`r-` + 短随机；runtime 生成，只用来在 trace 里把 effect 与调用对上 */
export const newRequestId = () => `r-${randomBytes(6).toString("hex")}`;
