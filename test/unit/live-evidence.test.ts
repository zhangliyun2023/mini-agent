import { describe, it, expect } from "vitest";
import { checkTraceFiles, listTraceFiles, readTraceFile, summarize } from "../../src/machine/evidence.js";
import { checkTraceOnlyInvariants } from "../../src/machine/invariants.js";

// 独立 oracle 触到真实模型证据：仓库里提交的 evals/live-trace/**/*.jsonl 是真实模型跑出来的转移记录，
// 这里离线逐轮过「只凭 trace 就能判」的不变量（① ② ③ ⑤ + unknown 点名）。
// ④ 需要 RunResult 与盘上会话历史，只凭 trace 判不了，不在离线检查内。
// 这不是「真实模型已验证」——只证明已提交的证据与表、与不变量一致；live 是否重跑见 docs/TEST_REPORT.md §3。
const files = listTraceFiles("evals/live-trace");

describe("已提交的真实模型 trace 过不变量", () => {
  it("仓库里至少有一批 live 证据，且每个文件都是合法 JSONL 转移记录（#6 之后的形状：带 feature 与 transition 行 id）", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const rows = readTraceFile(f);
      expect(rows.length, f).toBeGreaterThan(0);
      for (const r of rows) expect(r, `${f}: 缺 trace_id/feature/from/to/event/status/transition`).toMatchObject({ trace_id: expect.any(String), feature: "turn", from: expect.any(String), to: expect.any(String), event: expect.any(String), status: expect.any(String), transition: expect.any(String) });
    }
  });

  it("每一轮都过 ① ② ③ ⑤，没有 unknown 转移，每轮落终态", () => {
    const report = checkTraceFiles(files);
    expect(report.turns.length).toBeGreaterThan(0);
    expect(report.failed.map((t) => `${t.file} ${t.trace_id}`), summarize(report)).toEqual([]);
    expect(report.statuses.unknown ?? 0).toBe(0);
    // LLM_OK 是 noop 行：真实 trace 里必然有 noop 记录，「无 unknown」不是「全 allowed」
    expect(report.statuses.noop ?? 0).toBeGreaterThan(0);
    expect(report.turns.filter((t) => !["done", "max_steps", "error"].includes(t.terminal ?? ""))).toEqual([]);
  });

  it("离线检查真的会红：篡改一条记录（往轮首塞一条表未声明的 tool 副作用）→ 报告点名到文件、trace_id 与不变量 id", () => {
    const report = checkTraceFiles(files);
    const t = report.turns[0];
    const rows = readTraceFile(t.file).filter((r) => r.trace_id === t.trace_id);
    rows[0].effects.push({ kind: "tool", request_id: "r-tampered", step: 1, name: "x", args: {}, ok: true, durationMs: 0, resultPreview: "" });
    const v = checkTraceOnlyInvariants(rows).filter((x) => x.violations.length);
    expect(v.map((x) => x.id)).toContain("effects_declared");
    expect(v.map((x) => x.id)).toContain("no_tool_after_parse_error");
    // 同一篡改经 checkTraceFiles 的报告路径也点名（文件名 + trace_id 可读）
    const tampered = { ...report, turns: report.turns.map((x) => (x === t ? { ...x, violations: v } : x)) };
    tampered.failed = tampered.turns.filter((x) => x.violations.length);
    expect(summarize(tampered)).toMatch(new RegExp(`✗ ${t.file.replace(/[/.]/g, "\\$&")} ${t.trace_id.replace(/\//g, "\\/")} \\[effects_declared\\] #1 t-llm-ok 上出现了表未声明的副作用 "tool"`));
  });
});
