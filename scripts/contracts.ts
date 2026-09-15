import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { renderContract, type Machine } from "../src/machine/interpreter.js";

// 用法：tsx scripts/contracts.ts write   → 由表重新生成 contracts/*.contract.json
//       tsx scripts/contracts.ts check   → 盘上 JSON 与表有漂移则退出码 1
// 表的清单不硬编码：收集 contracts/ 下全部 *.machine.ts，每个文件导出的那张表（feature 必须等于文件名）→ contracts/<name>.contract.json。

const isMachine = (x: unknown): x is Machine<string, string, unknown> =>
  !!x && typeof x === "object" && typeof (x as Machine<string, string, unknown>).feature === "string" && Array.isArray((x as Machine<string, string, unknown>).rows);

export async function collectContracts(dir = "contracts"): Promise<Array<{ machine: Machine<string, string, unknown>; path: string }>> {
  const out: Array<{ machine: Machine<string, string, unknown>; path: string }> = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".machine.ts")).sort()) {
    const name = f.replace(/\.machine\.ts$/, "");
    const mod = (await import(pathToFileURL(resolve(dir, f)).href)) as Record<string, unknown>;
    const machines = Object.values(mod).filter(isMachine);
    if (machines.length !== 1) throw new Error(`${dir}/${f} 应恰导出一张表，实际 ${machines.length} 张`);
    if (machines[0].feature !== name) throw new Error(`${dir}/${f} 的 feature "${machines[0].feature}" 与文件名 "${name}" 不一致`);
    out.push({ machine: machines[0], path: `${dir}/${name}.contract.json` });
  }
  return out;
}

const mode = process.argv[2];
if (mode !== "write" && mode !== "check") {
  console.error("用法：tsx scripts/contracts.ts <write|check>");
  process.exit(2);
}
const CONTRACTS = await collectContracts();
let drift = 0;
for (const { machine, path } of CONTRACTS) {
  const expected = renderContract(machine);
  if (mode === "write") {
    writeFileSync(path, expected);
    console.log(`写入 ${path}`);
    continue;
  }
  const actual = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (actual === expected) console.log(`✓ ${path} 无漂移`);
  else {
    drift++;
    console.error(`✗ ${path} 与表不一致（运行 npm run contracts:gen 重新生成）`);
  }
}
process.exit(drift ? 1 : 0);
