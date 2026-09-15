// LLM 抽象：runtime 只依赖这个接口，真实 API 与测试用的脚本化 LLM 都实现它。

export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  /** role=tool 时对应的调用 id，便于对齐 */
  toolCallId?: string;
  /** role=tool 时的工具名 */
  name?: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LLMResponse {
  /** 模型原始文本输出（自定义协议由 parser 解析） */
  text: string;
  usage?: LLMUsage;
  /** 原生 function calling 模式下，直接给出的工具调用（可选适配器） */
  nativeToolCalls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface LLMClient {
  readonly model: string;
  chat(messages: ChatMessage[], opts?: { tools?: unknown[]; temperature?: number }): Promise<LLMResponse>;
}
