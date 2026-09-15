import { describe, it, expect } from "vitest";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";
import { MemoryUserMemoryStore } from "../../src/memory/user-memory.js";

const tc = (name: string, args: object) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
const lastTool = (m: any[]) => [...m].reverse().find((x) => x.role === "tool")?.content ?? "";

describe("Session：同一用户的两个窗口互不影响，且都能接着聊", () => {
  it("窗口1 加日历、窗口2 加联系人，各自的 todo 与历史互不可见", async () => {
    const llm = new FakeLLM([
      tc("todo", { action: "add", item: "周三 3 点开会（日历）" }),
      "<final>日历加好了</final>",
      tc("todo", { action: "add", item: "联系人：李哲" }),
      "<final>联系人加好了</final>",
      tc("todo", { action: "list" }),
      (m) => `<final>${lastTool(m)}</final>`,
      tc("todo", { action: "list" }),
      (m) => `<final>${lastTool(m)}</final>`,
    ]);
    const agent = createAgent({ llm });
    await agent.run({ userId: "A", sessionId: "w1", input: "帮我加个日历" });
    await agent.run({ userId: "A", sessionId: "w2", input: "帮我加个联系人" });
    const w1 = await agent.run({ userId: "A", sessionId: "w1", input: "看看清单" });
    const w2 = await agent.run({ userId: "A", sessionId: "w2", input: "看看清单" });
    expect(w1.answer).toContain("日历");
    expect(w1.answer).not.toContain("李哲");
    expect(w2.answer).toContain("李哲");
    expect(w2.answer).not.toContain("日历");
    // 窗口1 第二轮的 context 里只有窗口1 自己的历史
    const w1SecondCall = llm.calls[4];
    expect(w1SecondCall.some((m) => m.content.includes("加个日历"))).toBe(true);
    expect(w1SecondCall.some((m) => m.content.includes("联系人"))).toBe(false);
  });
});

describe("Context：追问、think 剥离", () => {
  it("纯对话追问：第二轮的 context 里有第一轮的用户输入和最终答案", async () => {
    const llm = new FakeLLM([`<think>先答</think><final>上海今天 28 度</final>`, `<final>那北京呢</final>`]);
    const agent = createAgent({ llm });
    await agent.run({ userId: "u", sessionId: "s", input: "上海天气" });
    await agent.run({ userId: "u", sessionId: "s", input: "北京呢" });
    const second = llm.calls[1];
    const texts = second.map((m) => m.content);
    expect(texts).toContain("上海天气");
    expect(texts.some((t) => t.includes("上海今天 28 度"))).toBe(true);
  });

  it("带工具的追问：「把第 1 条标完成」作用在上一轮建的清单上", async () => {
    const llm = new FakeLLM([
      tc("todo", { action: "add", item: "买牛奶" }),
      "<final>加好了</final>",
      tc("todo", { action: "done", index: 1 }),
      (m) => `<final>${lastTool(m)}</final>`,
    ]);
    const agent = createAgent({ llm });
    await agent.run({ userId: "u", sessionId: "s", input: "记一下买牛奶" });
    const r = await agent.run({ userId: "u", sessionId: "s", input: "第一条完成了" });
    expect(r.answer).toContain("[x] 买牛奶");
  });

  it("同一轮内模型能看见自己的 think；轮次结束后历史里的 think 被剥掉，工具结果保留", async () => {
    const llm = new FakeLLM([
      `<think>我要先算</think>${tc("calculator", { expression: "6*7" })}`,
      "<final>42</final>",
      "<final>ok</final>",
    ]);
    const agent = createAgent({ llm });
    await agent.run({ userId: "u", sessionId: "s", input: "6乘7" });
    const withinTurn = llm.calls[1].map((m) => m.content).join("\n");
    expect(withinTurn).toContain("我要先算");
    await agent.run({ userId: "u", sessionId: "s", input: "再来" });
    const nextTurn = llm.calls[2].map((m) => m.content).join("\n");
    expect(nextTurn).not.toContain("我要先算");
    expect(nextTurn).toContain("42");
    expect(llm.calls[2].some((m) => m.role === "tool" && m.content === "42")).toBe(true);
  });
});

