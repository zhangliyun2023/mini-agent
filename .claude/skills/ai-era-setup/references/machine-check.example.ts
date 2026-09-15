// 对答案：期望转移序列（journeys.json）vs 观察到的转移（JSONL rows）。人、AI、测试用同一个函数。
export interface TransitionRow { trace_id: string; feature: string; transition: string | null; status: string; ts: string }
export interface Journey { feature: string; expect: string[]; alternatives?: string[][] }
export type JourneyResult =
  | { status: "passed"; trace_id: string }
  | { status: "failed"; closest: { trace_id: string; actual: string[] } }
  | { status: "not_observed" };

export function checkJourney(rows: TransitionRow[], journey: Journey, traceId?: string): JourneyResult {
  const byTrace = new Map<string, string[]>();
  for (const r of rows) {
    if (r.feature !== journey.feature || (traceId && r.trace_id !== traceId)) continue;
    if (!byTrace.has(r.trace_id)) byTrace.set(r.trace_id, []);
    if (r.transition) byTrace.get(r.trace_id)!.push(r.transition);
  }
  if (byTrace.size === 0) return { status: "not_observed" };
  const candidates = [journey.expect, ...(journey.alternatives ?? [])];
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  let closest: { trace_id: string; actual: string[] } | null = null;
  for (const [tid, actual] of byTrace) {
    if (candidates.some((c) => same(c, actual))) return { status: "passed", trace_id: tid };
    if (!closest || Math.abs(actual.length - journey.expect.length) < Math.abs(closest.actual.length - journey.expect.length)) closest = { trace_id: tid, actual };
  }
  return { status: "failed", closest: closest! };
}

/** unknown 转移永远单独列出，不是「没关系」 */
export const unknownRows = (rows: TransitionRow[]) => rows.filter((r) => r.status === "unknown");
