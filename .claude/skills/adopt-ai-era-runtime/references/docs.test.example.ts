// 守文档的测试（收窄版）：AGENTS.md 是唯一入口，它指向的东西必须真的存在。
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const agents = readFileSync("AGENTS.md", "utf8");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));

describe("AGENTS.md 与仓库拴在一起", () => {
  it("七个固定章节都在", () => {
    for (const h of ["产品是什么", "铁律", "门禁", "地图", "禁止事项", "提交纪律", "证据口径"]) expect(agents).toContain(h);
  });
  it("地图里指向的文件都存在", () => {
    for (const m of agents.matchAll(/`((?:docs|contracts|src|test|scripts)\/[^`]+)`/g)) expect(existsSync(m[1]), m[1]).toBe(true);
  });
  it("门禁里的每条 npm run 都是真实脚本", () => {
    for (const m of agents.matchAll(/npm run (?:-s )?([a-z:]+)/g)) expect(pkg.scripts[m[1]], m[1]).toBeDefined();
  });
  it("ARCHITECTURE.md 的机器清单 == contracts/*.machine.ts", () => {
    const arch = readFileSync("docs/ARCHITECTURE.md", "utf8");
    const files = readdirSync("contracts").filter((f) => f.endsWith(".machine.ts")).map((f) => f.replace(".machine.ts", ""));
    for (const f of files) expect(arch, `机器清单少了 ${f}`).toMatch(new RegExp(`\\b${f}\\b`));
    for (const m of arch.matchAll(/\| `?([a-z-]+)`? \| (闸|影子|旅程)/g)) expect(files, `机器清单多了 ${m[1]}`).toContain(m[1]);
  });
  it("README 指向 AGENTS.md", () => {
    expect(readFileSync("README.md", "utf8")).toContain("AGENTS.md");
  });
});
