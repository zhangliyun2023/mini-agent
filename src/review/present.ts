import type { Brief, Consolidation, Highlight } from "./types.js";

// #19 ⑤ 呈现门槛（R5）：纯函数，不碰存储、不碰模型。
// 输入是整合结果 + 昨天的转写行；输出是可直接发给用户的 brief（或 null）+ 被拦下的条目 + 警告。

// 转写行形状按 issue Q2（R1 落盘；这里只读 content，用结构类型接 R1 的实际类型）。
export type TranscriptLine = { ts: string; userId: string; sessionId: string; turn: number; traceId: string; role: "user" | "assistant" | "tool" | "system"; content: string; name?: string };

export type PresentResult = { brief: Brief; dropped: Array<{ highlight: Highlight; reason: string }>; warnings: string[] };

const WHY_TODAY = new Set<Highlight["why_today"]>(["due_today", "unfinished", "planned_today"]);
const PREFIX: Record<Highlight["why_today"], string> = { due_today: "今天到期：", unfinished: "昨天没收尾：", planned_today: "你说过今天要：" };
/** 亮点是某行内容的连续子串且长度 ≥ 此值（去空白后按码点计）→ 视为复述原话 */
export const VERBATIM_MIN_CHARS = 20;

const squash = (s: string) => s.replace(/\s+/g, "");

function gateReason(h: Highlight): string | null {
  const why = (h as { why_today?: unknown }).why_today;
  if (why === undefined || why === null || why === "") return "missing_why_today";
  if (!WHY_TODAY.has(why as Highlight["why_today"])) return `invalid_why_today:${String(why)}`;
  const s = (h as { source?: unknown }).source;
  if (!s || typeof s !== "object" || typeof (s as Source).sessionId !== "string" || typeof (s as Source).turn !== "number") return "missing_source";
  return null;
}
type Source = Highlight["source"];

/** 亮点与昨天哪一行逐字重合：去空白后相等，或是该行 ≥ VERBATIM_MIN_CHARS 字的连续子串。没有则 null。 */
function verbatimHit(text: string, lines: TranscriptLine[]): TranscriptLine | null {
  const t = squash(text);
  if (t === "") return null;
  const longEnough = [...t].length >= VERBATIM_MIN_CHARS;
  for (const l of lines) {
    const c = squash(l.content ?? "");
    if (c === t) return l;
    if (longEnough && c.includes(t)) return l;
  }
  return null;
}

export function present(consolidation: Consolidation, yesterdayLines: TranscriptLine[]): PresentResult {
  const dropped: PresentResult["dropped"] = [];
  const warnings: string[] = [...consolidation.warnings];
  const kept: Highlight[] = [];
  for (const h of consolidation.highlights ?? []) {
    const reason = gateReason(h);
    if (reason) { dropped.push({ highlight: h, reason }); continue; }
    const hit = verbatimHit(h.text ?? "", yesterdayLines);
    if (hit) {
      dropped.push({ highlight: h, reason: "verbatim" });
      warnings.push(`亮点「${h.text}」与昨天 ${hit.sessionId} 第 ${hit.turn} 轮 ${hit.role} 的原话逐字重合，已过滤`);
      continue;
    }
    kept.push(h);
  }
  if (kept.length === 0) return { brief: null, dropped, warnings };
  const text = kept.map((h) => `${PREFIX[h.why_today]}${h.text}`).join("\n");
  return { brief: { highlights: kept, text }, dropped, warnings };
}
