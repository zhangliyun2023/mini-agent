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
const TOOL_CALL_RE = /<(tool_call|invoke|function_call)>([\s\S]*?)<\/\1>/g;
// 裸文本里出现 {"name":…,"arguments":…}：模型想调工具但忘了打标签，不能当最终答案
const BARE_CALL_RE = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/;
const FINAL_RE = /<final>([\s\S]*?)<\/final>/;

export function parseAssistantOutput(text: string): ParsedOutput {
  const errors: string[] = [];
  const warnings: string[] = [];
  const think = THINK_RE.exec(text)?.[1]?.trim();

  const toolCalls: ParsedToolCall[] = [];
  for (const m of text.matchAll(TOOL_CALL_RE)) {
    if (m[1] !== "tool_call") warnings.push(`模型用了 <${m[1]}> 标签，已按 <tool_call> 处理`);
    const raw = m[2].trim();
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      errors.push(`tool_call 不是合法 JSON：${(e as Error).message}；原文：${raw.slice(0, 200)}`);
      continue;
    }
    if (!obj || typeof obj !== "object" || typeof (obj as any).name !== "string") {
      errors.push(`tool_call 缺少 name 字段：${raw.slice(0, 200)}`);
      continue;
    }
    const args = (obj as any).arguments;
    toolCalls.push({
      name: (obj as any).name,
      arguments: args && typeof args === "object" ? args : {},
    });
  }

  const finalMatch = FINAL_RE.exec(text)?.[1]?.trim();
  let final: string | undefined;
  if (toolCalls.length > 0) {
    if (finalMatch !== undefined) errors.push("同时输出了 tool_call 和 final，已忽略 final：请先等工具结果再给最终答案");
  } else if (finalMatch !== undefined) {
    final = finalMatch;
  } else if (errors.length === 0) {
    const bare = text.replace(THINK_RE, "").trim();
    if (BARE_CALL_RE.test(bare)) {
      errors.push("看起来你想调用工具，但没有用 <tool_call>…</tool_call> 包起来，请用标签重新输出");
    } else if (bare) {
      // 完全没有标签：把去掉 think 后的裸文本当最终答案
      final = bare;
    }
  }

  return { think, toolCalls, final, errors, warnings };
}
