import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { checkJourney, unknownRows, validateJourney, type Journey } from "../../src/machine/check.js";
import { generatePaths } from "../../src/machine/generator.js";
import { defineMachine } from "../../src/machine/interpreter.js";
import { turnMachine, turnRunnerProtocol, type TurnEvent, type TurnFacts, type TurnState } from "../../contracts/turn.machine.js";
import { sessionMachine } from "../../contracts/session.machine.js";
import { sessionRuntimeMachine } from "../../contracts/session-runtime.machine.js";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";

// B1 答案卷落盘：contracts/journeys.json（旅程名 → 行 id 序列）+ checkJourney 三态。人、AI、测试对答案用同一个函数。
const journeys = JSON.parse(readFileSync("contracts/journeys.json", "utf8")) as Record<string, Journey>;
const machines = { turn: turnMachine, session: sessionMachine, "session-runtime": sessionRuntimeMachine } as const;
const tc = (name: string, args: object) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

async function runOnce(script: Array<string | (() => string)>, opts: { maxToolSteps?: number; machine?: typeof turnMachine; unknownTransition?: "error" | "throw" } = {}) {
  const trace = new MemoryTraceSink();
  const r = await createAgent({ llm: new FakeLLM(script), trace, llmRetries: 0, ...opts }).run({ userId: "j", sessionId: "s", input: "go" });
  return { r, rows: trace.records };
}

describe("contracts/journeys.json 与表拴在一起", () => {
  it("每条旅程的 feature 是一张真实的表，expect / alternatives 里每个行 id 都存在、从 initial 出发、首尾相接、落在终态", () => {
    expect(Object.keys(journeys).length).toBeGreaterThan(0);
    const problems = Object.entries(journeys).flatMap(([name, j]) => {
      const m = machines[j.feature as keyof typeof machines];
      return m ? validateJourney(j, m).map((p) => `${name}：${p}`) : [`${name}：feature "${j.feature}" 不是一张表`];
    });
    expect(problems).toEqual([]);
  });

  it("validateJourney 能点名：不存在的 id、断开的链", () => {
    expect(validateJourney({ feature: "turn", expect: ["t-llm-ok", "nope"] }, turnMachine).join("\n")).toMatch(/nope/);
    expect(validateJourney({ feature: "turn", expect: ["t-llm-ok", "t-tools-done"] }, turnMachine).join("\n")).toMatch(/首尾|接不上/);
  });

  it("生成器 maxSteps=2 的 10 条路径与 journeys.json 里 turn 的旅程逐条对账：集合相等", () => {
    const gen = generatePaths(turnMachine, { ...turnRunnerProtocol, initialFacts: () => turnRunnerProtocol.initialFacts(2) });
    const generated = new Set(gen.paths.map((p) => p.rowIds.join(" > ")));
    const written = new Set(Object.values(journeys).filter((j) => j.feature === "turn").map((j) => j.expect.join(" > ")));
    expect(generated.size).toBe(10);
    expect([...generated].filter((g) => !written.has(g))).toEqual([]);
    expect([...written].filter((w) => !generated.has(w))).toEqual([]);
  });
});

describe("checkJourney 三态", () => {
  it("passed：Given 直接回答的一轮，When 对「direct-final」旅程，Then passed 且带 trace_id", async () => {
    const { rows } = await runOnce(["<final>hi</final>"]);
    expect(checkJourney(rows, journeys["direct-final"])).toEqual({ status: "passed", trace_id: "j/s/1" });
  });

  it("failed：Given 走了工具的一轮，When 对「direct-final」旅程，Then failed 并给出最接近那一轮的实际序列", async () => {
    const { rows } = await runOnce([tc("calculator", { expression: "1+1" }), "<final>2</final>"]);
    expect(checkJourney(rows, journeys["direct-final"])).toEqual({
      status: "failed",
      closest: { trace_id: "j/s/1", actual: ["t-llm-ok", "t-tools", "t-tools-done", "t-llm-ok", "t-final"] },
    });
    expect(checkJourney(rows, journeys["tool-then-final"])).toMatchObject({ status: "passed" });
  });

  it("not_observed：没有这张表 / 这个 trace_id 的记录时是 not_observed，不是 failed", async () => {
    const { rows } = await runOnce(["<final>hi</final>"]);
    expect(checkJourney([], journeys["direct-final"])).toEqual({ status: "not_observed" });
    expect(checkJourney(rows, journeys["direct-final"], "j/s/99")).toEqual({ status: "not_observed" });
    expect(checkJourney(rows, { feature: "session", expect: ["s-first-input"] })).toEqual({ status: "not_observed" });
  });

  it("alternatives 里任一序列命中也算 passed", async () => {
    const { rows } = await runOnce(["<final>hi</final>"]);
    expect(checkJourney(rows, { feature: "turn", expect: ["t-llm-failed"], alternatives: [["t-llm-ok", "t-final"]] })).toMatchObject({ status: "passed" });
  });

  it("unknownRows 永远单独列出：残缺表下那条 status=unknown 的记录被点名", async () => {
    const holed = defineMachine<TurnState, TurnEvent, TurnFacts>({ ...turnMachine, rows: turnMachine.rows.filter((r) => r.event !== "PARSED_TOOL_CALLS") });
    const { rows } = await runOnce([tc("calculator", { expression: "1+1" })], { machine: holed, unknownTransition: "error" });
    expect(unknownRows(rows).map((r) => [r.from, r.event, r.transition])).toEqual([["deciding", "PARSED_TOOL_CALLS", null]]);
    expect(checkJourney(rows, journeys["direct-final"])).toMatchObject({ status: "failed" });
  });
});
