import OpenAI from "openai";
import type { ChatMessage, LLMClient, LLMResponse, ToolMode } from "./types.js";
import type { ToolSpec } from "../tools/registry.js";

// 任意 OpenAI-compatible 端点（DashScope / DeepSeek / 智谱 / 豆包 …）。
// 默认「文本协议」模式：模型按 <think>/<tool_call>/<final> 输出，runtime 自己解析。
// 「原生 function calling」模式（传 nativeTools）：工具经 API 的 tools 字段给，模型返回的 tool_calls 原样交给 runtime
// （runtime 把它们转成与文本协议同一形状的 ParsedOutput），历史里的 assistant.tool_calls / tool.tool_call_id 回放时原样发回。

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
  readonly toolMode: ToolMode;
  private client: OpenAI;
  constructor(private o: OpenAICompatibleOptions) {
    this.model = o.model;
    this.toolMode = o.nativeTools ? "native" : "text";
    this.client = new OpenAI({ apiKey: o.apiKey, baseURL: o.baseURL, timeout: o.timeoutMs ?? 60_000, maxRetries: 0 });
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    const native = this.o.nativeTools;
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: this.o.temperature ?? 0.2,
      messages: toWireMessages(messages, this.toolMode),
      ...(native
        ? { tools: native.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters as any } })) }
        : {}),
    });
    const choice = res.choices[0];
    const msg = choice.message;
    const fnCalls = (msg.tool_calls ?? []).filter((c): c is Extract<typeof c, { type: "function" }> => c.type === "function");
    return {
      text: msg.content ?? "",
      usage: res.usage ? { promptTokens: res.usage.prompt_tokens, completionTokens: res.usage.completion_tokens } : undefined,
      nativeToolCalls: fnCalls.map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments })),
    };
  }
}

/**
 * 发给厂商前的消息映射。OpenAI 协议要求 role=tool 的消息必须紧跟一条带 tool_calls 的 assistant 消息，且 tool_call_id 对得上。
 *
 * - 文本协议模式：历史是我们自己的标签文本，没有厂商的 tool_call id，工具结果统一降级为带前缀的 user 消息。
 * - 原生模式（#10）：assistant 消息上的 toolCalls 原样发成 tool_calls，紧跟其后、id 对得上的 tool 消息发成 role=tool + tool_call_id；
 *   对不上的 tool 消息（解析错误回喂、文本模式遗留的历史）仍降级为 user，避免厂商 400。
 * 这是模块五第 1 题「两种工具输出方式差异」在代码里的具体落点。
 */
export function toWireMessages(messages: ChatMessage[], mode: ToolMode) {
  const downgrade = (m: ChatMessage) => ({ role: "user" as const, content: `[工具 ${m.name} 的结果]\n${m.content}` });
  let openIds = new Set<string>();
  return messages.map((m) => {
    if (m.role === "tool") {
      if (mode === "native" && m.toolCallId && openIds.has(m.toolCallId)) return { role: "tool" as const, tool_call_id: m.toolCallId, content: m.content };
      return downgrade(m);
    }
    openIds = new Set(m.role === "assistant" && mode === "native" ? (m.toolCalls ?? []).map((c) => c.id) : []);
    if (m.role === "assistant" && mode === "native" && m.toolCalls?.length) {
      return {
        role: "assistant" as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
      };
    }
    return { role: m.role, content: m.content };
  }) as any;
}
