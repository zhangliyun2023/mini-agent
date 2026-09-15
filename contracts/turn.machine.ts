import { defineMachine } from "../src/machine/interpreter.js";

// ① 轮循环（turn）状态表——这张表就是 loop 的控制流（docs/product/SPEC-state-machines.md §3）。
// runtime 每一步先 interpret：allowed 才执行副作用，rejected 行命中 = blocked（只回喂、状态不变），noop 不跑；未列组合 = unknown → 本轮 error 终态。

export type TurnState = "deciding" | "executing_tools" | "done" | "max_steps" | "error";
export type TurnEvent = "LLM_OK" | "LLM_FAILED" | "PARSED_TOOL_CALLS" | "PARSED_FINAL" | "PARSED_ERROR" | "TOOLS_DONE";
/** facts 只有机器自己维护的两个数：本轮已发出的模型调用次数、上限 */
export interface TurnFacts {
  step: number;
  maxSteps: number;
}

export const TURN_STATES: readonly TurnState[] = ["deciding", "executing_tools", "done", "max_steps", "error"];
export const TURN_TERMINAL: readonly TurnState[] = ["done", "max_steps", "error"];
export const TURN_EVENTS: readonly TurnEvent[] = ["LLM_OK", "LLM_FAILED", "PARSED_TOOL_CALLS", "PARSED_FINAL", "PARSED_ERROR", "TOOLS_DONE"];

/** 终态 ↔ RunResult.stoppedBy 的一一对应（P0 不变量 ③ 的依据） */
export const TERMINAL_STOPPED_BY = { done: "final", max_steps: "max_steps", error: "error" } as const;

const LOOP = "test/unit/agent-loop.test.ts";

