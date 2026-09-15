import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// S6：AGENTS.md 是唯一入口，它引用的文件与命令必须真的存在——文档漂了就红。
const agents = readFileSync("AGENTS.md", "utf8");
const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
const ticks = [...agents.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

describe("AGENTS.md 守文档", () => {
  it("反引号里像路径的东西都在盘上", () => {
    const paths = ticks.filter((t) => /^[\w./一-龥-]+\.(md|ts|json)$/.test(t) && !t.includes("*"));
    expect(paths.length).toBeGreaterThan(10);
    const missing = paths.filter((p) => !existsSync(p));
    expect(missing).toEqual([]);
  });

  it("反引号里的 npm 命令都在 package.json scripts 里", () => {
    const cmds = ticks.filter((t) => /^npm (run |test)/.test(t));
    expect(cmds.length).toBeGreaterThan(5);
    const missing = cmds.filter((c) => {
      const m = /^npm (?:run )?([\w:-]+)/.exec(c)!;
      return !(m[1] in scripts);
    });
    expect(missing).toEqual([]);
    // 审计点名的幽灵脚本不能回来
    expect(scripts.serve).toBeUndefined();
  });

  it("文档四件套 + README + AI-LOG 都在，TEST_REPORT 分清三层且逐条对标 §13 八条", () => {
    for (const f of ["AGENTS.md", "README.md", "AI-LOG.md", "docs/product/SPEC-state-machines.md", "docs/TEST_REPORT.md", "docs/NEXT_STEPS.md"]) expect(existsSync(f), f).toBe(true);
    const report = readFileSync("docs/TEST_REPORT.md", "utf8");
    expect(report).toMatch(/纯函数通过/);
    expect(report).toMatch(/假模型通过/);
    expect(report).toMatch(/少量 smoke/);
    expect(report).not.toMatch(/可靠率\s*[\d%]/);
    const rows13 = report.match(/^\| [1-8] \| /gm) ?? [];
    expect(rows13.length).toBe(8);
  });

  it("AGENTS.md 里写的单测总数与 vitest 实跑一致由 npm test 输出核对；这里只核对测试文件都被列出", () => {
    for (const f of ["machine", "contracts", "generator", "invariants", "agent-loop", "session-context", "parser", "tools"]) expect(agents).toContain(`test/unit/${f}.test.ts`);
    expect(agents).toContain("test/live/live.test.ts");
  });
});
