import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

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
    const onDisk = readdirSync("test/unit").filter((f) => f.endsWith(".test.ts"));
    expect(onDisk.length).toBeGreaterThan(10);
    for (const f of onDisk) expect(agents, `AGENTS.md 没列 test/unit/${f}`).toContain(`test/unit/${f}`);
    expect(agents).toContain("test/live/live.test.ts");
  });

  it("C1：AGENTS.md 是九个固定章节、按顺序（七章节 + Agent skills + 什么时候用哪个 skill）；铁律不超过十条", () => {
    const heads = [...agents.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
    expect(heads).toEqual(["产品是什么", "铁律", "门禁", "地图", "禁止事项", "提交纪律", "证据口径", "Agent skills / tracker / 标签", "什么时候用哪个 skill"]);
    expect(agents).toMatch(/ai-era-skills \d+\.\d+\.\d+/); // 技能族版本行写死
    const rules = agents.split("## 铁律")[1].split("## 门禁")[0].match(/^\d+\. /gm) ?? [];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.length).toBeLessThanOrEqual(10);
  });

  it("C1：docs/ARCHITECTURE.md 的机器清单 == contracts/*.machine.ts（表 · 接法 · 谁证明），且每张表的证明文件在盘上", () => {
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    const files = readdirSync("contracts").filter((f) => f.endsWith(".machine.ts")).map((f) => f.replace(".machine.ts", ""));
    expect(files.length).toBe(4);
    for (const f of files) expect(arch, `机器清单少了 ${f}`).toMatch(new RegExp(`\\| \`${f}\` \\| (闸|影子|旅程) \\|`));
    const listed = [...arch.matchAll(/^\| `([a-z-]+)` \| (闸|影子|旅程) \|([^\n]*)$/gm)];
    expect(listed.map((m) => m[1]).sort()).toEqual([...files].sort());
    for (const m of listed) {
      const proofs = [...m[3].matchAll(/`((?:test|src|scripts)\/[^`]+)`/g)].map((x) => x[1]);
      expect(proofs.length, `${m[1]} 没写谁证明`).toBeGreaterThan(0);
      for (const p of proofs) expect(existsSync(p), p).toBe(true);
    }
  });

  it("C1：scripts/gate.sh 存在，门禁四步按 typecheck → test → contracts:check → live 顺序，落 docs/evidence/<label>/，live 无 key 写 skipped", () => {
    expect(existsSync("scripts/gate.sh")).toBe(true);
    const gate = readFileSync("scripts/gate.sh", "utf8");
    const order = ["typecheck", "npm test", "contracts:check", "test:live"].map((k) => gate.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(gate).toMatch(/docs\/evidence\//);
    expect(gate).toMatch(/skipped ≠ 通过/);
    expect(agents).toContain("scripts/gate.sh");
  });
  it("条数单一事实源：TEST_REPORT §0 一张表逐文件条数 == 源码静态计数（it( 记 1，it.each 行按 `// ×N` 标记记 N），总数与文件数也对；AGENTS.md / README 不写总数", () => {
    // 源码侧：每个 it( 记 1；it.each( 行必须带 `// ×N` 展开标记，记 N
    const files = readdirSync("test/unit").filter((f) => f.endsWith(".test.ts")).sort();
    const fromSource: Record<string, number> = {};
    for (const f of files) {
      const src = readFileSync(`test/unit/${f}`, "utf8");
      let n = (src.match(/^\s*it\(/gm) ?? []).length;
      for (const line of src.split("\n").filter((l) => /^\s*it\.each\(/.test(l))) {
        const m = /\/\/ ×(\d+)\s*$/.exec(line);
        expect(m, `${f} 的 it.each 行缺 \`// ×N\` 展开标记：${line.trim()}`).not.toBeNull();
        n += Number(m![1]);
      }
      fromSource[f] = n;
    }
    // 报告侧：§0 那张表里 `test/unit/X.test.ts` 行的条数，每个文件只许出现一次（单一事实源）
    const report = readFileSync("docs/TEST_REPORT.md", "utf8");
    const fromReport: Record<string, number> = {};
    for (const m of report.matchAll(/^\| `test\/unit\/([\w-]+\.test\.ts)` \| [^|]* \| (\d+) \|/gm)) {
      expect(fromReport[m[1]], `${m[1]} 在 TEST_REPORT 里出现了两次条数`).toBeUndefined();
      fromReport[m[1]] = Number(m[2]);
    }
    expect(fromReport).toEqual(fromSource);
    const total = Object.values(fromSource).reduce((a, b) => a + b, 0);
    const head = /\| `npm test` \| \*\*(\d+) 文件 (\d+) 条全绿/.exec(report);
    expect(head, "TEST_REPORT §0 缺 `npm test` 行").not.toBeNull();
    expect([Number(head![1]), Number(head![2])]).toEqual([files.length, total]);
    const sum = /^\| 合计 \| (\d+) 文件 \| (\d+) \|/m.exec(report);
    expect(sum, "TEST_REPORT §0 条数表缺合计行").not.toBeNull();
    expect([Number(sum![1]), Number(sum![2])]).toEqual([files.length, total]);
    // 其他文档不再各写一个总数
    for (const f of ["AGENTS.md", "README.md"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/\d+ 条(单测|全绿)|\d+ 文件 \d+ 条/);
  });
});
