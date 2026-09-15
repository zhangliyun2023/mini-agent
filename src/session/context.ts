import type { ChatMessage, LLMClient } from "../llm/types.js";
import type { Session } from "./store.js";

// context 管理的三条规则：
// 1. 进 context 的是：system、（压缩摘要）、历史用户输入、历史工具调用 + 精简后的工具结果、历史最终答案、本轮全部消息。
// 2. 历史轮的 <think> 在轮次结束时剥掉——思考过程只对当轮有用，留着只会占位。
// 3. 超阈值时把最老的部分压成一条摘要，最近几轮保留原文，保证追问仍然有上下文可接。

export interface ContextOptions {
  /** history 里最多保留多少条消息，超过触发压缩 */
  maxHistoryMessages: number;
  /** history 总字符数上限（粗略代替 token 数），超过触发压缩 */
  maxHistoryChars: number;
  /** 压缩时保留最近多少条消息原文 */
  keepRecentMessages: number;
  /**
   * system prompt 里记忆块的字符上限（与 maxHistoryChars 同一把尺子）。超限按写入顺序保留最新的条目，截断事实记 trace。
   * 选字符数而不是条目数：预算单位本来就是字符，几条长 value 就能撑爆条目数上限却仍「合规」；字符上限直接约束的就是占用。
   * 默认 = maxHistoryChars 的 10%。
   */
  memoryMaxChars: number;
}

export const DEFAULT_CONTEXT: ContextOptions = {
  maxHistoryMessages: 40,
  maxHistoryChars: 12_000,
  keepRecentMessages: 12,
  memoryMaxChars: 1_200,
};

const THINK_BLOCK = /<think>[\s\S]*?<\/think>\s*/g;

/** 轮次结束后调用：剥掉 assistant 消息里的思考过程 */
export function stripThink(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.role === "assistant" ? { ...m, content: m.content.replace(THINK_BLOCK, "").trim() } : m));
}

export function needsCompaction(session: Session, opts: ContextOptions): boolean {
  const chars = session.history.reduce((n, m) => n + m.content.length, 0);
  return session.history.length > opts.maxHistoryMessages || chars > opts.maxHistoryChars;
}

export interface CompactionResult {
  before: number;
  after: number;
  method: "llm" | "rule";
}

/**
 * 把 history 的老部分压成摘要，追加到 session.summary；最近 keepRecentMessages 条保留。
 * 切点会对齐到 user 消息，避免把一轮 tool_call/tool 对话从中间切断。
 */
export async function compactSession(session: Session, llm: LLMClient, opts: ContextOptions): Promise<CompactionResult> {
  const before = session.history.length;
  let cut = Math.max(0, before - opts.keepRecentMessages);
  while (cut > 0 && cut < before && session.history[cut].role !== "user") cut--;
  const old = session.history.slice(0, cut);
  if (old.length === 0) return { before, after: before, method: "rule" };

  let summary: string;
  let method: CompactionResult["method"];
  try {
    summary = await summarizeWithLLM(old, llm, session.summary);
    method = "llm";
  } catch {
    summary = summarizeByRule(old, session.summary);
    method = "rule";
  }
  session.summary = summary;
  session.history = session.history.slice(cut);
  return { before, after: session.history.length, method };
}

async function summarizeWithLLM(old: ChatMessage[], llm: LLMClient, prev?: string): Promise<string> {
  const transcript = old.map((m) => `[${m.role}${m.name ? ":" + m.name : ""}] ${m.content}`).join("\n");
  const res = await llm.chat([
    {
      role: "system",
      content:
        "你是对话压缩器。把下面的对话压成一段要点式摘要，只保留：用户提过的目标与约束、已经查到/算出的关键结果、未完成的事项、用户偏好。不要评论，不要加标签，200 字以内。",
    },
    { role: "user", content: (prev ? `此前摘要：\n${prev}\n\n新增对话：\n` : "") + transcript },
  ]);
  const text = res.text.replace(THINK_BLOCK, "").replace(/<\/?final>/g, "").trim();
  if (!text) throw new Error("空摘要");
  return text;
}

/** 规则兜底：保留每条用户原话和每条最终答案的首句，丢掉工具中间过程 */
export function summarizeByRule(old: ChatMessage[], prev?: string): string {
  const lines: string[] = [];
  for (const m of old) {
    if (m.role === "user") lines.push(`用户：${m.content.slice(0, 80)}`);
    else if (m.role === "assistant" && !m.content.includes("<tool_call>")) lines.push(`助手：${m.content.split(/[。\n]/)[0].slice(0, 80)}`);
  }
  return [prev, ...lines].filter(Boolean).join("\n");
}

/** 组装一次 LLM 调用的完整消息列表 */
export function assembleMessages(systemPrompt: string, session: Session, working: ChatMessage[]): ChatMessage[] {
  const msgs: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  if (session.summary) msgs.push({ role: "system", content: `此前对话摘要（已压缩）：\n${session.summary}` });
  msgs.push(...session.history, ...working);
  return msgs;
}
