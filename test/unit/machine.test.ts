import { describe, it, expect } from "vitest";
import { defineMachine, enumerate, interpret, reachable, renderContract, toContract, MachineDefinitionError } from "../../src/machine/interpreter.js";

type S = "a" | "b" | "c" | "end";
type E = "GO" | "STAY" | "STOP" | "NEVER";
type F = { n: number };

function sample() {
  return defineMachine<S, E, F>({
    feature: "sample",
    anchor: "test",
    initial: "a",
    states: ["a", "b", "c", "end"],
    terminal: ["end"],
    events: ["GO", "STAY", "STOP", "NEVER"],
    guards: { small: (f) => f.n < 3, big: (f) => f.n >= 3 },
    rows: [
      { from: "a", event: "GO", to: "b", kind: "allowed", guard: "small", reason: "小走 b" },
      { from: "a", event: "GO", to: "c", kind: "allowed", guard: "big", reason: "大走 c" },
      { from: "a", event: "STAY", to: "a", kind: "noop", reason: "原地" },
      { from: "b", event: "STOP", to: "end", kind: "allowed" },
      { from: "b", event: "STAY", to: "b", kind: "rejected", reason: "b 不接受 STAY" },
      { from: "c", event: "NEVER", to: "c", kind: "unknown", reason: "诚实声明：c 收到 NEVER 未建模" },
    ],
  });
}

