import type { ChatMessage, LLMClient, LLMResponse } from "./types.js";

// 脚本化 LLM：按顺序吐预设文本，同时记录每次收到的 messages，测试用它断言「context 里放了什么」。
export class FakeLLM implements LLMClient {
  readonly model = "fake";
  readonly calls: ChatMessage[][] = [];
  private queue: Array<string | ((messages: ChatMessage[]) => string)>;

  constructor(script: Array<string | ((messages: ChatMessage[]) => string)>) {
    this.queue = [...script];
  }

  async chat(messages: ChatMessage[]): Promise<LLMResponse> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const next = this.queue.shift();
    if (next === undefined) throw new Error("FakeLLM 脚本用完了，还在被调用");
    const text = typeof next === "function" ? next(messages) : next;
    return { text, usage: { promptTokens: JSON.stringify(messages).length / 4, completionTokens: text.length / 4 } };
  }
}
