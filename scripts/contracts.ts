import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { renderContract } from "../src/machine/interpreter.js";
import { turnMachine } from "../contracts/turn.machine.js";
import { sessionMachine } from "../contracts/session.machine.js";
import { sessionRuntimeMachine } from "../contracts/session-runtime.machine.js";

// 用法：tsx scripts/contracts.ts write   → 由表重新生成 contracts/*.contract.json
//       tsx scripts/contracts.ts check   → 盘上 JSON 与表有漂移则退出码 1
export const CONTRACTS = [
  { machine: turnMachine, path: "contracts/turn.contract.json" },
  { machine: sessionMachine, path: "contracts/session.contract.json" },
  { machine: sessionRuntimeMachine, path: "contracts/session-runtime.contract.json" },
];

const mode = process.argv[2];
if (mode !== "write" && mode !== "check") {
  console.error("用法：tsx scripts/contracts.ts <write|check>");
  process.exit(2);
}
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
