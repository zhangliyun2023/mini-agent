import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { interpret, reachable, toContract, type Machine } from "../../src/machine/interpreter.js";
import { turnMachine } from "../../contracts/turn.machine.js";
import { sessionMachine } from "../../contracts/session.machine.js";
import { sessionRuntimeMachine } from "../../contracts/session-runtime.machine.js";
import { reviewMachine } from "../../contracts/review.machine.js";

// S1 / S5：表、契约 JSON、测试三者不许漂（用户故事 42）。
// 漂了怎么修：改表 → npm run contracts:gen → 看 diff 是否是你想要的。
const CONTRACTS: Array<{ name: string; machine: Machine<string, string, any>; path: string }> = [
  { name: "turn", machine: turnMachine, path: "contracts/turn.contract.json" },
  { name: "session", machine: sessionMachine, path: "contracts/session.contract.json" },
  { name: "session-runtime", machine: sessionRuntimeMachine, path: "contracts/session-runtime.contract.json" },
  { name: "review", machine: reviewMachine, path: "contracts/review.contract.json" },
];

/** `file::name` → 文件存在且内容里找得到 name */
function locate(ref: string): string | null {
  const [file, name] = ref.split("::");
  if (!existsSync(file)) return `${ref}：文件 ${file} 不存在`;
  if (!readFileSync(file, "utf8").includes(name)) return `${ref}：在 ${file} 里找不到「${name}」`;
  return null;
}

describe("契约 JSON 与表 0 漂移", () => {
  it.each(CONTRACTS)("盘上 $path == toContract()", ({ machine, path }) => { // ×4
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(toContract(machine));
  });
});

describe("turn 表", () => {
  it("reachable 无不可达状态、无不可达行", () => {
    const r = reachable(turnMachine);
    expect(r.unreachableStates).toEqual([]);
    expect(r.unreachableRows).toEqual([]);
    expect(r.states).toEqual([...turnMachine.states]);
  });

  it("每条 P0 行都有 covered_by，且 covered_by 指向的测试文件与测试名在盘上找得到", () => {
    const p0 = turnMachine.rows.filter((r) => r.priority === "P0");
    expect(p0.length).toBe(turnMachine.rows.length);
    const problems = p0.flatMap((r) => (r.covered_by?.length ? r.covered_by.map(locate).filter(Boolean) : [`行 ${r.from} + ${r.event} 没有 covered_by`]));
    expect(problems).toEqual([]);
  });

  it("每条 enforced 不变量的 evidence 在盘上找得到（实现符号 + 测试名）", () => {
    const enforced = turnMachine.invariants.filter((i) => i.status === "enforced");
    expect(enforced.map((i) => i.id)).toEqual(expect.arrayContaining(["no_tool_after_parse_error", "exactly_one_final_answer", "terminal_states_distinct", "answer_alignment"]));
    const problems = enforced.flatMap((i) => (i.evidence ?? []).map(locate).filter(Boolean));
    expect(problems).toEqual([]);
  });

  it("未列格在契约里诚实可见：5 状态 × 6 事件 = 30 格，8 行落在 6 格，其余 24 格 unlisted", () => {
    const c = toContract(turnMachine);
    expect(c.rows.length).toBe(8);
    expect(c.cells).toMatchObject({ total: 30, listed: 6 });
    expect(c.cells.unlisted.length).toBe(24);
    // 终态没有出边：三终态 × 6 事件 = 18 格全部 unlisted
    expect(c.cells.unlisted.filter((u) => /^(done|max_steps|error) \+/.test(u)).length).toBe(18);
    expect(c.cells.declared_unknown).toEqual([]);
  });
});