export const turnMachine = defineMachine<TurnState, TurnEvent, TurnFacts>({
  feature: "turn",
  anchor: "docs/SPEC.md#实现决策 → 循环",
  initial: "deciding",
  states: TURN_STATES,
  terminal: TURN_TERMINAL,
  events: TURN_EVENTS,
  guards: {
    hasStepsLeft: (f) => f.step < f.maxSteps,
  },
  rows: [
    {
      id: "t-llm-ok", from: "deciding", event: "LLM_OK", to: "deciding", kind: "noop", priority: "P0",
      reason: "模型返回了文本，状态不变，进入解析", effects: ["compact", "llm"],
      covered_by: [`${LOOP}::不需要工具时直接回复，只调一次 LLM`],
    },
    {
      id: "t-llm-failed", from: "deciding", event: "LLM_FAILED", to: "error", kind: "allowed", priority: "P0",
      reason: "重试用尽仍失败，以可读错误结束本轮", effects: ["compact", "llm", "answer"],
      covered_by: [`${LOOP}::LLM 调用抛异常时返回可读错误，不让进程崩`],
    },
    {
      id: "t-final", from: "deciding", event: "PARSED_FINAL", to: "done", kind: "allowed", priority: "P0",
      reason: "无工具调用且有 final：本轮结束", effects: ["parse", "answer"],
      covered_by: [`${LOOP}::不需要工具时直接回复，只调一次 LLM`],
    },
    {
      id: "t-tools", from: "deciding", event: "PARSED_TOOL_CALLS", to: "executing_tools", kind: "allowed", priority: "P0",
      reason: "解析出工具调用，进入执行；工具只在 executing_tools 里跑", effects: ["parse"],
      covered_by: [`${LOOP}::调用工具：结果以 tool 消息回填后模型再给最终答案`],
    },
    {
      id: "t-parse-error", from: "deciding", event: "PARSED_ERROR", to: "deciding", kind: "rejected", reject_code: "PARSE_ERROR", guard: "hasStepsLeft", priority: "P0",
      reason: "解析失败且还有步数：本步被拦下（blocked），把错误当 tool 消息回喂让模型重来；不执行任何工具", effects: ["parse"],
      covered_by: [`${LOOP}::模型输出坏 JSON 时，把解析错误当 tool 消息回喂，让模型自己纠正`],
    },
    {
      id: "t-parse-error-cap", from: "deciding", event: "PARSED_ERROR", to: "max_steps", kind: "allowed", priority: "P0",
      reason: "解析失败且步数用尽：交还已有结果", effects: ["parse", "answer"],
      covered_by: [`${LOOP}::模型连续输出无法解析的内容直到步数上限，以 max_steps 结束`],
    },
    {
      id: "t-tools-done", from: "executing_tools", event: "TOOLS_DONE", to: "deciding", kind: "allowed", guard: "hasStepsLeft", priority: "P0",
      reason: "工具结果已回填，还有步数：回到模型决策", effects: ["tool"],
      covered_by: [`${LOOP}::调用工具：结果以 tool 消息回填后模型再给最终答案`],
    },
    {
      id: "t-tools-done-cap", from: "executing_tools", event: "TOOLS_DONE", to: "max_steps", kind: "allowed", priority: "P0",
      reason: "工具结果已回填但步数用尽：以「已达上限 + 最近三条工具结果」结束。上限在工具跑完后才拦（拍板②）：把结果交还用户比省一次工具调用更有价值", effects: ["tool", "answer"],
      covered_by: [`${LOOP}::模型一直调工具时，到达单轮最大步数就停下并把已有信息交还用户`],
    },
  ],
  invariants: [
    {
      id: "no_tool_after_parse_error", priority: "P0", status: "enforced",
      text: "无工具执行于解析失败之后：tool 副作用只出现在 executing_tools 发出的 TOOLS_DONE 转移上，且其前一条必是 allowed 的 PARSED_TOOL_CALLS",
      evidence: ["src/machine/invariants.ts::noToolAfterParseError", "test/unit/invariants.test.ts::① 无工具执行于解析失败之后"],
    },
    {
      id: "exactly_one_final_answer", priority: "P0", status: "enforced",
      text: "一轮恰一个最终答案：trace 里恰一条终态转移且是末条、恰一个 answer 副作用；历史里本轮恰追加一条 <final>",
      evidence: ["src/machine/invariants.ts::exactlyOneFinalAnswer", "test/unit/invariants.test.ts::② 一轮恰一个最终答案"],
    },
    {
      id: "terminal_states_distinct", priority: "P0", status: "enforced",
      text: "三终态互斥可区分：done/max_steps/error 与 stoppedBy final/max_steps/error 一一对应，一轮只落一个终态",
      evidence: ["src/machine/invariants.ts::terminalStatesDistinct", "test/unit/invariants.test.ts::③ 三终态互斥可区分"],
    },
    {
      id: "answer_alignment", priority: "P0", status: "enforced",
      text: "答案 == 盘上历史末条 == trace 末次决策：RunResult.answer、session.history 末条 <final>、trace 末条 answer 副作用三处一致",
      evidence: ["src/machine/invariants.ts::answerAligned", "test/unit/invariants.test.ts::④ 答案 == 盘上历史末条 == trace 末次决策"],
    },
    { id: "unknown_never_silent", priority: "P0", status: "enforced", text: "未列 (状态, 事件) 在运行时被拦下：不执行副作用、记 trace、本轮 error 终态（测试模式直接失败）", evidence: ["src/runtime/agent.ts::unknownTransition", "test/unit/agent-loop.test.ts::表里没列的转移在运行时被拦下"] },
    { id: "api_key_never_in_trace", priority: "P1", status: "planned", text: "API key 不进 trace：trace 只写模型名、耗时、token、预览，不写配置", note: "还没有「把可辨认的假 key 放进配置跑一轮再 grep 产物」的自动测试；现在靠 invariants.test ④ 里的弱断言（trace 文件不含 apiKey|OPENAI）+ CLI 冒烟手工看" },
    { id: "compaction_cut_on_user", priority: "P1", status: "planned", text: "压缩切点对齐到 user 消息，不把一轮 tool_call/tool 从中间切断", note: "compactSession 按条数切，尚未按轮边界对齐；等 session 表接代码时一起做（NEXT_STEPS 3）" },
  ],
});

export type TurnMachine = typeof turnMachine;

/**
 * runner 协议：表说「哪些转移被允许」，这里说「runtime 在哪个状态会发出哪些事件、facts 怎么推进」。
 * agent 运行时与路径生成器共用同一份，保证生成的答案卷与真实 runtime 是同一套规则。
 */
export const turnRunnerProtocol = {
  initialFacts(maxSteps: number): TurnFacts {
    return { step: 0, maxSteps };
  },
  /** 每次向模型发起调用（成功或失败）算一步 */
  advance(facts: TurnFacts, event: TurnEvent): TurnFacts {
    return event === "LLM_OK" || event === "LLM_FAILED" ? { ...facts, step: facts.step + 1 } : facts;
  },
  /** 在某状态、上一事件之后，runtime 可能发出的事件（生成器的分支点） */
  next(state: TurnState, last: TurnEvent | undefined): TurnEvent[] {
    if (state === "deciding") return last === "LLM_OK" ? ["PARSED_FINAL", "PARSED_TOOL_CALLS", "PARSED_ERROR"] : ["LLM_OK", "LLM_FAILED"];
    if (state === "executing_tools") return ["TOOLS_DONE"];
    return [];
  },
};
