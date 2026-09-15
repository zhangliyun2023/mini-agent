// 一张完整的表：Agent 的「一轮」（turn）。语义：模型决策 → 执行工具 → 再决策 → 终态。
// 这是闸：runtime 每步先 interpret，allowed 才执行副作用；unknown 不执行并以 error 终态结束。
import { defineMachine } from "./machine.example.js";

export interface TurnFacts {
  step: number;
  maxSteps: number;
}

export const turnMachine = defineMachine<TurnFacts>({
  feature: "turn",
  anchor: "docs/SPEC.md#实现决策 → 循环",
  initial: "deciding",
  states: {
    deciding: { ui: false, virtual: true, meaning: "等待模型给出本步决策" },
    executing_tools: { ui: false, meaning: "按模型的工具调用逐个执行" },
    done: { terminal: true, ui: "最终答案", meaning: "模型给出 final" },
    max_steps: { terminal: true, ui: "已达到单轮工具调用上限", meaning: "安全阀触发" },
    error: { terminal: true, ui: "模型调用失败 / 未建模转移", meaning: "本轮异常结束" },
  },
  events: ["LLM_OK", "LLM_FAILED", "PARSED_TOOL_CALLS", "PARSED_FINAL", "PARSED_ERROR", "TOOLS_DONE"],
  guards: {
    hasStepsLeft: (f) => f.step < f.maxSteps,
  },
  transitions: [
    { id: "t-llm-ok", from: "deciding", event: "LLM_OK", to: "deciding", kind: "noop", effects: { llm: true }, note: "拿到模型文本，进入解析；状态不变" },
    { id: "t-llm-failed", from: "deciding", event: "LLM_FAILED", to: "error", kind: "allowed", p0: true, invariants: ["terminal-exclusive"], covered_by: ["test/unit/agent-loop.test.ts::LLM 调用抛异常时返回可读错误，不让进程崩"] },
    { id: "t-final", from: "deciding", event: "PARSED_FINAL", to: "done", kind: "allowed", p0: true, invariants: ["one-final-per-turn", "terminal-exclusive"], covered_by: ["test/unit/agent-loop.test.ts::不需要工具时直接回复，只调一次 LLM"] },
    { id: "t-tools", from: "deciding", event: "PARSED_TOOL_CALLS", guard: "hasStepsLeft", to: "executing_tools", kind: "allowed", p0: true, effects: { tools: true }, invariants: ["no-tool-after-parse-error"], covered_by: ["test/unit/agent-loop.test.ts::调用工具：结果以 tool 消息回填后模型再给最终答案"] },
    { id: "t-tools-cap", from: "deciding", event: "PARSED_TOOL_CALLS", to: "max_steps", kind: "allowed", p0: true, invariants: ["terminal-exclusive"], note: "无 guard 兜底：步数用尽", covered_by: ["test/unit/agent-loop.test.ts::模型一直调工具时，到达单轮最大步数就停下并把已有信息交还用户"] },
    { id: "t-parse-error", from: "deciding", event: "PARSED_ERROR", guard: "hasStepsLeft", to: "deciding", kind: "rejected", reject_code: "PARSE_ERROR", p0: true, invariants: ["no-tool-after-parse-error"], note: "错误回喂模型，本步不执行任何工具", covered_by: ["test/unit/agent-loop.test.ts::模型输出坏 JSON 时，把解析错误当 tool 消息回喂，让模型自己纠正"] },
    { id: "t-parse-error-cap", from: "deciding", event: "PARSED_ERROR", to: "max_steps", kind: "allowed", note: "连续解析失败到步数用尽" },
    { id: "t-tools-done", from: "executing_tools", event: "TOOLS_DONE", to: "deciding", kind: "allowed", p0: true, covered_by: ["test/unit/agent-loop.test.ts::调用工具：结果以 tool 消息回填后模型再给最终答案"] },
  ],
  invariants: {
    "no-tool-after-parse-error": { text: "解析失败的那一步不得执行任何工具", enforcement: "enforced", evidence: ["test/unit/invariants.test.ts::解析失败的一步不执行工具"] },
    "one-final-per-turn": { text: "一轮恰好产生一个最终答案", enforcement: "enforced", evidence: ["test/unit/invariants.test.ts::一轮只有一个 final"] },
    "terminal-exclusive": { text: "done / max_steps / error 互斥且可区分", enforcement: "enforced", evidence: ["test/unit/invariants.test.ts::三终态互斥"] },
    "three-way-alignment": { text: "返回给用户的答案 == 盘上会话历史末条 == trace 末次决策", enforcement: "enforced", evidence: ["test/unit/invariants.test.ts::三处对齐"] },
    "no-duplicate-tool-call": { text: "追问时不重复已做过的相同工具调用", enforcement: "planned", note: "只靠 prompt 规则，runtime 无去重；live 场景观察" },
  },
});
