import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { FileTraceSink, MemoryTraceSink, type TransitionRecord } from "../../src/runtime/trace.js";
import { FileSessionStore, type Session } from "../../src/session/store.js";
import { FileUserMemoryStore } from "../../src/memory/user-memory.js";
import { answerAligned, checkTurnInvariants, exactlyOneFinalAnswer, noToolAfterParseError, terminalStatesDistinct } from "../../src/machine/invariants.js";

// S4：四条 P0 不变量各一条 Given / When / Then，每条一红一绿——
//   绿：真实跑出来的证据通过 oracle；红：把证据篡改成违反的样子，oracle 必须点名。
// oracle 只看用户可见证据（trace 记录、返回值、盘上历史），不碰 runtime 内部。

const tc = (name: string, args: object) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
const BAD = `<tool_call>{"name":"calculator","arguments":{"expression":</tool_call>`;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

async function runOnce(script: Array<string | ((m: any[]) => string)>, opts: { maxToolSteps?: number } = {}) {
  const llm = new FakeLLM(script);
  const trace = new MemoryTraceSink();
  const agent = createAgent({ llm, trace, llmRetries: 0, ...opts });
  const result = await agent.run({ userId: "inv", sessionId: "s", input: "go" });
  const history = agent.sessions.get("inv", "s").history;
  return { result, records: trace.records, history, trace };
}

describe("① 无工具执行于解析失败之后", () => {
  it("绿：Given 模型先输出坏 JSON 再正确调工具，When 跑完一轮，Then oracle 通过且工具只在 PARSED_TOOL_CALLS 之后跑", async () => {
    const { records } = await runOnce([BAD, tc("calculator", { expression: "1+1" }), "<final>2</final>"]);
    expect(noToolAfterParseError(records)).toEqual([]);
    const toolIdx = records.findIndex((r) => r.effects.some((e) => e.kind === "tool"));
    expect(records[toolIdx - 1]).toMatchObject({ event: "PARSED_TOOL_CALLS", status: "allowed" });
  });
  it("红：把 tool 副作用挪到 PARSED_ERROR 转移上，oracle 点名", async () => {
    const { records } = await runOnce([BAD, tc("calculator", { expression: "1+1" }), "<final>2</final>"]);
    const tampered = clone(records);
    const tool = tampered.find((r) => r.effects.some((e) => e.kind === "tool"))!.effects.find((e) => e.kind === "tool")!;
    tampered.find((r) => r.event === "PARSED_ERROR")!.effects.push(tool);
    const v = noToolAfterParseError(tampered);
    expect(v.length).toBeGreaterThan(0);
    expect(v.join("\n")).toMatch(/PARSED_ERROR 转移上挂了/);
  });
});

describe("② 一轮恰一个最终答案", () => {
  it("绿：Given 带工具的一轮，When 结束，Then 恰一条终态转移在末尾、恰一个 answer 副作用、历史里恰一条 <final>", async () => {
    const { records, history } = await runOnce([tc("calculator", { expression: "1+1" }), "<final>2</final>"]);
    expect(exactlyOneFinalAnswer(records, history)).toEqual([]);
  });
  it("红：复制一条终态转移追加到末尾 / 历史里多塞一条 <final>，oracle 都点名", async () => {
    const { records, history } = await runOnce(["<final>hi</final>"]);
    const dup = clone(records);
    dup.push(clone(dup[dup.length - 1]));
    expect(exactlyOneFinalAnswer(dup).join("\n")).toMatch(/终态转移应恰 1 条，实际 2 条/);
    const badHist = [...history, { role: "assistant" as const, content: "<final>第二个答案</final>" }];
    expect(exactlyOneFinalAnswer(records, badHist).join("\n")).toMatch(/<final> 消息应恰 1 条，实际 2 条/);
  });
});

describe("③ 三终态互斥可区分", () => {
  it("绿：final / max_steps / error 三种结束各跑一轮，终态与 stoppedBy 一一对应", async () => {
    const fin = await runOnce(["<final>ok</final>"]);
    const max = await runOnce(Array(3).fill(tc("calculator", { expression: "1+1" })), { maxToolSteps: 2 });
    const err = await runOnce([() => { throw new Error("boom"); }]);
    expect(fin.records.at(-1)!.to).toBe("done");
    expect(max.records.at(-1)!.to).toBe("max_steps");
    expect(err.records.at(-1)!.to).toBe("error");
    for (const x of [fin, max, err]) expect(terminalStatesDistinct(x.records, x.result.stoppedBy)).toEqual([]);
    expect(new Set([fin, max, err].map((x) => x.result.stoppedBy)).size).toBe(3);
  });
  it("红：终态是 done 却报 stoppedBy=error，oracle 点名", async () => {
    const { records } = await runOnce(["<final>ok</final>"]);
    expect(terminalStatesDistinct(records, "error").join("\n")).toMatch(/终态 done 应对应 stoppedBy=final，实际 error/);
  });
});

