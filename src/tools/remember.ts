import type { ToolDefinition } from "./registry.js";
import { todayISO, type UserMemoryStore } from "../memory/user-memory.js";

// 第四个工具：让模型自己决定什么值得跨 session 记住。
// 写的是 stated 条目（用户亲口说的：confidence 1，source = 当前会话与轮次，#19 Q3）；同 key 不同值不覆盖，标 conflict 等用户确认。
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
      const stored = store.upsert(ctx.userId, {
        key: String(key),
        value: String(value),
        kind: "stated",
        confidence: 1,
        source: { sessionId: ctx.sessionId, turn: ctx.turn ?? 0 },
        date: todayISO(),
        status: "active",
      });
      // 不回显 value：工具结果会进 trace 的 resultPreview，用户内容只留长度
      const n = String(value).length;
      return stored.status === "conflict" ? `已记下 ${key}（${n} 字），与之前记的值不同：旧值保留，新值标为待确认` : `已记住 ${key}（${n} 字）`;
    },
    // value 是用户内容，trace 里只留长度（拍板③：answer 全文是唯一显式例外，工具 args 走白名单）
    redact: ({ key, value }) => ({ key, value_len: String(value ?? "").length }),
  };
}
