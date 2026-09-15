import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { generatePaths } from "../../src/machine/generator.js";
import { defineMachine } from "../../src/machine/interpreter.js";
import { turnMachine, turnRunnerProtocol, TERMINAL_STOPPED_BY, type TurnEvent } from "../../contracts/turn.machine.js";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";

// S3：从表 BFS 生成路径清单 → 对账手写 covered_by → 每条路径用 FakeLLM 真跑一遍，trace 序列 == 答案卷。
const MAX_STEPS = 2;
const gen = generatePaths(turnMachine, { ...turnRunnerProtocol, initialFacts: () => turnRunnerProtocol.initialFacts(MAX_STEPS) });

/** 路径的事件序列 → FakeLLM 脚本：每个 LLM_OK 看它后面的 PARSED_* 决定吐什么；LLM_FAILED 抛异常 */
function scriptFor(events: TurnEvent[]) {
  const script: Array<string | (() => string)> = [];
  events.forEach((e, i) => {
    if (e === "LLM_FAILED") script.push(() => { throw new Error("模拟接口失败"); });
    if (e !== "LLM_OK") return;
    const next = events[i + 1];
    if (next === "PARSED_FINAL") script.push("<final>生成路径的最终答案</final>");
    else if (next === "PARSED_TOOL_CALLS") script.push(`<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>`);
    else if (next === "PARSED_ERROR") script.push(`<tool_call>{"name":"calculator","arguments":{"expression":</tool_call>`);
    else throw new Error(`LLM_OK 后面不该是 ${next}`);
  });
  return script;
}

describe("生成器", () => {
  it("runner 协议能发出的每个组合表里都有：gaps 为空（表与代码没漂）", () => {
    expect(gen.gaps).toEqual([]);
  });

  it("maxSteps=2 时 BFS 出 10 条到终态的路径，三个终态都到过，路径 id 两两不同", () => {
    expect(gen.paths.length).toBe(10);
    expect(new Set(gen.paths.map((p) => p.id)).size).toBe(10);
    expect(new Set(gen.paths.map((p) => p.terminal))).toEqual(new Set(["done", "max_steps", "error"]));
  });

  it("生成路径走过的行集合 == 全表行集合（每一行都被某条生成路径走到）", () => {
    expect(gen.rowsUsed).toEqual(turnMachine.rows.map((r) => r.id));
  });

  it("生成集合 ⊆ 手写覆盖：生成路径走过的每一行都有 covered_by，且指向的手写测试在盘上", () => {
    const covered = new Map(turnMachine.rows.map((r) => [r.id, r.covered_by ?? []]));
    const missing = gen.rowsUsed.filter((id) => (covered.get(id) ?? []).length === 0);
    expect(missing).toEqual([]);
    const notOnDisk = gen.rowsUsed.flatMap((id) => covered.get(id)!).filter((ref) => {
      const [file, name] = ref.split("::");
      return !existsSync(file) || !readFileSync(file, "utf8").includes(name);
    });
    expect(notOnDisk).toEqual([]);
  });
});

describe("答案卷 = 行 id 序列（A1）", () => {
  it("每条路径的 expected 是行 id 序列：LLM_FAILED 一步就是 [t-llm-failed]；直接 final 是 [t-llm-ok, t-final]", () => {
    const failed = gen.paths.find((p) => p.events.join(",") === "LLM_FAILED")!;
    expect(failed.expected).toEqual(["t-llm-failed"]);
    const direct = gen.paths.find((p) => p.events.join(",") === "LLM_OK,PARSED_FINAL")!;
    expect(direct.expected).toEqual(["t-llm-ok [noop]", "t-final"]);
  });

  it("改某行 reason 不引起答案卷漂移：同一路径集合、同一 expected", () => {
    const reworded = defineMachine({ ...turnMachine, rows: turnMachine.rows.map((r) => (r.id === "t-final" ? { ...r, reason: "措辞改了，语义没改" } : r)) });
    const again = generatePaths(reworded, { ...turnRunnerProtocol, initialFacts: () => turnRunnerProtocol.initialFacts(MAX_STEPS) });
    expect(again.paths.map((p) => p.expected)).toEqual(gen.paths.map((p) => p.expected));
  });
});

describe("生成路径逐条真跑：trace 转移序列 == 答案卷", () => {
  it.each(gen.paths.map((p) => [p.id, p] as const))("%s", async (_id, path) => {
    const llm = new FakeLLM(scriptFor(path.events));
    const trace = new MemoryTraceSink();
    const r = await createAgent({ llm, trace, maxToolSteps: MAX_STEPS, llmRetries: 0 }).run({ userId: "gen", sessionId: path.id, input: "go" });
    expect(trace.sequence()).toEqual(path.expected);
    expect(r.stoppedBy).toBe(TERMINAL_STOPPED_BY[path.terminal as keyof typeof TERMINAL_STOPPED_BY]);
    expect(trace.records.every((x) => x.status !== "unknown")).toBe(true);
  });
});
