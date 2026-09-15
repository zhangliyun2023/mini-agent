// 解析模型输出。协议是三段标签：
//   <think>…</think>          思考过程（可选）
//   <tool_call>{json}</tool_call>  工具调用（可多个）
//   <final>…</final>          最终答案
// 模型并不总守协议，所以这里的原则是：能救的救，救不了的记进 errors 回喂给模型，绝不抛异常。

export interface ParsedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedOutput {
  think?: string;
  toolCalls: ParsedToolCall[];
  final?: string;
  /** 解析阶段发现的问题，runtime 会把它们作为 tool 消息喂回模型让其纠正 */
  errors: string[];
  /** 救回来了但不合协议的地方，只进 trace，不回喂 */
  warnings: string[];
}

const THINK_RE = /<think>([\s\S]*?)<\/think>/;
// 实测 qwen3-max 会把标签写成 Anthropic 风格的 <invoke>，或 <function_call>；这些别名一并接住
// 只认开标签，JSON 靠配平大括号截取——2026-09-15 实测模型会把闭合标签写成 <tool_call>，按闭合标签切会把两个调用吞成一块
const TOOL_OPEN_RE = /<(tool_call|invoke|function_call)>/g;
// 2026-09-15 live 暴露的第四种变体（#4，原生模式下模型没走 tool_calls 直接吐文本）：
//   <function=NAME><parameter=K>V</parameter>…</function>
const FUNCTION_BLOCK_RE = /<function=([\w.-]+)>([\s\S]*?)<\/function>/g;
const PARAMETER_RE = /<parameter=([\w.-]+)>([\s\S]*?)<\/parameter>/g;
// 裸文本里出现 {"name":…,"arguments":…}：模型想调工具但忘了打标签，不能当最终答案
const BARE_CALL_RE = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/;
// 残缺的 <function=…> / <parameter=…> 同理：像在调工具，不能当最终答案
const BARE_FUNCTION_RE = /<(function|parameter)=[\w.-]+>/;
// 实测会出现 <final><final>… 与没有闭合的 <final>…：捕到闭合或文末为止，再剥掉重复的开标签
const FINAL_RE = /<final>([\s\S]*?)(?:<\/final>|$)/;
const stripFinalTags = (v: string) => v.replace(/^(\s*<final>)+/, "").replace(/(<\/final>\s*)+$/, "").trim();

/** 从 start 起找第一个 { 并截取配平的 JSON 对象（考虑字符串与转义）；返回 null 表示没配平 */
function extractJsonObject(text: string, start: number): { raw: string; end: number } | null {
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { raw: text.slice(open, i + 1), end: i + 1 };
    }
  }
  return null;
}

/** <parameter> 里的值都是文本；数字与布尔按原生 function calling 的习惯还原成对应类型 */
function coerceParam(raw: string): unknown {
  const v = raw.trim();
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true" || v === "false") return v === "true";
  return v;
}

export function parseAssistantOutput(text: string): ParsedOutput {
  const errors: string[] = [];
  const warnings: string[] = [];
  const think = THINK_RE.exec(text)?.[1]?.trim();

  // 两种写法都可能出现，按在原文里的位置排序，保证多次调用的顺序
  const found: Array<{ index: number; call?: ParsedToolCall; error?: string }> = [];
  for (const m of text.matchAll(TOOL_OPEN_RE)) {
    if (m[1] !== "tool_call") warnings.push(`模型用了 <${m[1]}> 标签，已按 <tool_call> 处理`);
    const after = m.index! + m[0].length;
    const nextOpen = text.slice(after).search(TOOL_OPEN_RE);
    const segment = text.slice(after, nextOpen < 0 ? undefined : after + nextOpen);
    if (segment.trim() === "" || segment.trim().startsWith("</")) {
      // 开标签后面紧跟另一个开标签或只有闭合标签：多半是把 </tool_call> 写成了 <tool_call>，不是一次调用
      warnings.push("出现了多余的 <tool_call> 标签（疑似闭合标签写错），已忽略");
      continue;
    }
    const ext = extractJsonObject(segment, 0);
    if (!ext || segment.slice(0, segment.indexOf("{")).trim() !== "") {
      found.push({ index: m.index!, error: `tool_call 不是合法 JSON：大括号不配平或标签内不是 JSON；原文：${segment.trim().slice(0, 200)}` });
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(ext.raw);
    } catch (e) {
      found.push({ index: m.index!, error: `tool_call 不是合法 JSON：${(e as Error).message}；原文：${ext.raw.slice(0, 200)}` });
      continue;
    }
    if (!obj || typeof obj !== "object" || typeof (obj as any).name !== "string") {
      found.push({ index: m.index!, error: `tool_call 缺少 name 字段：${ext.raw.slice(0, 200)}` });
      continue;
    }
    const args = (obj as any).arguments;
    found.push({ index: m.index!, call: { name: (obj as any).name, arguments: args && typeof args === "object" ? args : {} } });
  }
  for (const m of text.matchAll(FUNCTION_BLOCK_RE)) {
    warnings.push(`模型用了 <function=${m[1]}> 标签，已按 <tool_call> 处理`);
    const args: Record<string, unknown> = {};
    for (const p of m[2].matchAll(PARAMETER_RE)) args[p[1]] = coerceParam(p[2]);
    found.push({ index: m.index!, call: { name: m[1], arguments: args } });
  }
  found.sort((a, b) => a.index - b.index);
  const toolCalls = found.flatMap((f) => (f.call ? [f.call] : []));
  errors.push(...found.flatMap((f) => (f.error ? [f.error] : [])));

  const finalRaw = FINAL_RE.exec(text)?.[1];
  const finalMatch = finalRaw === undefined ? undefined : stripFinalTags(finalRaw);
  let final: string | undefined;
  if (toolCalls.length > 0) {
    if (finalMatch !== undefined) errors.push("同时输出了 tool_call 和 final，已忽略 final：请先等工具结果再给最终答案");
  } else if (finalMatch !== undefined) {
    final = finalMatch;
  } else if (errors.length === 0) {
    const bare = text.replace(THINK_RE, "").trim();
    if (BARE_CALL_RE.test(bare) || BARE_FUNCTION_RE.test(bare)) {
      errors.push("看起来你想调用工具，但没有用 <tool_call>…</tool_call> 包起来，请用标签重新输出");
    } else if (bare) {
      // 完全没有标签：把去掉 think 后的裸文本当最终答案
      final = bare;
    }
  }

  return { think, toolCalls, final, errors, warnings };
}
