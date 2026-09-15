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
      return `已记住 ${key} = ${value}`;
    },
  };
}
