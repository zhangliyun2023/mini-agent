import type { ChatMessage } from "../llm/types.js";
import type { Effect, TransitionRecord } from "../runtime/trace.js";
import { TERMINAL_STOPPED_BY, TURN_TERMINAL, turnMachine, type TurnMachine } from "../../contracts/turn.machine.js";

// 五条 P0 不变量的独立 oracle（docs/product/SPEC-state-machines.md §2 D3 四条 + ⑤ 副作用对账）。
// 输入只有「用户可见的证据」：一轮的 trace 记录、RunResult、盘上历史末条；不碰 runtime 内部。
// 每个函数返回违反项列表，空 = 通过。测试里每条都一红一绿：真实运行过 oracle，篡改后的证据被 oracle 点名。

export interface TurnEvidence {
  records: TransitionRecord[];
  result: { answer: string; stoppedBy: "final" | "max_steps" | "error" };
  /** 盘上会话历史里本轮末条消息（应为 assistant 的 <final>…</final>） */
  lastHistoryMessage?: ChatMessage;
}

const isTerminal = (s: string) => (TURN_TERMINAL as readonly string[]).includes(s);
const answerEffects = (r: TransitionRecord) => r.effects.filter((e): e is Extract<Effect, { kind: "answer" }> => e.kind === "answer");

/** ① 无工具执行于解析失败之后 */
export function noToolAfterParseError(records: TransitionRecord[]): string[] {
  const v: string[] = [];
  records.forEach((r, i) => {
    const tools = r.effects.filter((e) => e.kind === "tool");
    if (r.event === "PARSED_ERROR" && tools.length) v.push(`#${r.seq} PARSED_ERROR 转移上挂了 ${tools.length} 个 tool 副作用`);
    if (!tools.length) return;
    if (r.event !== "TOOLS_DONE" || r.from !== "executing_tools") v.push(`#${r.seq} tool 副作用出现在 ${r.from} + ${r.event} 上，只允许出现在 executing_tools + TOOLS_DONE`);
    const prev = records[i - 1];
    if (!prev || prev.event !== "PARSED_TOOL_CALLS" || prev.status !== "allowed" || prev.to !== "executing_tools") {
      v.push(`#${r.seq} 工具执行前一条不是 allowed 的 PARSED_TOOL_CALLS → executing_tools（实际：${prev ? `${prev.event} [${prev.status}]` : "无"}）`);
    }
  });
  return v;
}

/** ② 一轮恰一个最终答案 */
export function exactlyOneFinalAnswer(records: TransitionRecord[], turnHistory?: ChatMessage[]): string[] {
  const v: string[] = [];
  const terminals = records.filter((r) => isTerminal(r.to));
  if (terminals.length !== 1) v.push(`终态转移应恰 1 条，实际 ${terminals.length} 条`);
  if (records.length && !isTerminal(records[records.length - 1].to)) v.push(`末条转移 ${records[records.length - 1].to} 不是终态`);
  const answers = records.flatMap(answerEffects);
  if (answers.length !== 1) v.push(`answer 副作用应恰 1 个，实际 ${answers.length} 个`);
  if (answers.length === 1 && !isTerminal(records.find((r) => answerEffects(r).length)!.to)) v.push("answer 副作用挂在非终态转移上");
  if (turnHistory) {
    const finals = turnHistory.filter((m) => m.role === "assistant" && /^<final>[\s\S]*<\/final>$/.test(m.content.trim()));
    if (finals.length !== 1) v.push(`本轮历史里 <final> 消息应恰 1 条，实际 ${finals.length} 条`);
  }
  return v;
}

/** ③ 三终态互斥可区分 */
export function terminalStatesDistinct(records: TransitionRecord[], stoppedBy: TurnEvidence["result"]["stoppedBy"]): string[] {
  const v: string[] = [];
  const terminals = records.filter((r) => isTerminal(r.to));
  if (terminals.length !== 1) return [`终态转移应恰 1 条，实际 ${terminals.length} 条：${terminals.map((t) => t.to).join(", ")}`];
  const to = terminals[0].to as keyof typeof TERMINAL_STOPPED_BY;
  if (TERMINAL_STOPPED_BY[to] !== stoppedBy) v.push(`终态 ${to} 应对应 stoppedBy=${TERMINAL_STOPPED_BY[to]}，实际 ${stoppedBy}`);
  const a = answerEffects(terminals[0])[0];
  if (a && a.stoppedBy !== stoppedBy) v.push(`answer 副作用的 stoppedBy=${a.stoppedBy} 与结果 ${stoppedBy} 不一致`);
  return v;
}

