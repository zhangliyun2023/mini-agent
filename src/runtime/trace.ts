import { appendJsonl } from "../session/store.js";

// trace：每次 LLM 调用、每次工具调用、每次压缩一条记录。
// 默认写 JSONL 到 trace/<sessionId>.jsonl，测试时用内存 sink。

export type TraceEvent =
  | { kind: "llm"; step: number; model: string; messages: number; promptTokens?: number; completionTokens?: number; durationMs: number; outputPreview: string; error?: string }
  | { kind: "tool"; step: number; name: string; args: Record<string, unknown>; ok: boolean; durationMs: number; resultPreview: string }
  | { kind: "compact"; before: number; after: number; method: "llm" | "rule" }
  | { kind: "parse_error"; step: number; errors: string[] }
  | { kind: "parse_warning"; step: number; warnings: string[] }
  | { kind: "stop"; reason: string; totalMs: number };

export interface TraceRecord extends Record<string, unknown> {
  ts: string;
  userId: string;
  sessionId: string;
  turn: number;
  event: TraceEvent;
}

export interface TraceSink {
  write(record: TraceRecord): void;
}

export class MemoryTraceSink implements TraceSink {
  readonly records: TraceRecord[] = [];
  write(r: TraceRecord) {
    this.records.push(r);
  }
}

export class FileTraceSink implements TraceSink {
  constructor(private dir: string, private echo = false) {}
  write(r: TraceRecord) {
    appendJsonl(`${this.dir}/${encodeURIComponent(r.sessionId)}.jsonl`, r);
    if (this.echo) {
      const e = r.event;
      const line =
        e.kind === "llm" ? `llm#${e.step} ${e.durationMs}ms ${e.error ?? e.outputPreview}` :
        e.kind === "tool" ? `tool#${e.step} ${e.name}(${JSON.stringify(e.args)}) ${e.ok ? "ok" : "FAIL"} ${e.durationMs}ms → ${e.resultPreview}` :
        e.kind === "compact" ? `compact ${e.before}→${e.after} msgs (${e.method})` :
        e.kind === "parse_error" ? `parse_error ${e.errors.join(" | ")}` :
        e.kind === "parse_warning" ? `parse_warning ${e.warnings.join(" | ")}` :
        `stop ${e.reason} ${e.totalMs}ms`;
      process.stderr.write(`  ⎿ ${line}\n`);
    }
  }
}

export const preview = (s: string, n = 120) => s.replace(/\s+/g, " ").slice(0, n);