describe("S0 状态表解释器", () => {
  it("未列组合返回 unknown，不抛，状态不变", () => {
    const m = sample();
    const r = interpret(m, "b", "GO", { n: 0 });
    expect(r.status).toBe("unknown");
    expect(r.to).toBe("b");
    expect(r.reason).toMatch(/未在表里列出/);
    expect(interpret(m, "zzz" as S, "GO", { n: 0 }).status).toBe("unknown");
    expect(interpret(m, "a", "WHAT" as E, { n: 0 }).status).toBe("unknown");
  });

  it("表里显式标 kind:'unknown' 的行，解释结果是 unknown 并带上声明的 reason", () => {
    const r = interpret(sample(), "c", "NEVER", { n: 0 });
    expect(r.status).toBe("unknown");
    expect(r.reason).toMatch(/诚实声明/);
    expect(r.row).toBeDefined();
  });

  it("同格多行按 guard 顺序取首条命中；守卫全不命中也是 unknown", () => {
    const m = sample();
    expect(interpret(m, "a", "GO", { n: 1 })).toMatchObject({ status: "allowed", to: "b", reason: "小走 b" });
    expect(interpret(m, "a", "GO", { n: 5 })).toMatchObject({ status: "allowed", to: "c", reason: "大走 c" });
    // 两条守卫都为真时取定义顺序里的第一条
    const both = defineMachine<S, E, F>({
      feature: "both", anchor: "t", initial: "a", states: ["a", "b", "c", "end"], terminal: ["end"], events: ["GO", "STAY", "STOP", "NEVER"],
      guards: { t1: () => true, t2: () => true },
      rows: [
        { from: "a", event: "GO", to: "c", kind: "allowed", guard: "t2" },
        { from: "a", event: "GO", to: "b", kind: "allowed", guard: "t1" },
      ],
    });
    expect(interpret(both, "a", "GO", { n: 0 }).to).toBe("c");
    const none = defineMachine<S, E, F>({
      feature: "none", anchor: "t", initial: "a", states: ["a", "b", "c", "end"], terminal: ["end"], events: ["GO", "STAY", "STOP", "NEVER"],
      guards: { f: () => false },
      rows: [{ from: "a", event: "GO", to: "b", kind: "allowed", guard: "f" }],
    });
    expect(interpret(none, "a", "GO", { n: 0 })).toMatchObject({ status: "unknown", to: "a" });
    expect(interpret(none, "a", "GO", { n: 0 }).reason).toMatch(/守卫均未命中/);
  });

  it("rejected / noop 行返回对应 status 且不改状态", () => {
    const m = sample();
    expect(interpret(m, "a", "STAY", { n: 0 })).toMatchObject({ status: "noop", to: "a" });
    expect(interpret(m, "b", "STAY", { n: 0 })).toMatchObject({ status: "rejected", to: "b", reason: "b 不接受 STAY" });
  });

  it("定义期校验：终态出边 / 未知守卫 / 无守卫行挡住后面的行 / 非 allowed 行改状态 都在定义时报错", () => {
    const base = { feature: "bad", anchor: "t", initial: "a" as S, states: ["a", "b", "c", "end"] as S[], terminal: ["end"] as S[], events: ["GO", "STAY", "STOP", "NEVER"] as E[] };
    expect(() => defineMachine<S, E, F>({ ...base, rows: [{ from: "end", event: "GO", to: "a", kind: "allowed" }] })).toThrow(MachineDefinitionError);
    expect(() => defineMachine<S, E, F>({ ...base, rows: [{ from: "a", event: "GO", to: "b", kind: "allowed", guard: "nope" }] })).toThrow(/guard "nope" 未定义/);
    expect(() =>
      defineMachine<S, E, F>({
        ...base,
        guards: { g: () => true },
        rows: [
          { from: "a", event: "GO", to: "b", kind: "allowed" },
          { from: "a", event: "GO", to: "c", kind: "allowed", guard: "g" },
        ],
      }),
    ).toThrow(/永远不可达/);
    expect(() => defineMachine<S, E, F>({ ...base, rows: [{ from: "a", event: "GO", to: "b", kind: "rejected" }] })).toThrow(/不能改变状态/);
    expect(() => defineMachine<S, E, F>({ ...base, rows: [{ from: "a", event: "GO", to: "b", kind: "allowed", covered_by: ["no-separator"] }] })).toThrow(/covered_by/);
    expect(() => defineMachine<S, E, F>({ ...base, rows: [], invariants: [{ id: "x", text: "t", priority: "P0", status: "enforced" }] })).toThrow(/evidence/);
  });

  it("enumerate 列出全表：状态 × 事件 每格一条，未列格 listed=false", () => {
    const cells = enumerate(sample());
    expect(cells.length).toBe(4 * 4);
    expect(cells.filter((c) => c.listed).length).toBe(5);
    expect(cells.find((c) => c.from === "a" && c.event === "GO")?.rows.length).toBe(2);
    expect(cells.find((c) => c.from === "b" && c.event === "GO")?.listed).toBe(false);
    // 终态一行没列，全部 unlisted
    expect(cells.filter((c) => c.from === "end").every((c) => !c.listed)).toBe(true);
  });

  it("reachable：沿 allowed 行 BFS；rejected/noop 行随其 from 可达而可达；不可达状态被点名", () => {
    const m = defineMachine<S, E, F>({
      feature: "r", anchor: "t", initial: "a", states: ["a", "b", "c", "end"], terminal: ["end"], events: ["GO", "STAY", "STOP", "NEVER"],
      rows: [
        { from: "a", event: "GO", to: "b", kind: "allowed" },
        { from: "b", event: "STOP", to: "end", kind: "allowed" },
        { from: "b", event: "STAY", to: "b", kind: "rejected" },
        { from: "c", event: "GO", to: "end", kind: "allowed" },
      ],
    });
    const r = reachable(m);
    expect(r.states).toEqual(["a", "b", "end"]);
    expect(r.unreachableStates).toEqual(["c"]);
    expect(r.rows.length).toBe(3);
    expect(r.unreachableRows.map((x) => x.from)).toEqual(["c"]);
    expect(reachable(sample()).unreachableStates).toEqual([]);
  });

  it("toContract 确定性：同表两次输出逐字相同，不含函数，守卫只留名字，未列格与声明的 unknown 分开可见", () => {
    const a = renderContract(sample());
    const b = renderContract(sample());
    expect(a).toBe(b);
    const c = toContract(sample());
    expect(c.guards).toEqual(["small", "big"]);
    expect(JSON.stringify(c)).not.toMatch(/=>|function/);
    expect(c.cells.total).toBe(16);
    expect(c.cells.listed).toBe(5);
    expect(c.cells.declared_unknown).toEqual(["c --NEVER--> c"]);
    expect(c.cells.unlisted).toContain("b + GO");
    expect(c.rows[0]).toMatchObject({ id: "a --GO[small]--> b", guard: "small", kind: "allowed", covered_by: [] });
  });
});
