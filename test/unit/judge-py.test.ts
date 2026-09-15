import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTraceFiles, listTraceFiles, readTraceFile } from "../../src/machine/evidence.js";
import { checkTraceOnlyInvariants } from "../../src/machine/invariants.js";
import type { TransitionRecord } from "../../src/runtime/trace.js";

// #13：evals/judge.py 是 TS 侧 evidence.ts + invariants.ts（① ② ③ ⑤ + unknown 点名）的 Python 独立实现，只用标准库。
// 用户可见契约 = 进程退出码 + stdout 文本；这里用 child_process 真跑 python3，不 import 任何 TS 判据来「代跑」。
// 与 TS 侧对账：对同一批 evals/live-trace/ 文件，轮数 / 转移数 / 违反数 / unknown 数必须与 checkTraceFiles 一致。
// 放在 test/judge/ 而不是 test/unit/：docs.test.ts 把 test/unit 的 it( 条数与 docs/TEST_REPORT.md §0 表对账，本票不改报告。
// 没有 python3 的机器上这组测试直接失败（不 skip）——判分器是门禁的一步，缺解释器就是缺门禁。

const ROOT = process.cwd(); // vitest 从仓库根跑，与 live-evidence.test.ts 同口径
const LIVE = "evals/live-trace";
const judge = (...args: string[]) => {
  const r = spawnSync("python3", ["evals/judge.py", ...args], { cwd: ROOT, encoding: "utf8" });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};
type JudgeJson = {
  files: number;
  turns: Array<{ file: string; trace_id: string; records: number; terminal: string | null; verdict: "passed" | "failed"; violations: Array<{ id: string; violations: string[] }> }>;
  summary: { files: number; turns: number; transitions: number; passed: number; failed: number; unknown: number };
  statuses: Record<string, number>;
  unknown: Array<{ file: string; trace_id: string; seq: number; from: string; event: string; reason: string }>;
};

