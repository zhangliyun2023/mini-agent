import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { FileSessionStore } from "../../src/session/store.js";
import { FileTranscriptStore, MemoryTranscriptStore, type TranscriptLine } from "../../src/review/transcript.js";

// #19 R1：轮末写不压缩的逐轮转写（Raw 层）。复盘只读转写，不读 session.history。
// 断言全部落在用户可见契约上：盘上 JSONL 每行内容、ts 单调、与历史的 role/content 一致、读回保序、list 只见本用户。

const tc = (name: string, args: Record<string, unknown>) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
const readLines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as TranscriptLine);
const isIso = (s: unknown) => typeof s === "string" && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

describe("轮末写转写：data/transcripts/<user>/<session>.jsonl 每行 {ts, userId, sessionId, turn, traceId, role, content, name?}", () => {
  function build(dir: string, script: string[]) {
    const llm = new FakeLLM(script);
    return createAgent({ llm, llmRetries: 0, sessions: new FileSessionStore(join(dir, "sessions")), transcripts: new FileTranscriptStore(join(dir, "transcripts")) });
  }

  it("Given 文件转写存储，When 跑两轮（第二轮带工具），Then 盘上 JSONL 每行有 ISO ts 且单调不减、role/content 逐条等于历史、turn/traceId 对上、user 的 ts 不晚于同轮其余行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-transcript-"));
    const agent = build(dir, ["<final>你好</final>", tc("calculator", { expression: "6*7" }), "<final>答案是 42</final>"]);
    const r1 = await agent.run({ userId: "A", sessionId: "w1", input: "hi" });
    const r2 = await agent.run({ userId: "A", sessionId: "w1", input: "6*7=?" });
    const path = join(dir, "transcripts", "A", "w1.jsonl");
    expect(existsSync(path), path).toBe(true);
    const lines = readLines(path);
    const history = agent.sessions.get("A", "w1").history;
    // 与写进历史的是同一批消息：role/content 逐条相等，assistant 保留 <final> 标签原样
    expect(lines.map((l) => ({ role: l.role, content: l.content }))).toEqual(history.map((m) => ({ role: m.role, content: m.content })));
    expect(lines.filter((l) => l.role === "assistant").map((l) => l.content)).toEqual(["<final>你好</final>", tc("calculator", { expression: "6*7" }), "<final>答案是 42</final>"]);
    // 每行都带身份与轮次
    for (const l of lines) {
      expect(isIso(l.ts), `ts 不是 ISO 时间：${JSON.stringify(l.ts)}`).toBe(true);
      expect(l.userId).toBe("A");
      expect(l.sessionId).toBe("w1");
    }
    expect(lines.filter((l) => l.turn === 1).map((l) => l.traceId)).toEqual(Array(2).fill(r1.traceId));
    expect(lines.filter((l) => l.turn === 2).map((l) => l.traceId)).toEqual(Array(4).fill(r2.traceId));
    // role=tool 的行带 name
    expect(lines.find((l) => l.role === "tool")?.name).toBe("calculator");
    expect(lines.find((l) => l.role === "user")?.name).toBeUndefined();
    // ts 单调不减；user 行的 ts = 轮开始，不晚于同轮其余行
    const ts = lines.map((l) => Date.parse(l.ts));
    for (let i = 1; i < ts.length; i++) expect(ts[i], `第 ${i + 1} 行 ts 早于前一行`).toBeGreaterThanOrEqual(ts[i - 1]);
    for (const turn of [1, 2]) {
      const rows = lines.filter((l) => l.turn === turn);
      const userTs = Date.parse(rows.find((l) => l.role === "user")!.ts);
      for (const l of rows) expect(Date.parse(l.ts)).toBeGreaterThanOrEqual(userTs);
    }
  });

  it("Given 盘上已有两轮转写，When 用新实例 read，Then 顺序与文件逐行一致；list 只见本用户的会话", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mini-agent-transcript-"));
    const agent = build(dir, ["<final>一</final>", "<final>二</final>", "<final>B 的</final>"]);
    await agent.run({ userId: "A", sessionId: "w1", input: "1" });
    await agent.run({ userId: "A", sessionId: "w1", input: "2" });
    await agent.run({ userId: "B", sessionId: "w9", input: "b" });
    const store = new FileTranscriptStore(join(dir, "transcripts"));
    const onDisk = readLines(join(dir, "transcripts", "A", "w1.jsonl"));
    expect(store.read("A", "w1")).toEqual(onDisk);
    expect(store.read("A", "w1").map((l) => [l.turn, l.role, l.content])).toEqual([[1, "user", "1"], [1, "assistant", "<final>一</final>"], [2, "user", "2"], [2, "assistant", "<final>二</final>"]]);
    expect(store.list("A")).toEqual(["w1"]);
    expect(store.list("B")).toEqual(["w9"]);
    expect(store.list("nobody")).toEqual([]);
    expect(store.read("A", "w9")).toEqual([]);
  });

  it("Given 不传 transcripts（默认内存实现），When 跑一轮，Then agent.transcripts 读回的 role/content 与历史一致；MemoryTranscriptStore.list 只见本用户", async () => {
    const agent = createAgent({ llm: new FakeLLM(["<final>ok</final>", "<final>b</final>"]), llmRetries: 0 });
    await agent.run({ userId: "A", sessionId: "s", input: "go" });
    await agent.run({ userId: "B", sessionId: "t", input: "go" });
    const lines = agent.transcripts.read("A", "s");
    expect(lines.map((l) => [l.role, l.content])).toEqual([["user", "go"], ["assistant", "<final>ok</final>"]]);
    expect(lines.every((l) => l.turn === 1 && l.traceId === "A/s/1" && isIso(l.ts))).toBe(true);
    expect(agent.transcripts.list("A")).toEqual(["s"]);
    expect(agent.transcripts.list("B")).toEqual(["t"]);
    const m = new MemoryTranscriptStore();
    expect(m.read("A", "s")).toEqual([]);
  });

  it("Given 模型输出带 <think>，When 落转写，Then 转写里的 assistant 内容已剥 think（与历史同一批）", async () => {
    const agent = createAgent({ llm: new FakeLLM(["<think>想一想</think><final>剥掉了</final>"]), llmRetries: 0 });
    await agent.run({ userId: "A", sessionId: "s", input: "go" });
    const lines = agent.transcripts.read("A", "s");
    expect(lines.map((l) => l.content)).toEqual(["go", "<final>剥掉了</final>"]);
    expect(agent.sessions.get("A", "s").history.map((m) => m.content)).toEqual(["go", "<final>剥掉了</final>"]);
  });
});
