import type { ChatMessage, LLMClient } from "../llm/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { calculatorTool } from "../tools/calculator.js";
import { searchTool } from "../tools/search.js";
import { createTodoTool } from "../tools/todo.js";
import { createRememberTool } from "../tools/remember.js";
import { MemorySessionStore, type SessionStore } from "../session/store.js";
import { MemoryUserMemoryStore, renderMemory, type UserMemoryStore } from "../memory/user-memory.js";
import { assembleMessages, compactSession, DEFAULT_CONTEXT, needsCompaction, stripThink, type ContextOptions } from "../session/context.js";
import { parseAssistantOutput } from "../protocol/parser.js";
import { buildSystemPrompt } from "../protocol/prompt.js";
import { MemoryTraceSink, preview, type TraceEvent, type TraceSink } from "./trace.js";

export interface AgentOptions {
  llm: LLMClient;
  tools?: ToolRegistry;
  sessions?: SessionStore;
  memory?: UserMemoryStore;
  trace?: TraceSink;
  /** 一次用户输入内最多经过多少次 LLM 决策（每次决策可带多个工具调用）——防死循环的安全阀 */
  maxToolSteps?: number;
  /** LLM 调用失败的重试次数 */
  llmRetries?: number;
  context?: Partial<ContextOptions>;
}

export interface RunInput {
  userId: string;
  sessionId: string;
  input: string;
}

export interface RunStep {
  kind: "llm" | "tool";
  detail: string;
}

export interface RunResult {
  answer: string;
  steps: RunStep[];
  stoppedBy: "final" | "max_steps" | "error";
  turn: number;
}

export function defaultTools(memory: UserMemoryStore): ToolRegistry {
  return new ToolRegistry().register(calculatorTool).register(searchTool).register(createTodoTool()).register(createRememberTool(memory));
}

export function createAgent(o: AgentOptions) {
  const memory = o.memory ?? new MemoryUserMemoryStore();
  const tools = o.tools ?? defaultTools(memory);
  const sessions = o.sessions ?? new MemorySessionStore();
  const trace = o.trace ?? new MemoryTraceSink();
  const maxToolSteps = o.maxToolSteps ?? 8;
  const llmRetries = o.llmRetries ?? 2;
  const ctxOpts: ContextOptions = { ...DEFAULT_CONTEXT, ...o.context };

  async function callLLM(messages: ChatMessage[]) {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= llmRetries; attempt++) {
      try {
        return await o.llm.chat(messages);
      } catch (e) {
        lastErr = e;
        if (attempt < llmRetries) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  async function run({ userId, sessionId, input }: RunInput): Promise<RunResult> {
    const startedAt = Date.now();
    const session = sessions.get(userId, sessionId);
    session.turns += 1;
    const turn = session.turns;
    const emit = (event: TraceEvent) => trace.write({ ts: new Date().toISOString(), userId, sessionId, turn, event });
    const steps: RunStep[] = [];

    // 新一轮开始前先看要不要压缩——压的是历史，不碰本轮
    if (needsCompaction(session, ctxOpts)) {
      const r = await compactSession(session, o.llm, ctxOpts);
      emit({ kind: "compact", ...r });
    }

    const systemPrompt = buildSystemPrompt(tools.specs(), renderMemory(memory.load(userId)));
    const working: ChatMessage[] = [{ role: "user", content: input }];
    const toolCtx = { sessionState: session.state, userId, sessionId };

    const finish = (answer: string, stoppedBy: RunResult["stoppedBy"]): RunResult => {
      working.push({ role: "assistant", content: `<final>${answer}</final>` });
      session.history.push(...stripThink(working));
      sessions.save(session);
      emit({ kind: "stop", reason: stoppedBy, totalMs: Date.now() - startedAt });
      return { answer, steps, stoppedBy, turn };
    };

    for (let step = 1; step <= maxToolSteps; step++) {
      const messages = assembleMessages(systemPrompt, session, working);
      const t0 = Date.now();
      let text: string;
      try {
        const res = await callLLM(messages);
        text = res.text;
        emit({ kind: "llm", step, model: o.llm.model, messages: messages.length, promptTokens: res.usage?.promptTokens, completionTokens: res.usage?.completionTokens, durationMs: Date.now() - t0, outputPreview: preview(text) });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        emit({ kind: "llm", step, model: o.llm.model, messages: messages.length, durationMs: Date.now() - t0, outputPreview: "", error: msg });
        return finish(`模型调用失败：${msg}`, "error");
      }
      steps.push({ kind: "llm", detail: preview(text) });

      const parsed = parseAssistantOutput(text);
      if (parsed.errors.length) emit({ kind: "parse_error", step, errors: parsed.errors });
      if (parsed.warnings.length) emit({ kind: "parse_warning", step, warnings: parsed.warnings });

      if (parsed.toolCalls.length === 0) {
        if (parsed.final !== undefined) return finish(parsed.final, "final");
        // 没有工具调用也没有 final：只能是解析错误，把错误回喂让模型重来
        working.push({ role: "assistant", content: text });
        working.push({ role: "tool", name: "parser", toolCallId: `parse-${step}`, content: `你的上一条输出无法解析：${parsed.errors.join("；")}。请按协议重新输出。` });
        continue;
      }

      // 本轮 assistant 消息保留 think，让模型在同一轮里能看见自己的推理；轮次结束时再剥
      working.push({ role: "assistant", content: text });
      if (parsed.errors.length) {
        working.push({ role: "tool", name: "parser", toolCallId: `parse-${step}`, content: parsed.errors.join("；") });
      }
      for (const [i, call] of parsed.toolCalls.entries()) {
        const r = await tools.invoke(call.name, call.arguments, toolCtx);
        const content = r.ok ? r.content : `[error] ${r.content}`;
        working.push({ role: "tool", name: call.name, toolCallId: `${step}-${i}`, content });
        steps.push({ kind: "tool", detail: `${call.name} ${r.ok ? "ok" : "fail"}` });
        emit({ kind: "tool", step, name: call.name, args: call.arguments, ok: r.ok, durationMs: r.durationMs, resultPreview: preview(r.content) });
      }
    }

    const lastTools = working.filter((m) => m.role === "tool").slice(-3).map((m) => `${m.name}: ${preview(m.content, 200)}`).join("\n");
    return finish(`已达到单轮工具调用上限（${maxToolSteps} 次），先把目前拿到的结果给你：\n${lastTools}`, "max_steps");
  }

  return { run, tools, sessions, memory, trace };
}
