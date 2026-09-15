import { describe, it, expect } from "vitest";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";
import { defineMachine } from "../../src/machine/interpreter.js";
import { turnMachine, type TurnEvent, type TurnFacts, type TurnState } from "../../contracts/turn.machine.js";

const tc = (name: string, args: object) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;

describe("Agent Loop", () => {
  it("不需要工具时直接回复，只调一次 LLM", async () => {
    const llm = new FakeLLM([`<think>打招呼</think><final>你好，我能帮你算数、搜索、记待办。</final>`]);
    const agent = createAgent({ llm });
    const r = await agent.run({ userId: "u1", sessionId: "s1", input: "你好" });
    expect(r.answer).toBe("你好，我能帮你算数、搜索、记待办。");
    expect(llm.calls.length).toBe(1);
    expect(r.steps.map((s) => s.kind)).toEqual(["llm"]);
  });

  it("调用工具：结果以 tool 消息回填后模型再给最终答案", async () => {
    const llm = new FakeLLM([
      `<think>要算</think>${tc("calculator", { expression: "12*12" })}`,
      (messages) => {
        const last = messages[messages.length - 1];
        return `<final>12×12 = ${last.content}</final>`;
      },
    ]);
    const agent = createAgent({ llm });
    const r = await agent.run({ userId: "u1", sessionId: "s1", input: "12乘12" });
    expect(r.answer).toBe("12×12 = 144");
    const second = llm.calls[1];
    expect(second[second.length - 1]).toMatchObject({ role: "tool", name: "calculator", content: "144" });
    expect(r.steps.map((s) => s.kind)).toEqual(["llm", "tool", "llm"]);
  });

  it("一次输出多个 tool_call 时全部执行，各自回填", async () => {
    const llm = new FakeLLM([
      tc("search", { query: "上海" }) + tc("search", { query: "北京" }),
      (m) => `<final>两条都查了：${m.filter((x) => x.role === "tool").length}</final>`,
    ]);
    const r = await createAgent({ llm }).run({ userId: "u1", sessionId: "s1", input: "上海北京天气" });
    expect(r.answer).toBe("两条都查了：2");
  });

  it("模型一直调工具时，到达单轮最大步数就停下并把已有信息交还用户", async () => {
    const llm = new FakeLLM(Array(10).fill(tc("calculator", { expression: "1+1" })));
    const agent = createAgent({ llm, maxToolSteps: 3 });
    const r = await agent.run({ userId: "u1", sessionId: "s1", input: "循环" });
    expect(r.stoppedBy).toBe("max_steps");
    expect(r.answer).toMatch(/上限/);
    expect(llm.calls.length).toBe(3);
  });

  it("模型输出坏 JSON 时，把解析错误当 tool 消息回喂，让模型自己纠正", async () => {
    const llm = new FakeLLM([
      `<tool_call>{"name":"calculator","arguments":{"expression":</tool_call>`,
      (m) => {
        const last = m[m.length - 1];
        return last.role === "tool" && /JSON/.test(last.content)
          ? `<final>纠正了</final>`
          : `<final>没收到错误</final>`;
      },
    ]);
    const r = await createAgent({ llm }).run({ userId: "u1", sessionId: "s1", input: "x" });
    expect(r.answer).toBe("纠正了");
  });

  it("工具执行失败时不中断 loop，错误以 tool 消息回喂", async () => {
    const llm = new FakeLLM([
      tc("calculator", { expression: "process.exit()" }),
      (m) => `<final>${m[m.length - 1].content.includes("失败") ? "工具报错了，我换个方式" : "?"}</final>`,
    ]);
    const r = await createAgent({ llm }).run({ userId: "u1", sessionId: "s1", input: "x" });
    expect(r.answer).toBe("工具报错了，我换个方式");
  });

  it("LLM 调用抛异常时返回可读错误，不让进程崩", async () => {
    const llm = { model: "dead", chat: async () => { throw new Error("429 rate limited"); } };
    const r = await createAgent({ llm, llmRetries: 0 }).run({ userId: "u1", sessionId: "s1", input: "x" });
    expect(r.stoppedBy).toBe("error");
    expect(r.answer).toMatch(/429/);
  });

  it("模型连续输出无法解析的内容直到步数上限，以 max_steps 结束", async () => {
    const llm = new FakeLLM(Array(5).fill(`<tool_call>{"name":"calculator","arguments":{"expression":</tool_call>`));
    const trace = new MemoryTraceSink();
    const r = await createAgent({ llm, trace, maxToolSteps: 2 }).run({ userId: "u1", sessionId: "s1", input: "x" });
    expect(r.stoppedBy).toBe("max_steps");
    expect(llm.calls.length).toBe(2);
    expect(trace.sequence()).toEqual([
      "deciding --LLM_OK--> deciding",
      "deciding --PARSED_ERROR--> deciding",
      "deciding --LLM_OK--> deciding",
      "deciding --PARSED_ERROR--> max_steps",
    ]);
    // 解析失败的路径上没有任何工具被执行
    expect(trace.effects("tool")).toEqual([]);
    expect(r.steps.every((s) => s.kind === "llm")).toBe(true);
  });
});