describe("④ 答案 == 盘上历史末条 == trace 末次决策（FileSessionStore + FileTraceSink 真落盘）", () => {
  function build(dir: string, script: string[]) {
    const llm = new FakeLLM(script);
    return createAgent({ llm, llmRetries: 0, sessions: new FileSessionStore(join(dir, "sessions")), trace: new FileTraceSink(join(dir, "trace")), memory: new FileUserMemoryStore(join(dir, "memory")) });
  }
  const readSession = (dir: string) => JSON.parse(readFileSync(join(dir, "sessions", "A", "w1.json"), "utf8")) as Session;
  const readTrace = (dir: string) => readFileSync(join(dir, "trace", "w1.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TransitionRecord);

  it("绿：Given 文件存储，When 跑一轮带工具的对话，Then 返回值、盘上 JSON 历史末条、盘上 JSONL 末条 answer 三处一致", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-inv4-"));
    const r = await build(dir, [tc("calculator", { expression: "6*7" }), "<final>答案是 42</final>"]).run({ userId: "A", sessionId: "w1", input: "6乘7" });
    const session = readSession(dir);
    const records = readTrace(dir);
    expect(answerAligned({ records, result: r, lastHistoryMessage: session.history.at(-1) })).toEqual([]);
    expect(session.history.at(-1)).toEqual({ role: "assistant", content: "<final>答案是 42</final>" });
    expect((records.at(-1)!.effects.find((e) => e.kind === "answer") as any).answer).toBe("答案是 42");
    // 四条一起跑也全过
    expect(checkTurnInvariants({ records, result: r, lastHistoryMessage: session.history.at(-1) }).every((x) => x.violations.length === 0)).toBe(true);
    // API key 之类的配置不在 trace 里
    expect(readFileSync(join(dir, "trace", "w1.jsonl"), "utf8")).not.toMatch(/apiKey|OPENAI/);
  });

  it("红：篡改盘上 JSON 的历史末条，oracle 点名；篡改 JSONL 末条 answer，oracle 也点名", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-inv4-"));
    const r = await build(dir, ["<final>真答案</final>"]).run({ userId: "A", sessionId: "w1", input: "hi" });
    const session = readSession(dir);
    session.history[session.history.length - 1].content = "<final>被改过的答案</final>";
    writeFileSync(join(dir, "sessions", "A", "w1.json"), JSON.stringify(session));
    const v1 = answerAligned({ records: readTrace(dir), result: r, lastHistoryMessage: readSession(dir).history.at(-1) });
    expect(v1.join("\n")).toMatch(/历史末条 <final> 与返回值不一致/);
    const records = readTrace(dir);
    (records.at(-1)!.effects.find((e) => e.kind === "answer") as any).answer = "trace 里被改过";
    const v2 = answerAligned({ records, result: r, lastHistoryMessage: { role: "assistant", content: "<final>真答案</final>" } });
    expect(v2.join("\n")).toMatch(/trace 末次决策的答案与返回值不一致/);
  });

  it("文件持久化：tmpdir 存 → 新实例读 → 接着聊，第二轮 context 里有第一轮；remember 落盘后新实例可读且 list 能列会话", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-persist-"));
    await build(dir, [tc("remember", { key: "city", value: "上海" }), "<final>上海今天 28 度</final>"]).run({ userId: "A", sessionId: "w1", input: "我在上海，天气怎么样" });
    // 全新的一组实例，只共享目录
    const llm2 = new FakeLLM(["<final>那北京呢</final>"]);
    const agent2 = createAgent({ llm: llm2, sessions: new FileSessionStore(join(dir, "sessions")), trace: new FileTraceSink(join(dir, "trace")), memory: new FileUserMemoryStore(join(dir, "memory")) });
    const r2 = await agent2.run({ userId: "A", sessionId: "w1", input: "北京呢" });
    expect(r2.turn).toBe(2);
    const ctx = llm2.calls[0].map((m) => m.content).join("\n");
    expect(ctx).toContain("我在上海，天气怎么样");
    expect(ctx).toContain("上海今天 28 度");
    expect(ctx).toMatch(/<memory>[\s\S]*city: 上海/);
    expect(agent2.sessions.list("A")).toEqual(["w1"]);
    expect(agent2.sessions.list("B")).toEqual([]);
    expect(readdirSync(join(dir, "trace"))).toEqual(["w1.jsonl"]);
    expect(readTrace(dir).map((x) => x.turn)).toEqual([...Array(readTrace(dir).length)].map((_, i) => (i < 5 ? 1 : 2)));
  });
});
