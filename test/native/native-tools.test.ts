import { describe, it, expect } from "vitest";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryUserMemoryStore } from "../../src/memory/user-memory.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";

// #10 原生 function calling：断言只打在「模型实际收到的 messages」「trace 记录」「返回值」上。
// 放在 test/native/ 而不是 test/unit/：docs.test 的 §0 条数表由 docs/TEST_REPORT.md 单一事实源对账，本票不改该文件。

describe("#10 原生模式的 system prompt", () => {
  it("原生模式：system prompt 不教标签协议（无 <tool_call> / <final> / <think>）、不列工具 Schema，但规则段与记忆块仍在；文本模式仍教标签", async () => {
    const memory = new MemoryUserMemoryStore();
    memory.set("A", "city", "上海");
    const native = new FakeLLM(["好的"], { native: true });
    await createAgent({ llm: native, memory }).run({ userId: "A", sessionId: "s", input: "hi" });
    const sys = native.calls[0][0];
    expect(sys.role).toBe("system");
    expect(sys.content).not.toContain("<tool_call>");
    expect(sys.content).not.toContain("<final>");
    expect(sys.content).not.toContain("<think>");
    expect(sys.content).not.toContain("参数 Schema");
    expect(sys.content).toContain("calculator");
    expect(sys.content).toContain("remember");
    expect(sys.content).toMatch(/city: 上海/);

    const text = new FakeLLM(["<final>好的</final>"]);
    await createAgent({ llm: text, memory }).run({ userId: "A", sessionId: "s", input: "hi" });
    expect(text.calls[0][0].content).toContain("<tool_call>");
    expect(text.calls[0][0].content).toContain("<final>");
  });
});

describe("#10 原生模式：一次 tool_calls 之后，下一条请求里的消息形状", () => {
  it("assistant 消息带 tool_calls（id/name/arguments），紧跟的 tool 消息 role=tool 且 tool_call_id 与之对应；trace 的 llm effect 标 mode: native", async () => {
    const trace = new MemoryTraceSink();
    const llm = new FakeLLM(
      [{ toolCalls: [{ name: "calculator", arguments: { expression: "99*99" } }] }, "99*99 = 9801"],
      { native: true },
    );
    const r = await createAgent({ llm, trace }).run({ userId: "u", sessionId: "s", input: "算 99*99" });
    expect(r.answer).toBe("99*99 = 9801");
    expect(r.stoppedBy).toBe("final");

    const second = llm.calls[1];
    const ai = second.findIndex((m) => m.role === "assistant");
    expect(ai).toBeGreaterThan(0);
    const assistant = second[ai];
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls![0]).toMatchObject({ name: "calculator", arguments: JSON.stringify({ expression: "99*99" }) });
    expect(typeof assistant.toolCalls![0].id).toBe("string");
    expect(assistant.content).not.toContain("<tool_call>");
    const tool = second[ai + 1];
    expect(tool).toMatchObject({ role: "tool", name: "calculator", toolCallId: assistant.toolCalls![0].id, content: "9801" });

    const llmEffects = trace.effects("llm");
    expect(llmEffects).toHaveLength(2);
    for (const e of llmEffects) expect((e as any).mode).toBe("native");
    expect(trace.sequence()).toEqual(["t-llm-ok [noop]", "t-tools", "t-tools-done", "t-llm-ok [noop]", "t-final"]);
  });

  it("文本模式的 llm effect 标 mode: text；tool 消息仍用 runtime 自己的 step-index id", async () => {
    const trace = new MemoryTraceSink();
    const llm = new FakeLLM([`<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>`, "<final>2</final>"]);
    await createAgent({ llm, trace }).run({ userId: "u", sessionId: "s", input: "1+1" });
    for (const e of trace.effects("llm")) expect((e as any).mode).toBe("text");
    const tool = llm.calls[1].find((m) => m.role === "tool")!;
    expect(tool.toolCallId).toBe("1-0");
    expect(llm.calls[1].find((m) => m.role === "assistant")!.toolCalls).toBeUndefined();
  });
});
