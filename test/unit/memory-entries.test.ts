import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLLM } from "../../src/llm/fake.js";
import { createAgent } from "../../src/runtime/agent.js";
import { MemoryTraceSink } from "../../src/runtime/trace.js";
import { FileUserMemoryStore, MemoryUserMemoryStore, renderMemory } from "../../src/memory/user-memory.js";
import type { MemoryEntry } from "../../src/review/types.js";

const tc = (name: string, args: object) => `<tool_call>${JSON.stringify({ name, arguments: args })}</tool_call>`;
/** 第 i 次模型调用的 system prompt 里的记忆块（用户可见契约：模型收到的文本） */
const memoryBlockOf = (llm: FakeLLM, i: number) => /<memory>[\s\S]*<\/memory>/.exec(llm.calls[i][0].content)?.[0] ?? "";
const entry = (p: Partial<MemoryEntry> & Pick<MemoryEntry, "key" | "value">): MemoryEntry => ({
  kind: "stated", confidence: 1, source: { sessionId: "s", turn: 1 }, date: "2026-09-14", status: "active", ...p,
});

describe("记忆条目：remember 写 stated 条目（#19 R3）", () => {
  it("remember 后 entries 里那条是 kind=stated / confidence=1 / source=当前会话与轮次 / status=active；load() 的 KV 视图仍是 key→value", async () => {
    const memory = new MemoryUserMemoryStore();
    const llm = new FakeLLM(["<final>ok</final>", tc("remember", { key: "city", value: "上海" }), "<final>记住了</final>"]);
    const agent = createAgent({ llm, memory });
    await agent.run({ userId: "A", sessionId: "w1", input: "hi" });
    await agent.run({ userId: "A", sessionId: "w1", input: "我在上海" });
    const entries = memory.entries("A");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "city", value: "上海", kind: "stated", confidence: 1, source: { sessionId: "w1", turn: 2 }, status: "active" });
    expect(entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(memory.load("A")).toEqual({ city: "上海" });
  });

  it("同 key 不同值：旧条目保留 active、load() 仍是旧值（不覆盖）；新条目 status=conflict 且 conflictWith=旧值；下一轮 system prompt 渲染成「（待确认：昨天说 新值，之前记 旧值）」", async () => {
    const memory = new MemoryUserMemoryStore();
    const llm = new FakeLLM([
      tc("remember", { key: "city", value: "上海" }), "<final>记住了</final>",
      tc("remember", { key: "city", value: "北京" }), "<final>记住了</final>",
      "<final>ok</final>",
    ]);
    const agent = createAgent({ llm, memory });
    await agent.run({ userId: "A", sessionId: "w1", input: "我在上海" });
    await agent.run({ userId: "A", sessionId: "w2", input: "我在北京" });
    await agent.run({ userId: "A", sessionId: "w3", input: "hi" });
    const entries = memory.entries("A");
    expect(entries.map((e) => [e.value, e.status, e.conflictWith])).toEqual([["上海", "active", undefined], ["北京", "conflict", "上海"]]);
    expect(entries[1].source).toEqual({ sessionId: "w2", turn: 1 });
    expect(memory.load("A")).toEqual({ city: "上海" });
    const block = memoryBlockOf(llm, 4);
    expect(block).toContain("- city: 上海");
    expect(block).toContain("（待确认：昨天说 北京，之前记 上海）");
  });

  it("同 key 同值：不新增条目，只刷新 date 与 source（指向最新那轮）", async () => {
    const memory = new MemoryUserMemoryStore();
    memory.upsert("A", entry({ key: "city", value: "上海", source: { sessionId: "old", turn: 1 }, date: "2020-01-01" }));
    const llm = new FakeLLM([tc("remember", { key: "city", value: "上海" }), "<final>记住了</final>"]);
    await createAgent({ llm, memory }).run({ userId: "A", sessionId: "w9", input: "我在上海" });
    const entries = memory.entries("A");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: "city", value: "上海", status: "active", source: { sessionId: "w9", turn: 1 } });
    expect(entries[0].date).not.toBe("2020-01-01");
  });
});