describe("evals/judge.py：Python 判分器读 JSONL 跑 trace-only 不变量", () => {
  it("仓库里已提交的 evals/live-trace/ 全部通过：每轮一行 passed，退出码 0；轮数 / 转移数 / 违反数 / unknown 数与 TS 侧 checkTraceFiles 一致", () => {
    const ts = checkTraceFiles(listTraceFiles(LIVE));
    expect(ts.turns.length).toBeGreaterThan(0);

    const plain = judge(LIVE);
    expect(plain.code, plain.out + plain.err).toBe(0);
    const lines = plain.out.trim().split("\n");
    const turnLines = lines.filter((l) => /\t(passed|failed)\t/.test(l));
    expect(turnLines.length).toBe(ts.turns.length);
    expect(turnLines.filter((l) => !/\tpassed\t/.test(l))).toEqual([]);
    expect(lines[lines.length - 1]).toBe(`files=${ts.files} turns=${ts.turns.length} transitions=${ts.records} passed=${ts.turns.length} failed=0 unknown=${ts.statuses.unknown ?? 0}`);

    const j = judge(LIVE, "--json");
    expect(j.code, j.out + j.err).toBe(0);
    const report = JSON.parse(j.out) as JudgeJson;
    expect(report.summary).toEqual({ files: ts.files, turns: ts.turns.length, transitions: ts.records, passed: ts.turns.length, failed: 0, unknown: ts.statuses.unknown ?? 0 });
    expect(report.statuses).toEqual(ts.statuses);
    expect(report.unknown).toEqual([]);
    // 逐轮对齐：同一文件、同一 trace_id、同样的记录数与终态
    expect(report.turns.map((t) => [t.file, t.trace_id, t.records, t.terminal])).toEqual(ts.turns.map((t) => [t.file, t.trace_id, t.records, t.terminal ?? null]));
  });

  it("篡改一条记录（把 TOOLS_DONE 上的 tool 副作用挪到 PARSED_ERROR 转移上）→ 该轮 failed 且点名 trace_id / seq / 不变量 id，退出码 1；其余轮仍 passed；违反的不变量 id 与 TS 侧一致", () => {
    // 从已提交证据里挑一轮有工具执行的
    const src = listTraceFiles(LIVE).find((f) => readTraceFile(f).some((r) => r.event === "TOOLS_DONE" && r.effects.some((e) => e.kind === "tool")))!;
    expect(src).toBeDefined();
    const rows = readTraceFile(src);
    const i = rows.findIndex((r) => r.event === "TOOLS_DONE" && r.effects.some((e) => e.kind === "tool"));
    const toolsDone = rows[i];
    const prev = rows[i - 1]; // allowed 的 PARSED_TOOL_CALLS → executing_tools
    expect(prev.event).toBe("PARSED_TOOL_CALLS");
    const tools = toolsDone.effects.filter((e) => e.kind === "tool");
    // 篡改：前一条改成被拒的 PARSED_ERROR（t-parse-error，只声明 parse），把 tool 副作用挪上去
    const tampered: TransitionRecord = { ...prev, event: "PARSED_ERROR", to: "deciding", status: "blocked", transition: "t-parse-error", reject_code: "PARSE_ERROR", effects: [...prev.effects, ...tools] };
    const stripped: TransitionRecord = { ...toolsDone, effects: toolsDone.effects.filter((e) => e.kind !== "tool") };
    const mutated = rows.map((r, k) => (k === i - 1 ? tampered : k === i ? stripped : r));

    const dir = mkdtempSync(join(tmpdir(), "judge-tamper-"));
    writeFileSync(join(dir, "tampered.jsonl"), mutated.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const r = judge(dir);
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out).toContain(`${tampered.trace_id}\tfailed\t`);
    expect(r.out).toContain(`[no_tool_after_parse_error] #${tampered.seq} PARSED_ERROR 转移上挂了 ${tools.length} 个 tool 副作用`);
    expect(r.out).toContain(`[effects_declared] #${tampered.seq} t-parse-error 上出现了表未声明的副作用 "tool"`);
    const others = new Set(mutated.map((x) => x.trace_id));
    others.delete(tampered.trace_id);
    for (const id of others) expect(r.out).toContain(`${id}\tpassed\t`);
    expect(r.out.trim().split("\n").pop()).toMatch(new RegExp(`^files=1 turns=${others.size + 1} transitions=${mutated.length} passed=${others.size} failed=1 unknown=0$`));

    // 与 TS 侧同一份篡改数据对账：违反的不变量 id 集合相同
    const tsIds = checkTraceOnlyInvariants(mutated.filter((x) => x.trace_id === tampered.trace_id)).filter((x) => x.violations.length).map((x) => x.id).sort();
    const j = JSON.parse(judge(dir, "--json").out) as JudgeJson;
    const turn = j.turns.find((t) => t.trace_id === tampered.trace_id)!;
    expect(turn.verdict).toBe("failed");
    expect(turn.violations.map((v) => v.id).sort()).toEqual(tsIds);
    expect(tsIds).toEqual(["effects_declared", "no_tool_after_parse_error"]);
  });

  it("目录里没有任何 .jsonl → 输出 not_observed，退出码 2（不是 0：没观察到 ≠ 通过）", () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-empty-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "notes.txt"), "nothing here\n");
    const r = judge(dir);
    expect(r.code, r.out + r.err).toBe(2);
    expect(r.out.trim()).toBe("not_observed");
  });

  it("契约文件是判据来源：用一份把 t-tools-done 的 effects 声明删掉的契约跑同一批证据 → 每个带 tool 副作用的轮都在 ⑤ 上 failed（反向红：表说了算，不是脚本写死）", () => {
    const contract = JSON.parse(readFileSync(join(ROOT, "contracts/turn.contract.json"), "utf8")) as { rows: Array<{ id: string; effects: string[] }> };
    for (const row of contract.rows) if (row.id === "t-tools-done") row.effects = [];
    const dir = mkdtempSync(join(tmpdir(), "judge-contract-"));
    const cpath = join(dir, "turn.contract.json");
    writeFileSync(cpath, JSON.stringify(contract));
    const r = judge(LIVE, "--contract", cpath, "--json");
    expect(r.code, r.out + r.err).toBe(1);
    const j = JSON.parse(r.out) as JudgeJson;
    const ts = checkTraceFiles(listTraceFiles(LIVE));
    const withTools = ts.turns.filter((t) => readTraceFile(t.file).some((x) => x.trace_id === t.trace_id && x.transition === "t-tools-done" && x.effects.some((e) => e.kind === "tool"))).length;
    expect(withTools).toBeGreaterThan(0);
    expect(j.summary.failed).toBe(withTools);
    for (const t of j.turns.filter((t) => t.verdict === "failed")) expect(t.violations.map((v) => v.id)).toEqual(["effects_declared"]);
  });
});
