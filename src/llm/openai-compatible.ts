import OpenAI from "openai";
import type { ChatMessage, LLMClient, LLMResponse } from "./types.js";
import type { ToolSpec } from "../tools/registry.js";

// 任意 OpenAI-compatible 端点（DashScope / DeepSeek / 智谱 / 豆包 …）。
// 默认「文本协议」模式：模型按 <think>/<tool_call>/<final> 输出，runtime 自己解析。
// 可选「原生 function calling」模式：把 tool_calls 转回同一套标签，runtime 与 parser 一行不改。

export interface OpenAICompatibleOptions {
  apiKey: string;
  baseURL: string;
  model: string;
  nativeTools?: ToolSpec[];
  temperature?: number;
  timeoutMs?: number;
}

export class OpenAICompatibleLLM implements LLMClient {
  readonly model: string;
  private client: OpenAI;
  constructor(private o: OpenAICompatibleOptions) {
    this.model = o.model;
    this.client = new OpenAI({ apiKey: o.apiKey, baseURL: o.baseURL, timeout: o.timeoutMs ?? 60_000, maxRetries: 0 });
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    const native = this.o.nativeTools;
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.o.temperature ?? 0.2,
      messages: toWireMessages(messages, !!native),
      ...(native
        ? { tools: native.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters as any } })) }
        : {}),
    });
    const choice = res.choices[0];
    const msg = choice.message;
    let text = msg.content ?? "";
    const fnCalls = (msg.tool_calls ?? []).filter((c): c is Extract<typeof c, { type: "function" }> => c.type === "function");
    if (fnCalls.length) {
      // 原生调用 → 标签协议，让下游走同一条解析路径
      text += fnCalls
        .map((c) => `<tool_call>${JSON.stringify({ name: c.function.name, arguments: safeJson(c.function.arguments) })}</tool_call>`)
        .join("");
    }
    return {
      text,
      usage: res.usage ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens } : undefined,
      nativeToolCalls: fnCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { _raw: s };
  }
}

/**
 * 发给厂商前的消息映射。OpenAI 协议要求 role=tool 的消息必须紧跟一条带 tool_calls 的 assistant 消息，
 * 而我们的历史是自己的标签文本，不带厂商的 tool_call id；为了不让 runtime 依赖任何厂商协议，
 * 这里统一把工具结果降级为带前缀的 user 消息。两种模式（文本协议 / 原生 function calling）都走这条。
 * 这是模块五第 1 题「两种工具输出方式差异」在代码里的具体落点。
 */
function toWireMessages(messages: ChatMessage[], _native: boolean) {
  return messages.map((m) =>
    m.role === "tool" ? { role: "user" as const, content: `[工具 ${m.name} 的结果]\n${m.content}` } : { role: m.role, content: m.content },
  ) as any;
}
