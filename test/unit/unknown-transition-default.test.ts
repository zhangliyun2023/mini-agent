import { describe, it, expect } from "vitest";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";
import { defineMachine } from "../../src/machine/interpreter.js";
import { turnMachine, type TurnEvent, type TurnFacts, type TurnState } from "../../contracts/turn.machine.js";

// #11：unknownTransition 默认 "error"，运行时不读任何测试环境变量。
// 这条在 vitest 进程里跑，基线「测试进程下默认 throw」（读测试环境变量）会让它红；改成固定默认 error 后绿。
function machineWithout(event: TurnEvent) {
  return defineMachine<TurnState, TurnEvent, TurnFacts>({ ...turnMachine, rows: turnMachine.rows.filter((r) => r.event !== event) });
}

describe("unknownTransition 默认值（#11）", () => {
  it("不传 unknownTransition 时未列转移不抛出：本轮以 error 终态结束，trace 留 unknown 记录", async () => {
    const llm = new FakeLLM(["<final>hi</final>"]);
    const trace = new MemoryTraceSink();
    const agent = createAgent({ llm, trace, machine: machineWithout("PARSED_FINAL") });
    const r = await agent.run({ userId: "u1", sessionId: "s1", input: "hi" });
    expect(r.stoppedBy).toBe("error");
    expect(r.answer).toMatch(/未建模的状态转移：deciding \+ PARSED_FINAL/);
    expect(trace.records.at(-1)).toMatchObject({ event: "PARSED_FINAL", status: "unknown", to: "error" });
  });
});
