import { describe, it, expect } from "vitest";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";

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
});