describe("Context：超阈值压缩", () => {
  it("历史超过上限时，老轮次被压成一条摘要，最近几轮保留原文，追问仍能接上", async () => {
    const script: any[] = [];
    for (let i = 1; i <= 6; i++) script.push(`<final>答${i}</final>`);
    // 第 7 轮开始前触发压缩：先消费一次摘要调用，再回答
    script.push((m: any[]) => (m[0].content.includes("对话压缩器") ? "要点：用户问了 1-4 号问题" : "<final>不该走这里</final>"));
    script.push((m: any[]) => `<final>${m.slice(1).map((x) => x.content.replace(/<\/?final>/g, "")).join("|")}</final>`);
    const llm = new FakeLLM(script);
    const trace = new MemoryTraceSink();
    const agent = createAgent({ llm, trace, context: { maxHistoryMessages: 10, keepRecentMessages: 4, maxHistoryChars: 100_000 } });
    for (let i = 1; i <= 6; i++) await agent.run({ userId: "u", sessionId: "s", input: `问${i}` });
    const r = await agent.run({ userId: "u", sessionId: "s", input: "问7" });
    expect(r.answer).toContain("要点：用户问了 1-4 号问题");
    expect(r.answer).toContain("问5");
    expect(r.answer).not.toContain("问1|");
    // compact 不再是独立记录，而是挂在本轮第一条转移上的副作用（D4）
    const compact = trace.effects("compact")[0];
    expect(compact).toMatchObject({ before: 12, after: 4, method: "llm" });
    const firstOfTurn7 = trace.records.find((x) => x.trace_id === "u/s/7" && x.seq === 1)!;
    expect(firstOfTurn7.effects.map((e) => e.kind)).toEqual(["compact", "llm"]);
  });

  it("摘要调用失败时退回规则压缩，不影响本轮回答", async () => {
    const script: any[] = [];
    for (let i = 1; i <= 3; i++) script.push(`<final>答${i}</final>`);
    script.push(() => { throw new Error("摘要接口挂了"); });
    script.push((m: any[]) => `<final>${m.slice(1).map((x) => x.content.replace(/<\/?final>/g, "")).join("|")}</final>`);
    const llm = new FakeLLM(script);
    const trace = new MemoryTraceSink();
    const agent = createAgent({ llm, trace, llmRetries: 0, context: { maxHistoryMessages: 4, keepRecentMessages: 2, maxHistoryChars: 100_000 } });
    for (let i = 1; i <= 3; i++) await agent.run({ userId: "u", sessionId: "s", input: `问${i}` });
    const r = await agent.run({ userId: "u", sessionId: "s", input: "问4" });
    expect(r.stoppedBy).toBe("final");
    expect(r.answer).toContain("用户：问1");
    expect(trace.effects("compact")[0].method).toBe("rule");
  });
});

describe("用户级 memory：跨 session 召回", () => {
  it("remember 写入后，同一用户的新 session 第一轮 system prompt 里就有这条记忆", async () => {
    const memory = new MemoryUserMemoryStore();
    const llm = new FakeLLM([tc("remember", { key: "city", value: "上海" }), "<final>记住了</final>", "<final>ok</final>"]);
    const agent = createAgent({ llm, memory });
    await agent.run({ userId: "A", sessionId: "w1", input: "我在上海" });
    await agent.run({ userId: "A", sessionId: "w2", input: "天气" });
    expect(llm.calls[2][0].role).toBe("system");
    expect(llm.calls[2][0].content).toMatch(/<memory>[\s\S]*city: 上海/);
  });
  it("别的用户看不到这条记忆", async () => {
    const memory = new MemoryUserMemoryStore();
    memory.set("A", "city", "上海");
    const llm = new FakeLLM(["<final>ok</final>"]);
    await createAgent({ llm, memory }).run({ userId: "B", sessionId: "w1", input: "hi" });
    expect(llm.calls[0][0].content).not.toContain("上海");
  });
});

describe("trace：以转移为单位，序列对答案卷", () => {
  it("一轮的转移序列与答案卷逐条相同，每条带 trace_id；llm / tool / answer 作为副作用挂在对应转移上", async () => {
    const trace = new MemoryTraceSink();
    const llm = new FakeLLM([tc("calculator", { expression: "1+1" }), "<final>2</final>"]);
    const r = await createAgent({ llm, trace }).run({ userId: "u", sessionId: "s", input: "1+1" });
    expect(trace.sequence()).toEqual([
      "deciding --LLM_OK--> deciding",
      "deciding --PARSED_TOOL_CALLS--> executing_tools",
      "executing_tools --TOOLS_DONE--> deciding",
      "deciding --LLM_OK--> deciding",
      "deciding --PARSED_FINAL--> done",
    ]);
    expect(r.traceId).toBe("u/s/1");
    expect(trace.records.every((x) => x.trace_id === "u/s/1" && x.sessionId === "s" && x.turn === 1 && x.status === "allowed")).toBe(true);
    expect(trace.records.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(trace.records.map((x) => x.step)).toEqual([1, 1, 1, 2, 2]);
    // 副作用挂在触发它的转移上
    expect(trace.records[0].effects.map((e) => e.kind)).toEqual(["llm"]);
    const tool = trace.records[2].effects[0] as any;
    expect(tool).toMatchObject({ kind: "tool", name: "calculator", ok: true, resultPreview: "2" });
    expect(typeof tool.durationMs).toBe("number");
    const answer = trace.records[4].effects.find((e) => e.kind === "answer") as any;
    expect(answer).toMatchObject({ stoppedBy: "final", answer: "2" });
    expect(typeof answer.totalMs).toBe("number");
    // 不再有独立的 stop 记录：终态转移就是结束记录
    expect(trace.records.at(-1)?.to).toBe("done");
  });
});
