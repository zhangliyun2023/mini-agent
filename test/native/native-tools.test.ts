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

// ---- 发给厂商的线上形状：起一个本地 HTTP 端点收 OpenAICompatibleLLM 真正 POST 出去的 body ----
import { createServer, type Server } from "node:http";
import { OpenAICompatibleLLM } from "../../src/llm/openai-compatible.js";
import { defaultTools } from "../../src/runtime/agent.js";

type Wire = { messages: any[]; tools?: any[] };
async function captureServer(replies: Array<{ content?: string; tool_calls?: any[] }>): Promise<{ server: Server; baseURL: string; bodies: Wire[]; close: () => Promise<void> }> {
  const bodies: Wire[] = [];
  const queue = [...replies];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      const r = queue.shift() ?? { content: "脚本用完了" };
      const message = { role: "assistant", content: r.content ?? null, ...(r.tool_calls ? { tool_calls: r.tool_calls } : {}) };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message, finish_reason: r.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as any).port;
  return { server, baseURL: `http://127.0.0.1:${port}/v1`, bodies, close: () => new Promise((ok) => server.close(() => ok())) };
}
const fn = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });

describe("#10 原生模式：OpenAICompatibleLLM 发给厂商的 messages", () => {
  it("tool_calls 回放为 assistant.tool_calls + role=tool/tool_call_id（不降级成 user）；带工具的追问把上一轮的这对消息原样回放；tools 经 API 字段给、system 不教标签", async () => {
    const cap = await captureServer([
      { tool_calls: [fn("call_abc", "calculator", { expression: "99*99" })] },
      { content: "结果是 9801" },
      { tool_calls: [fn("call_def", "calculator", { expression: "9801+1" })] },
      { content: "9802" },
    ]);
    try {
      const memory = new MemoryUserMemoryStore();
      const tools = defaultTools(memory);
      const llm = new OpenAICompatibleLLM({ apiKey: "k", baseURL: cap.baseURL, model: "m", nativeTools: tools.specs(), timeoutMs: 5_000 });
      const agent = createAgent({ llm, tools, memory, llmRetries: 0 });
      const r1 = await agent.run({ userId: "u", sessionId: "s", input: "算 99*99" });
      expect(r1.answer).toBe("结果是 9801");
      const r2 = await agent.run({ userId: "u", sessionId: "s", input: "再加 1" });
      expect(r2.answer).toBe("9802");
      expect(cap.bodies).toHaveLength(4);

      // 第一次请求：工具只经 tools 字段给，system 不含标签协议
      expect(cap.bodies[0].tools?.map((t) => t.function.name)).toEqual(["calculator", "search", "todo", "remember"]);
      expect(cap.bodies[0].messages[0].role).toBe("system");
      expect(cap.bodies[0].messages[0].content).not.toContain("<tool_call>");

      // 第二次请求：assistant.tool_calls 与紧跟的 tool 消息一一对应，没有「[工具 … 的结果]」降级
      const m2 = cap.bodies[1].messages;
      const ai = m2.findIndex((m) => m.role === "assistant");
      expect(m2[ai].tool_calls).toEqual([fn("call_abc", "calculator", { expression: "99*99" })]);
      expect(m2[ai + 1]).toMatchObject({ role: "tool", tool_call_id: "call_abc", content: "9801" });
      expect(m2.some((m) => m.role === "user" && String(m.content).includes("[工具"))).toBe(false);

      // 第二轮第一次请求：历史里的那对消息原样回放，最终答案没有 <final> 包裹
      const m3 = cap.bodies[2].messages;
      const hist = m3.findIndex((m) => m.role === "assistant" && m.tool_calls);
      expect(hist).toBeGreaterThan(0);
      expect(m3[hist].tool_calls[0].id).toBe("call_abc");
      expect(m3[hist + 1]).toMatchObject({ role: "tool", tool_call_id: "call_abc" });
      expect(m3[hist + 2]).toMatchObject({ role: "assistant", content: "结果是 9801" });
      expect(JSON.stringify(m3)).not.toContain("<final>");
      expect(JSON.stringify(m3)).not.toContain("<tool_call>");
      // 第二轮第二次请求：新一对 call_def 也对上
      const m4 = cap.bodies[3].messages;
      expect(m4.at(-2)?.tool_calls?.[0]?.id).toBe("call_def");
      expect(m4.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_def", content: "9802" });
    } finally {
      await cap.close();
    }
  });

  it("文本模式不变：不传 tools 字段，工具结果仍降级为带前缀的 user 消息，system 仍教标签", async () => {
    const cap = await captureServer([{ content: `<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>` }, { content: "<final>2</final>" }]);
    try {
      const memory = new MemoryUserMemoryStore();
      const tools = defaultTools(memory);
      const llm = new OpenAICompatibleLLM({ apiKey: "k", baseURL: cap.baseURL, model: "m", timeoutMs: 5_000 });
      const r = await createAgent({ llm, tools, memory, llmRetries: 0 }).run({ userId: "u", sessionId: "s", input: "1+1" });
      expect(r.answer).toBe("2");
      expect(cap.bodies[0].tools).toBeUndefined();
      expect(cap.bodies[0].messages[0].content).toContain("<tool_call>");
      const m2 = cap.bodies[1].messages;
      expect(m2.some((m) => m.role === "tool")).toBe(false);
      expect(m2.at(-1)).toMatchObject({ role: "user", content: "[工具 calculator 的结果]\n2" });
    } finally {
      await cap.close();
    }
  });
});
