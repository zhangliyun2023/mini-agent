# #11 模型调用重试按错误类型分类；unknownTransition 默认值去 VITEST

分支 `t11-retry`，基于 `a531d0e`。不需要真实模型；本票不改表（LLM_FAILED 仍是同一事件，重试发生在事件之前），`contracts:check` 0 漂移。

## 证据分层

| 层 | 结果 | 证据 |
|---|---|---|
| 已验证（进程内） | `npm test` **15 文件 156 条全绿**（基线 12 文件 128 条一字未改 + 本票 28 条） | `2-unit.txt` |
| typecheck | 0 错 | `1-typecheck.txt` |
| contracts:check | 0 漂移 | `3-contracts.txt` |
| 真实模型 | **not_run**（`GATE_LIVE=0`，本票不需要；skipped ≠ 通过） | `4-live.txt` |

## 验收标准逐条

| 标准 | 状态 | 测试 |
|---|---|---|
| 401 只调一次即 error 终态，答案含状态码 | 已验证 | `test/t11/llm-retry.test.ts` 「401 只调一次即 error 终态，答案含状态码，不等待」：`llm.calls === 1`、`waits === []`、答案匹配 `/401/`、`tries === [{n:1, errorClass:"auth", waitMs:0}]` |
| 429 三次后仍失败才 error，trace 上能看到三次尝试与各自等待 | 已验证 | 同文件「429 三次后仍失败才 error」：`llm.calls === 3`、`waits === [300, 600]`、`tries === [{1,rate_limited,300},{2,rate_limited,600},{3,rate_limited,0}]`、序列 `["t-llm-failed"]` |
| 超时 / 网络错归入可重试类（假客户端抛 `code: 'ETIMEDOUT'`） | 已验证 | 同文件 it.each ×3：ETIMEDOUT → timeout、ECONNRESET → network、503 → server，失败两次第三次成功 → `stoppedBy: "final"` |
| 全仓 grep 不到 `VITEST`；既有两条 unknown 测试显式传 `throw` 仍绿 | 已验证 | `grep -rn VITEST src test` 无匹配；`test/unit/agent-loop.test.ts` 两条 unknown 测试本就显式传 `"error"` / `"throw"`，未改；新增 `test/t11/unknown-transition-default.test.ts` 断默认值 |
| TEST_REPORT 本票小节写红过什么 | **改写到本文件**（派工要求不碰 `docs/TEST_REPORT.md`） | 见下节 |

## 红过什么（先写测试，红必须真红过；输出原文在同目录 `red-*.txt`）

1. `red-1-classify.txt`：`test/t11/llm-errors.test.ts` 首跑 `Cannot find module '../../src/llm/errors.js'`（17 条全红）。补 `src/llm/errors.ts` 后绿。
2. `red-1b-sdk-shapes.txt`：加真实 openai SDK 形状后 `Error: Connection error. → network` 红：`expected 'unknown' to be 'network'`——SDK 不设 `name`，`APIConnectionError` 只有 message。加 message 兜底后绿。
3. `red-2-retry.txt`（基线 `callLLM` + 分类函数，6 条全红）：
   - 401：`expected 'final' to be 'error'`——**基线把 401 也重试到了脚本里的下一条 `<final>`**，这是本票要修的行为本身。
   - 429：`expected '模型调用失败：Rate limit reached' to match /429/`——基线答案不含状态码。
   - ETIMEDOUT / ECONNRESET / 503：`expected [] to deeply equal [ 300, 600 ]`——基线没有可注入的 sleep，真等了 900ms。
   - 成功一次：effect 上没有 `tries`。
4. `red-3-unknown-default.txt`：`Error: 未建模的状态转移：deciding + PARSED_FINAL（(deciding, PARSED_FINAL) 未在表里列出）`——基线在 vitest 进程里默认 throw。改成固定默认 `"error"` 后绿。

## 实现

- `src/llm/errors.ts`（新）：`classifyLlmError(e)` 纯函数，看 `status` → `code`（含 `cause.code`）→ `name` → `message`，输出 `auth | bad_request | not_found | rate_limited | server | timeout | network | unknown`；`isRetryable`（auth / bad_request / not_found 不重试）；`describeLlmError` 给用户一行 `类别 状态码/错误码: message`。
- `src/runtime/agent.ts`：`callLLM` 按分类决定重不重试，退避 `300ms × 2^n` 走新选项 `sleep?: (ms) => Promise<void>`（默认 setTimeout，测试注入记录用假函数）；失败抛内部 `LlmCallFailed { tries }`；`unknownTransition` 默认 `"error"`，删掉对测试环境变量的引用。
- `src/runtime/trace.ts`：llm effect **保留原有 `attempts: number`**（`describeEffect` 与已入库 live trace 形状不变），**新增 `tries: LlmTry[]`**，每项 `{ n, errorClass, waitMs }`；成功一次为 `[]`。
- `src/llm/openai-compatible.ts` 未改：SDK 抛出的 `APIError` 自带 `status` / `code`，分类函数直接吃。

## 与派工要求的偏差 / 没做 / 不确定

- **新测试放在 `test/t11/` 而不是 `test/unit/`**：`test/unit/docs.test.ts` 用 `test/unit/*.test.ts` 的 `it(` 静态计数与 `docs/TEST_REPORT.md` §0 表逐文件对账，而本票被要求不碰 `TEST_REPORT.md`；放进 `test/unit/` 会让 docs.test 红。vitest include 是 `test/**/*.test.ts`，所以 `npm test` 照样跑到。后续把这 28 条并入 `test/unit/` 时需同步改 §0 表与 AGENTS.md 的文件清单。
- 验收第 4 条「TEST_REPORT 本票小节」按派工改写到本文件。
- `describeEffect` 的 CLI 回显没有展开 `tries`（只显示 `attempts` 次数）；文件 trace 里有完整明细。
- 没做变异（本票新增行为都由先红后绿覆盖；最承重的「401 不重试」红输出即证据）。
- 真实模型层 not_run。