describe("session / session-runtime 表（只建表，不接代码）", () => {
  it("session-runtime（#19 ⑦ Q4）：busy + ASYNC_DONE → queued、idle + ASYNC_DONE → executing、queued + TURN_DONE → executing 三格 allowed；busy + INPUT 仍 declared_unknown；运行时不接", () => {
    const c = toContract(sessionRuntimeMachine);
    expect(interpret(sessionRuntimeMachine, "busy", "ASYNC_DONE", {})).toMatchObject({ status: "allowed", to: "queued", row: { id: "sr-async-while-busy" } });
    expect(interpret(sessionRuntimeMachine, "idle", "ASYNC_DONE", {})).toMatchObject({ status: "allowed", to: "executing", row: { id: "sr-async-idle" } });
    expect(interpret(sessionRuntimeMachine, "queued", "TURN_DONE", {})).toMatchObject({ status: "allowed", to: "executing", row: { id: "sr-queued-turn-done" } });
    expect(c.cells.declared_unknown).toContain("busy --INPUT--> busy");
    expect(c.cells.declared_unknown).not.toContain("busy --ASYNC_DONE--> busy");
    expect(c.rows.find((r) => r.id === "sr-input-while-busy")).toMatchObject({ kind: "unknown", signature: "busy --INPUT--> busy" });
    // 表已建模但运行时不接：三行的 reason 都写明单进程 CLI 不可达
    for (const id of ["sr-async-while-busy", "sr-async-idle", "sr-queued-turn-done"]) expect(c.rows.find((r) => r.id === id)?.reason, id).toMatch(/单进程 CLI 不可达/);
    expect(reachable(sessionRuntimeMachine).unreachableStates).toEqual([]);
  });
  it("session：new → active → compacting 三态全可达，rejected / noop 行各至少一条", () => {
    const c = toContract(sessionMachine);
    expect(c.reachable.unreachable_states).toEqual([]);
    expect(c.rows.some((r) => r.kind === "rejected")).toBe(true);
    expect(c.rows.some((r) => r.kind === "noop")).toBe(true);
    expect(c.cells.declared_unknown).toEqual(["compacting --INPUT--> compacting"]);
  });
});

describe("review 表（#19 R7，闸）", () => {
  it("reachable 无不可达状态、无不可达行；三终态无出边（3 × 6 = 18 格全部 unlisted）；无 declared_unknown", () => {
    const r = reachable(reviewMachine);
    expect(r.unreachableStates).toEqual([]);
    expect(r.unreachableRows).toEqual([]);
    expect(r.states).toEqual([...reviewMachine.states]);
    const c = toContract(reviewMachine);
    expect(c.terminal).toEqual(["delivered", "skipped_no_chat", "failed_partial"]);
    expect(c.cells.unlisted.filter((u) => /^(delivered|skipped_no_chat|failed_partial) \+/.test(u)).length).toBe(18);
    expect(c.cells.declared_unknown).toEqual([]);
    // 每个带守卫的格都有无守卫兜底（否则是 guard 洞，explore 会红）
    for (const cell of new Set(reviewMachine.rows.map((x) => `${x.from}|${x.event}`))) {
      const [from, event] = cell.split("|");
      const rows = reviewMachine.cell(from as any, event as any);
      if (rows.some((x) => x.guard)) expect(rows.at(-1)?.guard, cell).toBeUndefined();
    }
  });

  it("每条行都是 P0 且 covered_by 指向的测试文件与测试名在盘上找得到；每条 enforced 不变量的 evidence 在盘上找得到", () => {
    expect(reviewMachine.rows.every((x) => x.priority === "P0")).toBe(true);
    const rowProblems = reviewMachine.rows.flatMap((x) => (x.covered_by?.length ? x.covered_by.map(locate).filter(Boolean) : [`行 ${x.id} 没有 covered_by`]));
    expect(rowProblems).toEqual([]);
    const enforced = reviewMachine.invariants.filter((i) => i.status === "enforced");
    expect(enforced.map((i) => i.id)).toEqual(expect.arrayContaining(["idempotent", "no_overwrite_on_conflict", "every_highlight_has_source", "brief_not_verbatim", "unknown_never_silent"]));
    expect(enforced.flatMap((i) => (i.evidence ?? []).map(locate).filter(Boolean))).toEqual([]);
  });
});
