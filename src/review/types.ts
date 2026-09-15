// #19 复盘（记忆整合）的共享类型——并行开工的契约，改动先改这里（原文来自 issue #19 评论）。

export type Source = { sessionId: string; turn: number };
export type MemoryEntry = { key: string; value: string; kind: "stated" | "inferred"; confidence: number; source: Source; date: string; status: "active" | "conflict"; conflictWith?: string };
export type Highlight = { text: string; why_today: "due_today" | "unfinished" | "planned_today"; source: Source };
export type Brief = { highlights: Highlight[]; text: string } | null;
export type Consolidation = { entries: MemoryEntry[]; highlights: Highlight[]; method: "llm" | "rule"; warnings: string[] };
export type Coverage = "full" | "partial" | "none";
export type ReviewJournal = { userId: string; date: string; tz: string; status: "ok" | "no_chat" | "partial_read"; attempts: number; coverage: Coverage; entries_written: number; brief: Brief; delivered_to: string[]; method?: "llm" | "rule"; updatedAt: string; unreadable?: string[]; warnings?: string[] };
// ↑ R6 只增了两个可选字段（共享类型契约只允许增可选）：⑥ partial_read 要写明覆盖范围 → unreadable = 读不出的会话 id；warnings = 整合 + 呈现门槛的警告


// R2：复盘取数只依赖这个最小读接口；实现在 ./transcript.ts（R1）
export type { TranscriptLine } from "./transcript.js";
import type { TranscriptLine as _TL } from "./transcript.js";
export interface TranscriptReader {
  list(userId: string): string[];
  /** null = 转写文件缺失或读不出（计入 partial_read） */
  read(userId: string, sessionId: string): _TL[] | null;
}
