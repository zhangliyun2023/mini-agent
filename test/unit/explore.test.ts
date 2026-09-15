import { describe, it, expect } from "vitest";
import { ddmin, explore } from "../../src/machine/explore.js";
import { defineMachine } from "../../src/machine/interpreter.js";
import { turnMachine } from "../../contracts/turn.machine.js";
import { sessionMachine } from "../../contracts/session.machine.js";
import { sessionRuntimeMachine } from "../../contracts/session-runtime.machine.js";

// B2 / S3.5 模型层随机探索：只用表 + interpret，几秒。带种子随机游走，每步随机事件 + 随机 guard 取值；
// 通用不变量：已建模的格不得 unknown（guard 洞）、blocked/noop 停留、allowed 落在 modeled 状态、终态吸收；红了 ddmin 缩到最短复现。

type S = "a" | "b" | "end";
type E = "GO" | "STAY";

describe("随机探索器", () => {
  it("同一 seed 两次跑出逐字相同的结果（可复现）", () => {
    const a = explore(turnMachine, { seed: 7, walks: 50, maxSteps: 20 });
    const b = explore(turnMachine, { seed: 7, walks: 50, maxSteps: 20 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.stepsTaken).toBeGreaterThan(0);
  });

  it("红：只有守卫行、没有兜底的格是 guard 洞——探索点名，并 ddmin 缩到 1 步复现", () => {
    const holed = defineMachine<S, E, Record<string, boolean>>({
      feature: "holed", anchor: "t", initial: "a", states: ["a", "b", "end"], terminal: ["end"], events: ["GO", "STAY"],
      guards: { ok: (f) => f.ok },
      rows: [
        { id: "h-go", from: "a", event: "GO", to: "b", kind: "allowed", guard: "ok" },
        { id: "h-stay", from: "a", event: "STAY", to: "a", kind: "noop" },
        { id: "h-stop", from: "b", event: "GO", to: "end", kind: "allowed" },
      ],
    });
    const r = explore(holed, { seed: 1, walks: 30, maxSteps: 10 });
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations[0].invariant).toBe("modeled-cell-never-unknown");
    expect(r.violations[0].message).toMatch(/\(a, GO\)/);
    expect(r.minimal!.steps).toEqual([{ event: "GO", guards: { ok: false } }]);
  });

  it("ddmin：把满足谓词的序列缩到最小（同时含 3 与 7）", () => {
    const min = ddmin([1, 2, 3, 4, 5, 6, 7, 8], (xs) => xs.includes(3) && xs.includes(7));
    expect(min).toEqual([3, 7]);
  });

  it.each([
    ["turn", turnMachine],
    ["session", sessionMachine],
    ["session-runtime", sessionRuntimeMachine],
  ] as const)("三张表随机探索零违反：%s（guard 洞 / 停留 / 落点 / 终态吸收）", (_name, m) => {
    const r = explore(m as any, { seed: 20260914, walks: 300, maxSteps: 40 });
    expect(r.violations).toEqual([]);
    expect(r.minimal).toBeUndefined();
    // 每一行都被随机游走碰到过（探索覆盖，不是手写覆盖）
    expect(r.rowsNeverHit).toEqual([]);
  });
});
