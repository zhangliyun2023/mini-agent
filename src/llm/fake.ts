import type { ChatMessage, LLMClient, LLMResponse, ToolMode } from "./types.js";

// 脚本化 LLM：按顺序吐预设文本，同时记录每次收到的 messages，测试用它断言「context 里放了什么」。
// { native: true } 时模拟原生 function calling 客户端：toolMode = "native"。
export class FakeLLM implements LLMClient {
  readonly model = "fake";
  readonly toolMode: ToolMode;
  readonly calls: ChatMessage[][] = [];
  private queue: Array<string | ((messages: ChatMessage[]) => string)>;

  constructor(script: Array<string | ((messages: ChatMessage[]) => string)>, opts: { native?: boolean } = {}) {
    this.queue = [...script];
    this.toolMode = opts.native ? "native" : "text";
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLLM 脚本用完了，还在被调用");
    const text = typeof next === "function" ? next(messages) : next;
    return { text, usage: { promptTokens: JSON.stringify(messages).length / 4, completionTokens: text.length / 4 } };
  }
}
