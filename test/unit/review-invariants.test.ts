import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTranscriptStore, type TranscriptLine } from "../../src/review/transcript.js";
import { FileUserMemoryStore } from "../../src/memory/user-memory.js";
import { FileSessionStore } from "../../src/session/store.js";
import { FileReviewJournalStore } from "../../src/review/journal.js";
import { runReview, type ConsolidateFn } from "../../src/review/run.js";
import { reviewTraceSink } from "../../src/review/trace.js";
import { briefNotVerbatim, everyHighlightHasSource, idempotent, noOverwriteOnConflict } from "../../src/review/invariants.js";
import type { Brief, Consolidation, MemoryEntry, ReviewJournal } from "../../src/review/types.js";

// #19 R7：复盘表的四条 P0 不变量各一红一绿（与 turn 的五条同法）——
//   绿：真实跑 runReview（真落盘）得到的证据通过 oracle；红：把证据篡改成违反的样子，oracle 必须点名。
// oracle 只看用户可见证据：journal 文件、记忆文件、转写行、brief；不碰 runReview 内部。

const USER = "A";
const DATE = "2026-09-15";
const TZ = "Asia/Shanghai";
const YDAY = "2026-09-14T10:00:00+08:00";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mini-agent-review-inv-"));
  const transcripts = new FileTranscriptStore(join(dir, "transcripts"));
  const memory = new FileUserMemoryStore(join(dir, "memory"));
  const sessions = new FileSessionStore(join(dir, "sessions"));
  const journal = new FileReviewJournalStore(join(dir, "reviews"));
  const trace = reviewTraceSink(join(dir, "trace", "reviews"));
  return { dir, transcripts, memory, sessions, journal, trace };
}
const line = (sessionId: string, turn: number, role: TranscriptLine["role"], content: string, ts = YDAY): TranscriptLine => ({ ts, userId: USER, sessionId, turn, traceId: `${USER}/${sessionId}/${turn}`, role, content });
const entry = (key: string, value: string): MemoryEntry => ({ key, value, kind: "inferred", confidence: 0.8, source: { sessionId: "s1", turn: 1 }, date: "2026-09-14", status: "active" });
const NORMAL: Consolidation = {
  entries: [entry("deadline", "9 月 20 日交报告"), entry("project", "PR #19")],
  highlights: [{ text: "把复盘报告交给老板", why_today: "due_today", source: { sessionId: "s1", turn: 1 } }],
  method: "llm",
  warnings: [],
};
const consolidate = (c: Consolidation): ConsolidateFn => async () => c;
const YESTERDAY = [line("s1", 1, "user", "我 9 月 20 日要交报告，老板催得很紧，明天一早就得发出去了"), line("s1", 1, "assistant", "<final>记下了</final>"), line("s1", 2, "user", "另外 PR #19 也要跟进")];
const readJournals = (dir: string) => readdirSync(join(dir, "reviews", USER)).map((f) => JSON.parse(readFileSync(join(dir, "reviews", USER, f), "utf8")) as ReviewJournal);
const readMemory = (dir: string) => (JSON.parse(readFileSync(join(dir, "memory", `${USER}.memory.json`), "utf8")) as { entries: MemoryEntry[] }).entries;

/** 真实跑两次同键复盘，收集盘上证据 */
async function runTwice(c: Consolidation = NORMAL) {
  const d = setup();
  d.transcripts.append(YESTERDAY);
  const deps = { ...d, consolidate: consolidate(c) };
  const first = await runReview(deps, { userId: USER, date: DATE, tz: TZ, deliverTo: "w1" });
  const memoryAfterFirst = readMemory(d.dir);
  const second = await runReview(deps, { userId: USER, date: DATE, tz: TZ, deliverTo: "w1" });
  return { d, first, second, memoryAfterFirst, memoryAfterLast: readMemory(d.dir), journals: readJournals(d.dir) };
}

describe("① 幂等：同键跑 N 次，journal 恰一份、attempts == N、记忆条目数不变", () => {
  it("绿：Given 同键真实跑两次，When 读盘上 journal 与记忆，Then oracle 通过", async () => {
    const { journals, memoryAfterFirst, memoryAfterLast } = await runTwice();
    expect(journals).toHaveLength(1);
    expect(idempotent({ userId: USER, date: DATE, runs: 2, journals, memoryAfterFirst, memoryAfterLast })).toEqual([]);
  });
  it("红：篡改证据——同键多出一份 journal / attempts 没递增 / 记忆条目多了一条，oracle 逐条点名", async () => {
    const { journals, memoryAfterFirst, memoryAfterLast } = await runTwice();
    const dup = idempotent({ userId: USER, date: DATE, runs: 2, journals: [...journals, clone(journals[0])], memoryAfterFirst, memoryAfterLast });
    expect(dup.join("\n")).toMatch(/journal 应恰 1 份，实际 2 份/);
    const stale = idempotent({ userId: USER, date: DATE, runs: 2, journals: [{ ...journals[0], attempts: 1 }], memoryAfterFirst, memoryAfterLast });
    expect(stale.join("\n")).toMatch(/attempts 应为 2，实际 1/);
    const grew = idempotent({ userId: USER, date: DATE, runs: 2, journals, memoryAfterFirst, memoryAfterLast: [...memoryAfterLast, entry("extra", "第二次多写的")] });
    expect(grew.join("\n")).toMatch(/记忆条目数变了：2 → 3/);
  });
});

