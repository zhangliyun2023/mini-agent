import type { ToolDefinition } from "./registry.js";
import type { UserMemoryStore } from "../memory/user-memory.js";

// 第四个工具：让模型自己决定什么值得跨 session 记住。
export function createRememberTool(store: UserMemoryStore): ToolDefinition {
  return {
    name: "remember",
    description: "把关于用户的长期信息记下来（称呼、所在城市、偏好等），下次任何会话都能看到。只记稳定事实，不记一次性任务。",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "简短的键，如 name / city / language" },
        value: { type: "string", description: "值" },
      },
      required: ["key", "value"],
    },
    handler: async ({ key, value }, ctx) => {
      store.set(ctx.userId, key, value);
      // 不回显 value：工具结果会进 trace 的 resultPreview，用户内容只留长度
      return `已记住 ${key}（${String(value).length} 字）`;
    },
    // value 是用户内容，trace 里只留长度（拍板③：answer 全文是唯一显式例外，工具 args 走白名单）
    redact: ({ key, value }) => ({ key, value_len: String(value ?? "").length }),
  };
}
