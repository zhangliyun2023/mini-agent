import type { ChatMessage, LLMClient, LLMResponse, ToolMode } from "../llm/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { calculatorTool } from "../tools/calculator.js";
import { searchTool } from "../tools/search.js";
import { createTodoTool } from "../tools/todo.js";
import { createRememberTool } from "../tools/remember.js";
import { MemorySessionStore, type SessionStore } from "../session/store.js";
import { MemoryUserMemoryStore, renderMemory, type UserMemoryStore } from "../memory/user-memory.js";
import { assembleMessages, compactSession, DEFAULT_CONTEXT, needsCompaction, stripThink, type ContextOptions } from "../session/context.js";
import { parseAssistantOutput, type ParsedToolCall } from "../protocol/parser.js";
import { buildSystemPrompt } from "../protocol/prompt.js";
import { MemoryTraceSink, newRequestId, preview, type Effect, type LlmTry, type TraceSink } from "./trace.js";
import { classifyLlmError, describeLlmError, isRetryable } from "../llm/errors.js";
import { interpret } from "../machine/interpreter.js";
import { TERMINAL_STOPPED_BY, turnMachine, turnRunnerProtocol, type TurnEvent, type TurnMachine, type TurnState } from "../../contracts/turn.machine.js";

export interface AgentOptions {
  llm: LLMClient;
  tools?: ToolRegistry;
  sessions?: SessionStore;
  memory?: UserMemoryStore;
  trace?: TraceSink;
  /** 一次用户输入内最多经过多少次 LLM 决策（每次决策可带多个工具调用）——防死循环的安全阀 */
  maxToolSteps?: number;
  /** LLM 调用失败的重试次数（只对可重试类生效：限流 / 服务端 / 超时 / 网络 / 未知；认证 / 请求格式 / 不存在一次即终） */
  llmRetries?: number;
  /** 重试前的等待（默认真等 setTimeout；测试注入成记录用的假函数，不真等） */
  sleep?: (ms: number) => Promise<void>;
  context?: Partial<ContextOptions>;
  /**
   * 表里没列的 (状态, 事件) 怎么处理（D8）：
   *   "error" = 记 trace，本轮以 error 终态结束（默认；运行时不读任何测试环境变量，#11）
   *   "throw" = 记 trace 后抛出，让测试直接失败（测试需要时显式传）
   */
  unknownTransition?: "error" | "throw";
  /** 只给测试用：注入一张残缺的表，验证闸真的拦得住 */
  machine?: TurnMachine;
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
  /** 用户/会话/轮次，与 trace 记录上的 trace_id 相同 */
  traceId: string;
}

/** 重试退避基数：第 n 次失败后等 300ms × 2^n（n 从 0 起） */
const BACKOFF_BASE_MS = 300;

/** 模型调用重试耗尽或遇到不可重试错误：message 是给用户看的一行（含类别与状态码），tries 是逐次尝试明细（进 trace） */
class LlmCallFailed extends Error {
  constructor(message: string, readonly tries: LlmTry[]) {
    super(message);
    this.name = "LlmCallFailed";
  }
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
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const ctxOpts: ContextOptions = { ...DEFAULT_CONTEXT, ...o.context };
  const unknownTransition = o.unknownTransition ?? "error";
  const machine = o.machine ?? turnMachine;
  const protocol = turnRunnerProtocol;
  /** 工具给法由 LLM 客户端决定（#10）：原生模式下 system prompt 不教标签协议 */
  const mode: ToolMode = o.llm.toolMode === "native" ? "native" : "text";