describe("记忆条目：渲染与预算丢弃顺序（#19 Q6）", () => {
  it("inferred 条目在 system prompt 里带「（推断）」；load() 的 KV 视图不含 inferred", async () => {
    const memory = new MemoryUserMemoryStore();
    memory.upsert("A", entry({ key: "city", value: "上海" }));
    memory.upsert("A", entry({ key: "lang", value: "中文", kind: "inferred", confidence: 0.6 }));
    const llm = new FakeLLM(["<final>ok</final>"]);
    await createAgent({ llm, memory }).run({ userId: "A", sessionId: "w1", input: "hi" });
    const block = memoryBlockOf(llm, 0);
    expect(block).toContain("- city: 上海\n");
    expect(block).toContain("- lang: 中文（推断）");
    expect(memory.load("A")).toEqual({ city: "上海" });
  });

  it("预算不够时先丢 conflict，再丢 inferred（confidence 低的先），stated 之间最老的先丢；保留的条目仍按写入顺序；trace 里 memory_truncated 的数字对得上", async () => {
    const memory = new MemoryUserMemoryStore();
    memory.upsert("A", entry({ key: "city", value: "上海", date: "2026-09-10" })); // stated，最老
    memory.upsert("A", entry({ key: "lang", value: "中文", kind: "inferred", confidence: 0.3, date: "2026-09-11" }));
    memory.upsert("A", entry({ key: "food", value: "辣", kind: "inferred", confidence: 0.8, date: "2026-09-12" }));
    memory.upsert("A", entry({ key: "name", value: "小张", date: "2026-09-13" })); // stated，最新
    memory.upsert("A", entry({ key: "city", value: "北京", date: "2026-09-14" })); // → conflict
    const all = memory.entries("A");
    expect(all.map((e) => e.status)).toEqual(["active", "active", "active", "active", "conflict"]);

    const full = renderMemory(all).block;
    const lines = full.split("\n").slice(1, -1);
    expect(lines).toEqual(["- city: 上海", "- lang: 中文（推断）", "- food: 辣（推断）", "- name: 小张", "- city（待确认：昨天说 北京，之前记 上海）"]);
    const drop = (limit: number, line: string) => limit - line.length - 1; // 少一行 = 少这行加一个换行
    const l4 = drop(full.length, lines[4]); // 刚好装不下 5 条
    const l3 = drop(l4, lines[1]);
    const l2 = drop(l3, lines[2]);
    const l1 = drop(l2, lines[0]);
    const keptLines = (limit: number) => renderMemory(all, limit).block.split("\n").slice(1, -1);
    expect(keptLines(l4)).toEqual(["- city: 上海", "- lang: 中文（推断）", "- food: 辣（推断）", "- name: 小张"]); // 先丢 conflict
    expect(keptLines(l3)).toEqual(["- city: 上海", "- food: 辣（推断）", "- name: 小张"]); // 再丢低置信度的 inferred
    expect(keptLines(l2)).toEqual(["- city: 上海", "- name: 小张"]); // 再丢高置信度的 inferred
    expect(keptLines(l1)).toEqual(["- name: 小张"]); // stated 之间最老先丢
    expect(renderMemory(all, l3).truncated).toEqual({ total: 5, kept: 3 });

    const llm = new FakeLLM(["<final>ok</final>"]);
    const trace = new MemoryTraceSink();
    await createAgent({ llm, memory, trace, context: { memoryMaxChars: l3 } }).run({ userId: "A", sessionId: "w1", input: "hi" });
    const block = memoryBlockOf(llm, 0);
    expect(block.length).toBeLessThanOrEqual(l3);
    expect(block).not.toContain("待确认");
    expect(block).not.toContain("lang");
    expect(block).toContain("- food: 辣（推断）");
    expect(trace.effects("memory_truncated")[0]).toMatchObject({ total: 5, kept: 3, limit: l3 });
  });
});

describe("记忆条目：旧格式文件兼容（#19 Q3）", () => {
  it("盘上是 #12 的纯 KV 对象时读为 stated / confidence 1 / source legacy，load() 与旧值一致；upsert 一次后文件转成 entries 格式、旧条目还在、新实例读回 conflict", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-mem-"));
    writeFileSync(join(dir, "A.memory.json"), JSON.stringify({ city: "上海", name: "小张" }, null, 2));
    const store = new FileUserMemoryStore(dir);
    expect(store.load("A")).toEqual({ city: "上海", name: "小张" });
    const entries = store.entries("A");
    expect(entries.map((e) => e.key)).toEqual(["city", "name"]);
    for (const e of entries) expect(e).toMatchObject({ kind: "stated", confidence: 1, source: { sessionId: "legacy", turn: 0 }, status: "active" });
    store.upsert("A", entry({ key: "city", value: "北京", source: { sessionId: "w1", turn: 3 } }));
    const onDisk = JSON.parse(readFileSync(join(dir, "A.memory.json"), "utf8"));
    expect(onDisk.entries.map((e: MemoryEntry) => [e.key, e.value, e.status])).toEqual([["city", "上海", "active"], ["name", "小张", "active"], ["city", "北京", "conflict"]]);
    const again = new FileUserMemoryStore(dir);
    expect(again.load("A")).toEqual({ city: "上海", name: "小张" });
    expect(again.entries("A")[2]).toMatchObject({ conflictWith: "上海", source: { sessionId: "w1", turn: 3 } });
  });
});
