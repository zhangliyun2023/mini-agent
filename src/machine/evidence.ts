import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TransitionRecord } from "../runtime/trace.js";
import { checkTraceOnlyInvariants } from "./invariants.js";

// 把不变量 oracle 接到真实证据上：读 FileTraceSink 写出的 JSONL，按 trace_id 分轮，逐轮过
// checkTraceOnlyInvariants（① ② ③ ⑤ + unknown 点名）。live 测试收尾时对本次产出跑一遍；
// 离线单测对仓库里已提交的 evals/live-trace/ 跑一遍。这里不碰 runtime，只读文件。
// ④（答案 == 盘上历史末条 == trace 末次决策）需要 RunResult 与盘上会话历史，只凭 trace 判不了，不在此列。

export interface TurnReport {
  file: string;
  trace_id: string;
  records: number;
  terminal: string | undefined;
  violations: Array<{ id: string; violations: string[] }>;
}

export interface EvidenceReport {
  files: number;
  turns: TurnReport[];
  /** 有违反项的轮 */
  failed: TurnReport[];
  /** 所有记录数（可写进报告的「N 条转移」） */
  records: number;
  /** status 分布：allowed / noop / blocked / unknown 各多少条 */
  statuses: Record<string, number>;
}

/** 递归列出 root 下所有 .jsonl（按名排序，稳定） */
export function listTraceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    if (statSync(p).isDirectory()) out.push(...listTraceFiles(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

export function readTraceFile(path: string): TransitionRecord[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l) as TransitionRecord;
      } catch (e) {
        throw new Error(`${path}:${i + 1} 不是合法 JSON：${(e as Error).message}`);
      }
    });
}

/** 按 trace_id 分组（一个 trace_id = 一轮），保持文件内出现顺序 */
export function groupByTrace(records: TransitionRecord[]): Map<string, TransitionRecord[]> {
  const m = new Map<string, TransitionRecord[]>();
  for (const r of records) {
    if (!m.has(r.trace_id)) m.set(r.trace_id, []);
    m.get(r.trace_id)!.push(r);
  }
  return m;
}

export function checkTraceFiles(paths: string[]): EvidenceReport {
  const turns: TurnReport[] = [];
  const statuses: Record<string, number> = {};
  let records = 0;
  for (const file of paths) {
    const rows = readTraceFile(file);
    records += rows.length;
    for (const r of rows) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    for (const [trace_id, turn] of groupByTrace(rows)) {
      const violations = checkTraceOnlyInvariants(turn).filter((x) => x.violations.length);
      turns.push({ file, trace_id, records: turn.length, terminal: turn[turn.length - 1]?.to, violations });
    }
  }
  return { files: paths.length, turns, failed: turns.filter((t) => t.violations.length), records, statuses };
}

/** 报告的可读摘要，给测试失败信息与 TEST_REPORT 用 */
export function summarize(report: EvidenceReport): string {
  const lines = [`${report.files} 个文件，${report.turns.length} 轮，${report.records} 条转移，status 分布 ${JSON.stringify(report.statuses)}`];
  for (const t of report.failed) for (const v of t.violations) for (const msg of v.violations) lines.push(`  ✗ ${t.file} ${t.trace_id} [${v.id}] ${msg}`);
  return lines.join("\n");
}