describe("② 同 key 异值不覆盖：复盘前 active 的 (key, value) 复盘后仍 active，新值只能是 conflict", () => {
  async function runWithExisting() {
    const d = setup();
    d.memory.set(USER, "deadline", "9 月 18 日交报告", { sessionId: "s0", turn: 3 });
    const before = readMemory(d.dir);
    d.transcripts.append(YESTERDAY);
    await runReview({ ...d, consolidate: consolidate(NORMAL) }, { userId: USER, date: DATE, tz: TZ });
    return { before, after: readMemory(d.dir) };
  }
  it("绿：Given 记忆里已有 deadline 旧值，When 复盘写入同 key 新值，Then 盘上旧值仍 active、新值是 conflict，oracle 通过", async () => {
    const { before, after } = await runWithExisting();
    expect(after.map((e) => [e.key, e.status])).toEqual([["deadline", "active"], ["deadline", "conflict"], ["project", "active"]]);
    expect(noOverwriteOnConflict({ before, after })).toEqual([]);
  });
  it("红：把盘上证据篡改成「新值覆盖了旧值」（旧值消失 / 新值 active），oracle 点名", async () => {
    const { before, after } = await runWithExisting();
    const overwritten = after.filter((e) => !(e.key === "deadline" && e.value === "9 月 18 日交报告")).map((e) => (e.key === "deadline" ? { ...e, status: "active" as const, conflictWith: undefined } : e));
    const v = noOverwriteOnConflict({ before, after: overwritten });
    expect(v.length).toBeGreaterThan(0);
    expect(v.join("\n")).toMatch(/deadline.*旧值「9 月 18 日交报告」.*(不见了|不再 active)/);
    expect(v.join("\n")).toMatch(/deadline.*新值「9 月 20 日交报告」.*active/);
  });
});

describe("③ 每条亮点都有真实来源：source 指向昨天转写里存在的 (sessionId, turn)", () => {
  it("绿：Given 真实跑出的 brief，When 对照昨天的转写行，Then 每条亮点的 source 都找得到", async () => {
    const { first } = await runTwice();
    expect(first.journal.brief).not.toBeNull();
    expect(everyHighlightHasSource({ brief: first.journal.brief, lines: YESTERDAY })).toEqual([]);
  });
  it("红：把 source 改成不存在的轮 / 不存在的会话 / 删掉 source，oracle 逐条点名", async () => {
    const { first } = await runTwice();
    const b = first.journal.brief!;
    const badTurn: Brief = { ...b, highlights: [{ ...b.highlights[0], source: { sessionId: "s1", turn: 99 } }] };
    expect(everyHighlightHasSource({ brief: badTurn, lines: YESTERDAY }).join("\n")).toMatch(/s1 第 99 轮.*不存在/);
    const badSession: Brief = { ...b, highlights: [{ ...b.highlights[0], source: { sessionId: "ghost", turn: 1 } }] };
    expect(everyHighlightHasSource({ brief: badSession, lines: YESTERDAY }).join("\n")).toMatch(/ghost 第 1 轮.*不存在/);
    const noSource = { ...b, highlights: [{ text: b.highlights[0].text, why_today: "due_today" }] } as unknown as Brief;
    expect(everyHighlightHasSource({ brief: noSource, lines: YESTERDAY }).join("\n")).toMatch(/没有 source/);
  });
});

describe("④ brief 不复述原话：亮点不与昨天某行去空白后相等，也不是该行 ≥ 20 字的连续子串", () => {
  it("绿：Given 真实跑出的 brief（呈现门槛已过滤逐字重合），When 对照昨天的转写行，Then oracle 通过", async () => {
    const { first } = await runTwice();
    expect(briefNotVerbatim({ brief: first.journal.brief, lines: YESTERDAY })).toEqual([]);
    expect(briefNotVerbatim({ brief: null, lines: YESTERDAY })).toEqual([]);
  });
  it("红：把亮点文本改成昨天原话（整行 / ≥ 20 字子串），oracle 点名；19 字子串不算", async () => {
    const { first } = await runTwice();
    const b = first.journal.brief!;
    const whole: Brief = { ...b, highlights: [{ ...b.highlights[0], text: "另外 PR #19 也要跟进" }] };
    expect(briefNotVerbatim({ brief: whole, lines: YESTERDAY }).join("\n")).toMatch(/与昨天 s1 第 2 轮 user 的原话逐字重合/);
    const long: Brief = { ...b, highlights: [{ ...b.highlights[0], text: "我 9 月 20 日要交报告，老板催得很紧，明天一早" }] };
    expect(briefNotVerbatim({ brief: long, lines: YESTERDAY }).join("\n")).toMatch(/s1 第 1 轮 user/);
    const short: Brief = { ...b, highlights: [{ ...b.highlights[0], text: "老板催得很紧，明天一早就得发出去" }] };
    expect([..."老板催得很紧，明天一早就得发出去"].length).toBeLessThan(20);
    expect(briefNotVerbatim({ brief: short, lines: YESTERDAY })).toEqual([]);
  });
});
