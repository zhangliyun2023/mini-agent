import type { ChatMessage, LLMClient, LLMResponse, ToolCallRef, ToolMode } from "./types.js";

/** 原生分支的脚本项：模拟厂商返回 tool_calls（arguments 可给对象或原始 JSON 串；id 不给则自动编 call_N） */
export interface NativeReply {
  content?: string;
  toolCalls: Array<{ id?: string; name: string; arguments: Record<string, unknown> | string }>;
}
type Reply = string | NativeReply;
type ScriptItem = Reply | ((messages: ChatMessage[]) => Reply);

// 脚本化 LLM：按顺序吐预设文本，同时记录每次收到的 messages，测试用它断言「context 里放了什么」。
// { native: true } 时模拟原生 function calling 客户端：toolMode = "native"，脚本项可以是 { toolCalls: [...] }，
// 返回的是 nativeToolCalls（不再是标签文本），用来断言下一次请求里 assistant.tool_calls / tool.tool_call_id 的对应关系。
export class FakeLLM implements LLMClient {
  readonly model = "fake";
  readonly toolMode: ToolMode;
  readonly calls: ChatMessage[][] = [];
  private queue: ScriptItem[];
  private nextId = 0;

  constructor(script: ScriptItem[], opts: { native?: boolean } = {}) {
    this.queue = [...script];
    this.toolMode = opts.native ? "native" : "text";
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLLM 脚本用完了，还在被调用");
    const reply = typeof next === "function" ? next(messages) : next;
    const usage = (text: string) => ({ promptTokens: JSON.stringify(messages).length / 4, completionTokens: text.length / 4 });
    if (typeof reply === "string") return { text: reply, usage: usage(reply) };
    if (this.toolMode !== "native") throw new Error("FakeLLM 文本模式的脚本项只能是字符串；要用 { toolCalls } 请传 { native: true }");
    const nativeToolCalls: ToolCallRef[] = reply.toolCalls.map((c) => ({
      id: c.id ?? `call_${++this.nextId}`,
      name: c.name,
      arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments),
    }));
    const text = reply.content ?? "";
    return { text, usage: usage(text), nativeToolCalls };
  }
}
