import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTranscriptStore, type TranscriptLine } from "../../src/review/transcript.js";
import { FileUserMemoryStore } from "../../src/memory/user-memory.js";
import { FileSessionStore } from "../../src/session/store.js";
import { FileReviewJournalStore } from "../../src/review/journal.js";
import { runReview, type ConsolidateFn, type ConsolidateInput } from "../../src/review/run.js";
import { reviewTraceSink, type ReviewTransitionRecord } from "../../src/review/trace.js";
import type { Consolidation, ReviewJournal } from "../../src/review/types.js";
import { formatTransition } from "../../src/runtime/trace.js";
import { defineMachine } from "../../src/machine/interpreter.js";
import { reviewMachine, type ReviewEvent, type ReviewFacts, type ReviewState } from "../../contracts/review.machine.js";

// #19 R7：复盘表是闸——表里没列的 (状态, 事件) 在运行时被拦下。与 agent-loop.test 的「残缺表」同法：从表里抠掉一格再跑真实的 runReview。
// 断言只打用户可见契约：盘上 trace 文件、journal 文件、记忆文件是否存在、整合器有没有被调。

const USER = "A";
const DATE = "2026-09-15";
const TZ = "Asia/Shanghai";
const YDAY = "2026-09-14T10:00:00+08:00";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "mini-agent-review-machine-"));
  const transcripts = new FileTranscriptStore(join(dir, "transcripts"));
  const memory = new FileUserMemoryStore(join(dir, "memory"));
  const sessions = new FileSessionStore(join(dir, "sessions"));
  const journal = new FileReviewJournalStore(join(dir, "reviews"));
  const trace = reviewTraceSink(join(dir, "trace", "reviews"));
  return { dir, transcripts, memory, sessions, journal, trace };
}
const line = (sessionId: string, turn: number, role: TranscriptLine["role"], content: string, ts = YDAY): TranscriptLine => ({ ts, userId: USER, sessionId, turn, traceId: `${USER}/${sessionId}/${turn}`, role, content });
const NORMAL: Consolidation = {
  entries: [{ key: "deadline", value: "9 月 20 日交报告", kind: "inferred", confidence: 0.8, source: { sessionId: "s1", turn: 1 }, date: "2026-09-14", status: "active" }],
  highlights: [{ text: "把复盘报告交给老板", why_today: "due_today", source: { sessionId: "s1", turn: 1 } }],
  method: "llm",
  warnings: [],
};
function fakeConsolidate(result: Consolidation) {
  const calls: ConsolidateInput[] = [];
  const fn: ConsolidateFn = async (input) => {
    calls.push(input);
    return result;
  };
  return { fn, calls };
}
const readJournal = (dir: string) => JSON.parse(readFileSync(join(dir, "reviews", USER, `${DATE}.json`), "utf8")) as ReviewJournal;
const readTrace = (dir: string) => readFileSync(join(dir, "trace", "reviews", `${USER}-${DATE}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l) as ReviewTransitionRecord);

/** 从 review 表里抠掉一个事件的全部行，得到一张残缺表 */
function machineWithout(event: ReviewEvent) {
  return defineMachine<ReviewState, ReviewEvent, ReviewFacts>({ ...reviewMachine, rows: reviewMachine.rows.filter((r) => r.event !== event) });
}

describe("闸：表里没列的 (状态, 事件) 在运行时被拦下", () => {
  it("闸：从表里抠掉 COLLECTED 那格后跑复盘，trace 记一条 status=unknown、整合器没被调、记忆文件不存在、会话没被创建、journal 落 partial_read 并写明未建模转移；throw 模式抛出且同样不执行副作用", async () => {
    // Given 昨天有可读转写但表里没有 (collecting, COLLECTED)，When 跑复盘，Then 取数之后的一切副作用都没发生
    const a = setup();
    a.transcripts.append([line("s1", 1, "user", "我 9 月 20 日要交报告")]);
    const c = fakeConsolidate(NORMAL);
    const r = await runReview({ ...a, consolidate: c.fn, machine: machineWithout("COLLECTED") }, { userId: USER, date: DATE, tz: TZ, deliverTo: "w1" });
    const records = readTrace(a.dir);
    expect(records.map(formatTransition)).toEqual(["rv-start", "collecting --COLLECTED--> failed_partial [unknown]"]);
    expect(records.at(-1)).toMatchObject({ status: "unknown", transition: null, from: "collecting", to: "failed_partial", event: "COLLECTED", trace_id: `review/${USER}/${DATE}`, feature: "review" });
    expect(records.at(-1)!.reason).toMatch(/未在表里列出/);
    expect(c.calls).toHaveLength(0);
    expect(existsSync(join(a.dir, "memory", `${USER}.memory.json`))).toBe(false);
    expect(existsSync(join(a.dir, "sessions"))).toBe(false);
    const j = readJournal(a.dir);
    expect(j).toMatchObject({ status: "partial_read", coverage: "full", attempts: 1, entries_written: 0, brief: null, delivered_to: [] });
    expect(j.warnings?.join("\n")).toMatch(/未建模的状态转移：collecting \+ COLLECTED/);
    expect(r).toEqual({ journal: j, replayed: false });

    // throw 模式（测试用）：同样先记 trace、落 journal，再抛；整合器仍没被调
    const b = setup();
    b.transcripts.append([line("s1", 1, "user", "我 9 月 20 日要交报告")]);
    const c2 = fakeConsolidate(NORMAL);
    await expect(runReview({ ...b, consolidate: c2.fn, machine: machineWithout("COLLECTED"), unknownTransition: "throw" }, { userId: USER, date: DATE, tz: TZ })).rejects.toThrow(/未建模的状态转移：collecting \+ COLLECTED/);
    expect(c2.calls).toHaveLength(0);
    expect(existsSync(join(b.dir, "memory", `${USER}.memory.json`))).toBe(false);
    expect(readTrace(b.dir).map(formatTransition)).toEqual(["rv-start", "collecting --COLLECTED--> failed_partial [unknown]"]);
    expect(readJournal(b.dir).status).toBe("partial_read");
  });

  it("闸拦在更深处也不放水：抠掉 DELIVERED 后，整合、记忆、交付都已按表执行（那之前的行都 allowed），但落终态被拦：journal 记 partial_read 并点名 presenting + DELIVERED，deliver 副作用挂在 unknown 那条上诚实可见", async () => {
    const a = setup();
    a.transcripts.append([line("s1", 1, "user", "我 9 月 20 日要交报告")]);
    const c = fakeConsolidate(NORMAL);
    await runReview({ ...a, consolidate: c.fn, machine: machineWithout("DELIVERED") }, { userId: USER, date: DATE, tz: TZ, deliverTo: "w1" });
    const records = readTrace(a.dir);
    expect(records.map(formatTransition)).toEqual(["rv-start", "rv-collected-full", "rv-consolidated", "rv-presented [noop]", "presenting --DELIVERED--> failed_partial [unknown]"]);
    expect(c.calls).toHaveLength(1);
    expect(existsSync(join(a.dir, "memory", `${USER}.memory.json`))).toBe(true);
    // 交付是 presenting 那一步的副作用（rv-consolidated allowed 之后就该做）；表拦下的是「落终态 + 记 ok」
    expect(records.at(-1)!.effects.map((e) => e.kind)).toEqual(["deliver", "journal"]);
    const j = readJournal(a.dir);
    expect(j).toMatchObject({ status: "partial_read", coverage: "full", entries_written: 1, delivered_to: ["w1"] });
    expect(j.warnings?.join("\n")).toMatch(/未建模的状态转移：presenting \+ DELIVERED/);
  });
});
