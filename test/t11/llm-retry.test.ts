import { describe, it, expect } from "vitest";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";
import type { ChatMessage, LLMClient, LLMResponse } from "../../src/llm/types.js";

// #11：模型调用失败按错误类型决定重不重试。断言打在用户可见契约上：
// 返回值（stoppedBy、答案含状态码）、假客户端被调用的次数、trace 里 llm effect 的逐次尝试明细、注入的 sleep 收到的等待毫秒。

/** 按脚本抛错 / 回答的假客户端：script 里是 Error 就 throw，是字符串就回复 */
function scripted(script: Array<Error | string>): LLMClient & { calls: number } {
  const client = {
    model: "scripted",
    calls: 0,
    async chat(_m: ChatMessage[]): Promise<LLMResponse> {
      client.calls++;
      const next = script.shift();
      if (next === undefined) throw new Error("脚本用完了");
      if (next instanceof Error) throw next;
      return { text: next };
    },
  };
  return client;
}
const fail = (message: string, extra: Record<string, unknown>) => Object.assign(new Error(message), extra);
const fakeSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
};

describe("模型调用重试按错误类型分类（#11）", () => {
  it("401 只调一次即 error 终态，答案含状态码，不等待", async () => {
    const llm = scripted([fail("Incorrect API key provided", { status: 401 }), "<final>不该到这</final>"]);
    const trace = new MemoryTraceSink();
    const { waits, sleep } = fakeSleep();
    const r = await createAgent({ llm, trace, sleep }).run({ userId: "u1", sessionId: "s1", input: "hi" });
    expect(r.stoppedBy).toBe("error");
    expect(r.answer).toMatch(/401/);
    expect(llm.calls).toBe(1);
    expect(waits).toEqual([]);
    const fx = trace.effects("llm");
    expect(fx.length).toBe(1);
    expect(fx[0].attempts).toBe(1);
    expect(fx[0].tries).toEqual([{ n: 1, errorClass: "auth", waitMs: 0 }]);
  });

  it("429 三次后仍失败才 error：trace 上能看到三次尝试与各自等待（300 / 600 / 0）", async () => {
    const llm = scripted([fail("Rate limit reached", { status: 429 }), fail("Rate limit reached", { status: 429 }), fail("Rate limit reached", { status: 429 }), "<final>不该到这</final>"]);
    const trace = new MemoryTraceSink();
    const { waits, sleep } = fakeSleep();
    const r = await createAgent({ llm, trace, sleep }).run({ userId: "u1", sessionId: "s1", input: "hi" });
    expect(r.stoppedBy).toBe("error");
    expect(r.answer).toMatch(/429/);
    expect(llm.calls).toBe(3);
    expect(waits).toEqual([300, 600]);
    const fx = trace.effects("llm");
    expect(fx.length).toBe(1);
    expect(fx[0].attempts).toBe(3);
    expect(fx[0].tries).toEqual([
      { n: 1, errorClass: "rate_limited", waitMs: 300 },
      { n: 2, errorClass: "rate_limited", waitMs: 600 },
      { n: 3, errorClass: "rate_limited", waitMs: 0 },
    ]);
    expect(trace.sequence()).toEqual(["t-llm-failed"]);
  });

  it.each([
    ["超时 ETIMEDOUT", fail("connect ETIMEDOUT", { code: "ETIMEDOUT" }), "timeout"],
    ["网络 ECONNRESET", fail("read ECONNRESET", { code: "ECONNRESET" }), "network"],
    ["服务端 503", fail("Service Unavailable", { status: 503 }), "server"],
  ])("%s 归入可重试类：失败两次后第三次成功，本轮正常 final", async (_name, e, cls) => { // ×3
    const llm = scripted([e, e, "<final>第三次才通</final>"]);
    const trace = new MemoryTraceSink();
    const { waits, sleep } = fakeSleep();
    const r = await createAgent({ llm, trace, sleep }).run({ userId: "u1", sessionId: "s1", input: "hi" });
    expect(r.stoppedBy).toBe("final");
    expect(r.answer).toBe("第三次才通");
    expect(llm.calls).toBe(3);
    expect(waits).toEqual([300, 600]);
    const fx = trace.effects("llm");
    expect(fx.length).toBe(1);
    expect(fx[0].attempts).toBe(3);
    expect(fx[0].tries).toEqual([
      { n: 1, errorClass: cls, waitMs: 300 },
      { n: 2, errorClass: cls, waitMs: 600 },
    ]);
  });

  it("成功的一次调用：attempts=1、tries 为空", async () => {
    const llm = scripted(["<final>一次就好</final>"]);
    const trace = new MemoryTraceSink();
    const { waits, sleep } = fakeSleep();
    const r = await createAgent({ llm, trace, sleep }).run({ userId: "u1", sessionId: "s1", input: "hi" });
    expect(r.answer).toBe("一次就好");
    expect(waits).toEqual([]);
    expect(trace.effects("llm")[0]).toMatchObject({ attempts: 1, tries: [] });
  });
});
