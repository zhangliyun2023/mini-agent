// 工具注册表：每个工具 = 名称 + 描述 + 参数 JSON Schema + handler。
// LLM 只看得到前三样（拼进 system prompt），runtime 负责校验参数再调 handler。

export interface JsonSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; enum?: string[] }>;
  required?: string[];
}

export interface ToolContext {
  /** 当前 session 的可变状态袋，有状态工具（todo）把数据放这里，天然按 session 隔离 */
  sessionState: Record<string, unknown>;
  userId: string;
  sessionId: string;
  /** 当前轮次（runtime 传入；remember 用它记 source，#19 Q3）。直接 invoke 时可不给 */
  turn?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
  handler: (args: Record<string, any>, ctx: ToolContext) => Promise<string>;
  /**
   * 结果精简：工具原始输出可能很长，塞回 context 前先过这一道。
   * 不提供则按默认截断。
   */
  compact?: (raw: string) => string;
  /**
   * 进 trace 前对 args 脱敏（白名单落盘）：用户内容类参数只留长度 / 摘要。
   * 不提供则 args 原样进 trace。只影响 trace，不影响 handler 收到的参数。
   */
  redact?: (args: Record<string, unknown>) => Record<string, unknown>;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  durationMs: number;
}

const DEFAULT_MAX_CHARS = 1500;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(def: ToolDefinition): this {
    if (this.tools.has(def.name)) throw new Error(`工具重名：${def.name}`);
    this.tools.set(def.name, def);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** trace 用：按工具声明脱敏后的 args；未注册或未声明 redact 则原样 */
  redact(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const def = this.tools.get(name);
    return def?.redact ? def.redact(args) : args;
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** 校验参数 → 执行 → 精简。任何失败都变成 ok:false 的结果，不向上抛。 */
  async invoke(name: string, args: Record<string, unknown>, ctx: Partial<ToolContext>): Promise<ToolResult> {
    const started = Date.now();
    const done = (ok: boolean, content: string): ToolResult => ({ ok, content, durationMs: Date.now() - started });

    const def = this.tools.get(name);
    if (!def) return done(false, `工具 "${name}" 未注册。可用工具：${[...this.tools.keys()].join(", ")}`);

    const problem = validateArgs(def.parameters, args);
    if (problem) return done(false, `参数错误：${problem}`);

    const fullCtx: ToolContext = {
      sessionState: ctx.sessionState ?? {},
      userId: ctx.userId ?? "anon",
      sessionId: ctx.sessionId ?? "default",
      turn: ctx.turn,
    };
    try {
      const raw = await def.handler(args, fullCtx);
      const compacted = def.compact ? def.compact(raw) : truncate(raw, DEFAULT_MAX_CHARS);
      return done(true, compacted);
    } catch (e) {
      return done(false, `工具执行失败：${(e as Error).message}`);
    }
  }
}

/** 极简 JSON Schema 校验：只管 required 与顶层类型，够这题用；返回第一条问题描述。 */
export function validateArgs(schema: JsonSchema, args: Record<string, unknown>): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) return `缺少必填参数 "${key}"`;
  }
  for (const [key, val] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) return `未知参数 "${key}"，允许的参数：${Object.keys(schema.properties).join(", ")}`;
    const actual = Array.isArray(val) ? "array" : typeof val;
    const expected = prop.type === "integer" ? "number" : prop.type;
    if (actual !== expected) return `参数 "${key}" 应为 ${prop.type}，实际是 ${actual}`;
    if (prop.enum && !prop.enum.includes(String(val))) return `参数 "${key}" 只能是 ${prop.enum.join(" / ")}`;
  }
  return null;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n…（已截断，原文 ${s.length} 字符）`;
}
