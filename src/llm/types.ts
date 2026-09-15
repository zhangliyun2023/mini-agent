// LLM 抽象：runtime 只依赖这个接口，真实 API 与测试用的脚本化 LLM 都实现它。

export type Role = "system" | "user" | "assistant" | "tool";

/** 工具调用的两种给法：文本协议（模型按 <tool_call> 标签输出）/ 原生 function calling（走 API 的 tools 字段） */
export type ToolMode = "text" | "native";

/** 原生模式下 assistant 消息携带的一次工具调用；arguments 是厂商给的原始 JSON 字符串，回放时原样发回 */
export interface ToolCallRef {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** role=tool 时对应的调用 id，便于对齐；原生模式下就是厂商的 tool_call id */
  toolCallId?: string;
  /** role=tool 时的工具名 */
  name?: string;
  /** role=assistant 且原生模式时：模型这一步发出的工具调用（文本模式不设，调用在 content 的标签里） */
  toolCalls?: ToolCallRef[];
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
  nativeToolCalls?: ToolCallRef[];
}

export interface LLMClient {
  readonly model: string;
  /** 缺省 "text"。runtime 据此决定 system prompt 教不教标签协议、历史用什么形状 */
  readonly toolMode?: ToolMode;
  chat(messages: ChatMessage[], opts?: { tools?: unknown[]; temperature?: number }): Promise<LLMResponse>;
}