  /**
   * 模型调用 + 按错误类型重试（#11）：可重试类指数退避 300ms × 2^n，不可重试类一次即终。
   * 成功返回 {res, attempts, tries}；全部失败抛 LlmCallFailed，把逐次尝试明细带给 trace。
   */
  async function callLLM(messages: ChatMessage[]): Promise<{ res: LLMResponse; attempts: number; tries: LlmTry[] }> {
    const tries: LlmTry[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        return { res: await o.llm.chat(messages), attempts: attempt + 1, tries };
      } catch (e) {
        const errorClass = classifyLlmError(e);
        const again = isRetryable(errorClass) && attempt < llmRetries;
        const waitMs = again ? BACKOFF_BASE_MS * 2 ** attempt : 0;
        tries.push({ n: attempt + 1, errorClass, waitMs });
        if (!again) throw new LlmCallFailed(describeLlmError(e, errorClass), tries);
        await sleep(waitMs);
      }
    }
  }

  async function run({ userId, sessionId, input }: RunInput): Promise<RunResult> {
    const startedAt = Date.now();
    const session = sessions.get(userId, sessionId);
    session.turns += 1;
    const turn = session.turns;
    const traceId = `${userId}/${sessionId}/${turn}`;
    const steps: RunStep[] = [];

    let state: TurnState = machine.initial;
    let facts = protocol.initialFacts(maxToolSteps);
    let seq = 0;
    /** 在转移之前发生、要挂到下一条转移上的副作用（轮首的 compact 与记忆截断 warning） */
    let pendingEffects: Effect[] = [];
    let result: RunResult | undefined;

    // 新一轮开始前先看要不要压缩——压的是历史，不碰本轮
    if (needsCompaction(session, ctxOpts)) {
      const r = await compactSession(session, o.llm, ctxOpts);
      pendingEffects.push({ kind: "compact", ...r });
    }

    const memoryBlock = renderMemory(memory.load(userId), ctxOpts.memoryMaxChars);
    if (memoryBlock.truncated) pendingEffects.push({ kind: "memory_truncated", ...memoryBlock.truncated, limit: ctxOpts.memoryMaxChars });
    const systemPrompt = buildSystemPrompt(tools.specs(), memoryBlock.block, mode);
    const working: ChatMessage[] = [{ role: "user", content: input }];
    const toolCtx = { sessionState: session.state, userId, sessionId };
    let pendingCalls: ParsedToolCall[] = [];

    const maxStepsAnswer = () => {
      const lastTools = working.filter((m) => m.role === "tool").slice(-3).map((m) => `${m.name}: ${preview(m.content, 200)}`).join("\n");
      return `已达到单轮工具调用上限（${maxToolSteps} 次），先把目前拿到的结果给你：\n${lastTools}`;
    };

    /**
     * 闸：先解释——allowed 才执行 apply 里的副作用；blocked（rejected 行）只跑 onBlocked（回喂消息，状态不变）；
     * noop 什么都不跑；落到终态就在同一条记录里收尾（写历史、存盘、answer 副作用）。
     * unknown：不执行任何副作用，记 trace，本轮强制 error 终态（或按配置抛出）。
     */
    function transition(event: TurnEvent, effects: Effect[], opts: { apply?: () => void; onBlocked?: () => void; final?: string; error?: string } = {}) {
      facts = protocol.advance(facts, event);
      const t = interpret(machine, state, event, facts);
      if (t.status === "allowed") opts.apply?.();
      if (t.status === "blocked") opts.onBlocked?.();
      const to: TurnState = t.status === "unknown" ? "error" : t.to;
      const all = [...pendingEffects, ...effects];
      pendingEffects = [];
      if (machine.isTerminal(to)) {
        const stoppedBy = TERMINAL_STOPPED_BY[to as keyof typeof TERMINAL_STOPPED_BY];
        const answer =
          t.status === "unknown" ? `运行时遇到未建模的状态转移：${state} + ${event}（${t.reason}）` :
          to === "done" ? (opts.final ?? "") :
          to === "max_steps" ? maxStepsAnswer() :
          (opts.error ?? "未知错误");
        working.push({ role: "assistant", content: `<final>${answer}</final>` });
        session.history.push(...stripThink(working));
        sessions.save(session);
        all.push({ kind: "answer", stoppedBy, answer, totalMs: Date.now() - startedAt });
        result = { answer, steps, stoppedBy, turn, traceId };
      }
      seq += 1;
      trace.write({ ts: new Date().toISOString(), trace_id: traceId, feature: machine.feature, userId, sessionId, turn, seq, step: facts.step, from: state, to, event, status: t.status, reason: t.reason, reject_code: t.reject_code, transition: t.row?.id ?? null, effects: all });
      if (t.status === "unknown" && unknownTransition === "throw") throw new Error(`未建模的状态转移：${state} + ${event}（${t.reason}）`);
      state = to;
      return t;
    }

    while (!machine.isTerminal(state)) {
      if (state === "deciding") {
        const messages = assembleMessages(systemPrompt, session, working);
        const t0 = Date.now();
        const step = facts.step + 1;
        const request_id = newRequestId();
        let res: LLMResponse;
        let attempts: number;
        let tries: LlmTry[];
        try {
          ({ res, attempts, tries } = await callLLM(messages));
        } catch (e) {
          const failed = e instanceof LlmCallFailed ? e : new LlmCallFailed(describeLlmError(e), [{ n: 1, errorClass: classifyLlmError(e), waitMs: 0 }]);
          transition("LLM_FAILED", [{ kind: "llm", request_id, step, model: o.llm.model, messages: messages.length, attempts: failed.tries.length, tries: failed.tries, durationMs: Date.now() - t0, outputPreview: "", error: failed.message }], { error: `模型调用失败：${failed.message}` });
          continue;
        }
        const text = res.text;
        transition("LLM_OK", [{ kind: "llm", request_id, step, model: o.llm.model, messages: messages.length, attempts, tries, promptTokens: res.usage?.promptTokens, completionTokens: res.usage?.completionTokens, durationMs: Date.now() - t0, outputPreview: preview(text) }]);
        if (state !== "deciding") continue;
        steps.push({ kind: "llm", detail: preview(text) });

        const parsed = parseAssistantOutput(text);
        const parseEffect: Effect = { kind: "parse", step, toolCalls: parsed.toolCalls.length, hasFinal: parsed.final !== undefined, errors: parsed.errors, warnings: parsed.warnings };
        if (parsed.toolCalls.length === 0) {
          if (parsed.final !== undefined) {
            transition("PARSED_FINAL", [parseEffect], { final: parsed.final });
          } else {
            // 没有工具调用也没有 final：只能是解析错误。表里这是 rejected 行 → blocked，回喂放在 onBlocked 里；
            // 步数用尽时命中的是无守卫兜底行（allowed → max_steps），不回喂
            transition("PARSED_ERROR", [parseEffect], {
              onBlocked: () => {
                working.push({ role: "assistant", content: text });
                working.push({ role: "tool", name: "parser", toolCallId: `parse-${step}`, content: `你的上一条输出无法解析：${parsed.errors.join("；")}。请按协议重新输出。` });
              },
            });
          }
          continue;
        }
        transition("PARSED_TOOL_CALLS", [parseEffect], {
          apply: () => {
            // 本轮 assistant 消息保留 think，让模型在同一轮里能看见自己的推理；轮次结束时再剥
            working.push({ role: "assistant", content: text });
            if (parsed.errors.length) working.push({ role: "tool", name: "parser", toolCallId: `parse-${step}`, content: parsed.errors.join("；") });
            pendingCalls = parsed.toolCalls;
          },
        });
        continue;
      }

      if (state === "executing_tools") {
        // 工具只在这个状态里跑；进到这里的唯一通道是 allowed 的 PARSED_TOOL_CALLS（P0 不变量 ①）
        const effects: Effect[] = [];
        for (const [i, call] of pendingCalls.entries()) {
          const request_id = newRequestId();
          const r = await tools.invoke(call.name, call.arguments, toolCtx);
          const content = r.ok ? r.content : `[error] ${r.content}`;
          working.push({ role: "tool", name: call.name, toolCallId: `${facts.step}-${i}`, content });
          steps.push({ kind: "tool", detail: `${call.name} ${r.ok ? "ok" : "fail"}` });
          effects.push({ kind: "tool", request_id, step: facts.step, name: call.name, args: tools.redact(call.name, call.arguments), ok: r.ok, durationMs: r.durationMs, resultPreview: preview(r.content) });
        }
        pendingCalls = [];
        transition("TOOLS_DONE", effects);
        continue;
      }

      // 不该到这里：状态集合就这五个。走闸让它以 unknown 被记录下来。
      transition("LLM_FAILED", [], { error: `runtime 处于未知状态 ${state}` });
    }

    return result!;
  }

  return { run, tools, sessions, memory, trace };
}