/** ④ 答案 == 盘上历史末条 == trace 末次决策 */
export function answerAligned(ev: TurnEvidence): string[] {
  const v: string[] = [];
  const last = ev.records[ev.records.length - 1];
  const a = last ? answerEffects(last)[0] : undefined;
  if (!a) v.push("trace 末条转移上没有 answer 副作用");
  else if (a.answer !== ev.result.answer) v.push(`trace 末次决策的答案与返回值不一致：trace=「${a.answer.slice(0, 60)}」 result=「${ev.result.answer.slice(0, 60)}」`);
  if (!ev.lastHistoryMessage) v.push("没有盘上历史末条");
  else {
    const m = /^<final>([\s\S]*)<\/final>$/.exec(ev.lastHistoryMessage.content.trim());
    if (ev.lastHistoryMessage.role !== "assistant" || !m) v.push(`历史末条不是 assistant 的 <final>：${ev.lastHistoryMessage.role} 「${ev.lastHistoryMessage.content.slice(0, 60)}」`);
    else if (m[1] !== ev.result.answer) v.push(`历史末条 <final> 与返回值不一致：history=「${m[1].slice(0, 60)}」 result=「${ev.result.answer.slice(0, 60)}」`);
  }
  return v;
}

/**
 * ⑤ 副作用对账：每条转移记录上出现的 effects[].kind 必须 ⊆ 记录 `transition` 行 id 在表里命中行声明的 `effects`。
 * 表上没声明的副作用 = unmodeled（标准 §7「运行时元素清单与契约清单不一致」在本仓的对应物）；
 * compact 只允许出现在轮首第一条转移（seq 1）上。status=unknown 的记录没有行 id，由 unknown 点名单独列，不在这里判。
 * 对 noop / blocked 记录同样成立：LLM_OK 行声明了 llm，rejected 的 PARSED_ERROR 行声明了 parse。
 */
export function effectsDeclared(records: TransitionRecord[], machine: TurnMachine = turnMachine): string[] {
  const v: string[] = [];
  const byId = new Map(machine.rows.map((r) => [r.id, r]));
  for (const r of records) {
    if (r.status === "unknown") continue;
    const row = r.transition ? byId.get(r.transition) : undefined;
    if (!row) {
      v.push(`#${r.seq} 行 id "${r.transition}" 在表里不存在（${r.from} --${r.event}--> ${r.to} [${r.status}]）`);
      continue;
    }
    const declared = row.effects ?? [];
    for (const e of r.effects) {
      if (!declared.includes(e.kind)) v.push(`#${r.seq} ${row.id} 上出现了表未声明的副作用 "${e.kind}"（该行声明：${declared.join(", ") || "无"}）`);
      else if (e.kind === "compact" && r.seq !== 1) v.push(`#${r.seq} ${row.id} 上出现了 compact，但 compact 只允许挂在轮首第一条转移上`);
    }
  }
  return v;
}

export const TURN_INVARIANT_CHECKS = {
  no_tool_after_parse_error: (ev: TurnEvidence) => noToolAfterParseError(ev.records),
  exactly_one_final_answer: (ev: TurnEvidence) => exactlyOneFinalAnswer(ev.records),
  terminal_states_distinct: (ev: TurnEvidence) => terminalStatesDistinct(ev.records, ev.result.stoppedBy),
  answer_alignment: (ev: TurnEvidence) => answerAligned(ev),
  effects_declared: (ev: TurnEvidence) => effectsDeclared(ev.records),
} as const;

/** 一次跑全部五条；返回每条的违反项 */
export function checkTurnInvariants(ev: TurnEvidence): Array<{ id: keyof typeof TURN_INVARIANT_CHECKS; violations: string[] }> {
  return (Object.keys(TURN_INVARIANT_CHECKS) as Array<keyof typeof TURN_INVARIANT_CHECKS>).map((id) => ({ id, violations: TURN_INVARIANT_CHECKS[id](ev) }));
}
