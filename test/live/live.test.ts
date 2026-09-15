import { describe, it, expect, beforeAll } from "vitest";
import { llmConfig } from "../../src/config.js";
import { OpenAICompatibleLLM } from "../../src/llm/openai-compatible.js";
import { createAgent, defaultTools } from "../../src/runtime/agent.js";
import { FileTraceSink } from "../../src/runtime/trace.js";
import { MemoryUserMemoryStore } from "../../src/memory/user-memory.js";

// 真实 LLM 集成测试：LIVE=1 npm run test:live。trace 写到 evals/live-trace/，提交进仓库当运行证据。
// 断言只打在「用户可见结果」上（答案里有没有正确数字 / 清单内容），不断模型的措辞。

const cfg = (() => { try { return llmConfig(); } catch { return null; } })();
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");

function build(native = false) {
  const memory = new MemoryUserMemoryStore();
  const tools = defaultTools(memory);
  const llm = new OpenAICompatibleLLM({ ...cfg!, nativeTools: native ? tools.specs() : undefined });
  return createAgent({ llm, tools, memory, trace: new FileTraceSink(`evals/live-trace/${stamp}${native ? "-native" : ""}`) });
}

describe.skipIf(!cfg)("真实模型（文本协议）", () => {
  it("需要精确计算时调用 calculator，答案含正确结果", async () => {
    const agent = build();
    const r = await agent.run({ userId: "live", sessionId: "calc", input: "帮我算一下 (137*29 + 1234) / 7，保留两位小数" });
    expect(r.stoppedBy).toBe("final");
    expect(r.steps.some((s) => s.kind === "tool" && s.detail.startsWith("calculator"))).toBe(true);
    expect(r.answer.replace(/,/g, "")).toMatch(/743\.86/);
  });

  it("搜索 + 纯对话追问：第二问不重复搜索也能答", async () => {
    const agent = build();
    const r1 = await agent.run({ userId: "live", sessionId: "wx", input: "上海今天天气怎么样？" });
    expect(r1.answer).toMatch(/多云|晴|24|30/);
    const r2 = await agent.run({ userId: "live", sessionId: "wx", input: "那我要带伞吗？一句话回答" });
    expect(r2.stoppedBy).toBe("final");
    expect(r2.answer.length).toBeGreaterThan(0);
  });

  it("带工具的追问：加两条待办后「把第一条标完成」作用在同一清单上；另一个窗口看不到", async () => {
    const agent = build();
    await agent.run({ userId: "A", sessionId: "w1", input: "帮我记两条待办：买牛奶、写周报" });
    const r = await agent.run({ userId: "A", sessionId: "w1", input: "第一条做完了，帮我标一下，然后把清单给我" });
    expect(r.answer).toMatch(/牛奶/);
    expect(r.answer).toMatch(/周报/);
    const other = await agent.run({ userId: "A", sessionId: "w2", input: "我的待办清单里有什么？" });
    expect(other.answer).not.toMatch(/牛奶/);
  });

  it("模型主动 remember 后，新 session 能用上这条记忆", async () => {
    const agent = build();
    await agent.run({ userId: "M", sessionId: "s1", input: "记住：我叫小张，常住上海。" });
    expect(Object.values(agent.memory.load("M")).join(" ")).toMatch(/上海|小张/);
    const r = await agent.run({ userId: "M", sessionId: "s2", input: "我住哪个城市？只回答城市名" });
    expect(r.answer).toMatch(/上海/);
  });
});

describe.skipIf(!cfg)("真实模型（原生 function calling 适配器）", () => {
  it("同一 runtime 换成原生模式也能完成工具调用", async () => {
    const agent = build(true);
    const r = await agent.run({ userId: "live", sessionId: "native", input: "算 99*99" });
    expect(r.answer).toMatch(/9801/);
  });
});