/** 从 turn 表里抠掉一行，得到一张残缺表：用它验证闸拦得住 */
function machineWithout(event: TurnEvent) {
  return defineMachine<TurnState, TurnEvent, TurnFacts>({ ...turnMachine, rows: turnMachine.rows.filter((r) => r.event !== event) });
}

describe("闸：表里没列的 (状态, 事件) 在运行时被拦下", () => {
  it("表里没列的转移在运行时被拦下：不执行副作用、记一条 status=unknown 的 trace、本轮以 error 终态结束", async () => {
    const llm = new FakeLLM([tc("calculator", { expression: "1+1" }), "<final>不该到这</final>"]);
    const trace = new MemoryTraceSink();
    const agent = createAgent({ llm, trace, machine: machineWithout("PARSED_TOOL_CALLS"), unknownTransition: "error" });
    const r = await agent.run({ userId: "u1", sessionId: "s1", input: "1+1" });
    expect(r.stoppedBy).toBe("error");
    expect(r.answer).toMatch(/未建模的状态转移：deciding \+ PARSED_TOOL_CALLS/);
    // 工具没跑，模型也没再被调
    expect(r.steps.filter((s) => s.kind === "tool")).toEqual([]);
    expect(trace.effects("tool")).toEqual([]);
    expect(llm.calls.length).toBe(1);
    const last = trace.records.at(-1)!;
    expect(last).toMatchObject({ from: "deciding", event: "PARSED_TOOL_CALLS", to: "error", status: "unknown" });
    expect(last.reason).toMatch(/未在表里列出/);
    expect(trace.sequence()).toEqual(["deciding --LLM_OK--> deciding", "deciding --PARSED_TOOL_CALLS--> error [unknown]"]);
    // 历史里仍然恰好一条最终答案，会话没被搞坏
    const hist = agent.sessions.get("u1", "s1").history;
    expect(hist.filter((m) => m.role === "assistant" && m.content.startsWith("<final>")).length).toBe(1);
  });

  it("测试模式（unknownTransition: throw）下未列转移直接抛出，trace 里仍留下那条 unknown 记录", async () => {
    const llm = new FakeLLM(["<final>hi</final>"]);
    const trace = new MemoryTraceSink();
    const agent = createAgent({ llm, trace, machine: machineWithout("PARSED_FINAL"), unknownTransition: "throw" });
    await expect(agent.run({ userId: "u1", sessionId: "s1", input: "hi" })).rejects.toThrow(/deciding \+ PARSED_FINAL/);
    expect(trace.records.at(-1)).toMatchObject({ event: "PARSED_FINAL", status: "unknown", to: "error" });
  });
});

