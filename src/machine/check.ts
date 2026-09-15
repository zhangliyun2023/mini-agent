import type { Machine } from "./interpreter.js";

// 对答案（B1）：期望的行 id 序列（contracts/journeys.json）vs 观察到的转移（trace JSONL rows）。
// 人、AI、测试用同一个函数；判分只吃 rows，不吃 sink / db。
// 三态：passed（某一轮逐条相同）/ failed（给出最接近的一轮）/ not_observed（这张表 / 这个 trace_id 根本没记录）。

export interface TransitionRow {
  trace_id: string;
  feature: string;
  /** 命中的行 id；unknown 为 null */
  transition: string | null;
  status: string;
  ts: string;
}

export interface Journey {
  feature: string;
  /** 行 id 序列（不带 status 后缀） */
  expect: string[];
  /** 也算通过的其它序列 */
  alternatives?: string[][];
  /** 给人看的一句话 */
  title?: string;
}

export type JourneyResult =
  | { status: "passed"; trace_id: string }
  | { status: "failed"; closest: { trace_id: string; actual: string[] } }
  | { status: "not_observed" };

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function checkJourney(rows: TransitionRow[], journey: Journey, traceId?: string): JourneyResult {
  const byTrace = new Map<string, string[]>();
  for (const r of rows) {
    if (r.feature !== journey.feature || (traceId && r.trace_id !== traceId)) continue;
    if (!byTrace.has(r.trace_id)) byTrace.set(r.trace_id, []);
    // unknown 转移没有行 id，序列里不出现；它们由 unknownRows 单独列出，不会被「对上了」掩盖
    if (r.transition) byTrace.get(r.trace_id)!.push(r.transition);
  }
  if (byTrace.size === 0) return { status: "not_observed" };
  const candidates = [journey.expect, ...(journey.alternatives ?? [])];
  let closest: { trace_id: string; actual: string[] } | null = null;
  const distance = (actual: string[]) => Math.abs(actual.length - journey.expect.length);
  for (const [tid, actual] of byTrace) {
    if (candidates.some((c) => same(c, actual))) return { status: "passed", trace_id: tid };
    if (!closest || distance(actual) < distance(closest.actual)) closest = { trace_id: tid, actual };
  }
  return { status: "failed", closest: closest! };
}

/** unknown 转移永远单独列出，不是「没关系」 */
export const unknownRows = <R extends TransitionRow>(rows: R[]): R[] => rows.filter((r) => r.status === "unknown");

/** 旅程与表拴在一起：每个 id 存在、从 initial 出发、首尾相接、落在终态（无终态的表只查前三条）。返回问题列表，空 = 通过。 */
export function validateJourney(journey: Journey, m: Machine<string, string, any>): string[] {
  const problems: string[] = [];
  const byId = new Map(m.rows.map((r) => [r.id, r]));
  const check = (label: string, ids: string[]) => {
    if (ids.length === 0) return problems.push(`${label} 为空`);
    const rows = ids.map((id) => byId.get(id));
    rows.forEach((r, i) => !r && problems.push(`${label} 第 ${i + 1} 条 "${ids[i]}" 不在 ${m.feature} 表里`));
    if (rows.some((r) => !r)) return;
    const seq = rows as NonNullable<(typeof rows)[number]>[];
    if (seq[0].from !== m.initial) problems.push(`${label} 首条 "${seq[0].id}" 不从 initial(${m.initial}) 出发`);
    for (let i = 1; i < seq.length; i++) {
      if (seq[i - 1].to !== seq[i].from) problems.push(`${label} 第 ${i} 与 ${i + 1} 条首尾接不上："${seq[i - 1].id}" 到 ${seq[i - 1].to}，"${seq[i].id}" 却从 ${seq[i].from} 出发`);
    }
    const last = seq[seq.length - 1];
    if (m.terminal.length && !m.isTerminal(last.to)) problems.push(`${label} 末条 "${last.id}" 落在 ${last.to}，不是终态`);
  };
  check("expect", journey.expect);
  (journey.alternatives ?? []).forEach((alt, i) => check(`alternatives[${i}]`, alt));
  return problems;
}
