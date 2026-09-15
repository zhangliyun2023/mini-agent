# t19-r7 —— #19 R7 复盘状态表（闸）+ 四条 P0 不变量 + 会话表 busy 两格建模

分支 `t19-r7-machine`，基于 `352018f`（R6 之后的 main）。本片不需要真实模型。

## 做了什么

| 文件 | 内容 |
|---|---|
| `contracts/review.machine.ts` | 第四张表 `feature: "review"`：`scheduled → collecting → consolidating → presenting → delivered \| skipped_no_chat \| failed_partial`（终态无出边）。事件按 run.ts 步骤命名：`START` / `REPLAYED` / `COLLECTED` / `CONSOLIDATED` / `PRESENTED`（noop）/ `DELIVERED`。12 行全 P0、显式 id（`rv-*`）、`effects` 声明、`covered_by` 指向 `review-run.test.ts` 的既有测试名或本票新测试。守卫 `replayOk` / `replayNoChat` / `coverageNone` / `nothingReadable` / `coveragePartial`，**每个带守卫的格最后一行无守卫兜底**（否则 explore 会报 guard 洞）；「full」与「partial_read 重跑」是兜底行（reason 写明「其余即 …」）。`TERMINAL_STATUS` 把终态与 journal.status 一一对应。不变量 6 条 enforced（四条 P0 + `unknown_never_silent` + `terminal_matches_journal_status`）、1 条 planned（⑪ 接收人，带 note）。 |
| `contracts/review.contract.json` | `npm run contracts:gen` 生成，未手改。 |
| `contracts/session-runtime.machine.ts`（Q4 / ⑦） | `busy + ASYNC_DONE → queued`、`idle + ASYNC_DONE → executing`、`queued + TURN_DONE → executing` 三格 allowed，加状态 `queued` / `executing` 与事件 `REVIEW_DONE`（`executing + REVIEW_DONE → idle`，否则 executing 是死胡同）；`queued + ASYNC_DONE` noop（合并）；`queued/executing + INPUT`、`executing + ASYNC_DONE` 诚实标 unknown。三行的 `reason` 与不变量 `no_concurrent_turns_per_session` 的 `note` 都写明「单进程 CLI 不可达，表已建模、运行时不接」（`Row` 没有 `note` 字段，没为此改解释器与三份契约的形状）。`busy + INPUT` 仍 declared_unknown。 |
| `scripts/contracts.ts` | 不再硬编码三张表：收集 `contracts/*.machine.ts`，每个文件恰导出一张表且 `feature == 文件名`，写 / 查 `contracts/<name>.contract.json`。 |
| `src/runtime/trace.ts` | 抽出 `BaseTransitionRecord`（turn 的 `TransitionRecord` 收窄它）；`FileTraceSink` 加第三个参数 `stem(record)` 决定文件名（默认 sessionId，行为不变）；echo 的 `describeEffect` 对表外 kind 退回 kind 名。 |
| `src/review/trace.ts` | `ReviewEffect`（collect / consolidate / memory / present / deliver / journal，只有计数与会话 id，**不写记忆值、亮点原文、brief 全文**）、`ReviewTransitionRecord`（多 `userId` / `date` / `attempt`）、`reviewTraceSink(dir = "trace/reviews")` → `<user>-<date>.jsonl`。 |
| `src/review/run.ts` | 接表（闸）：`while (!terminal)` 按状态做该步的事，事件报告结果，`transition()` 先 `interpret`，落终态时按 `TERMINAL_STATUS` 收尾 journal，一次 interpret 一行 trace（`trace_id = review/<user>/<date>`）。**unknown → 不执行后续副作用、记 `status: "unknown"`、`failed_partial` 收尾**（journal `partial_read` 且 `warnings` 写明「未建模的状态转移：<state> + <event>」；同键已有 journal 时保留原 journal 只追加 warning）。deps 新增可选 `trace` / `machine` / `unknownTransition: "fail" \| "throw"`。三态、幂等、⑪ 逻辑与 R6 一致，既有 10 条断言一字未改。 |
| `src/review/invariants.ts` | 四条 P0 oracle：`idempotent`、`noOverwriteOnConflict`、`everyHighlightHasSource`、`briefNotVerbatim` + `checkReviewInvariants`。只吃盘上证据（journal 列表、记忆条目前后、转写行、brief）。 |
| `test/unit/contracts.test.ts` | CONTRACTS 加 review（`// ×4`）；新增 `review 表` 2 条（可达 / 18 格终态 unlisted / 带守卫格有兜底；全 P0 且 covered_by、evidence 在盘上）；**改了 issue 明说的那一条**：busy 两格 declared_unknown → 解释器级断三格 allowed、`busy + INPUT` 仍 unknown、reason 含「单进程 CLI 不可达」。 |
| `test/unit/explore.test.ts` | `it.each` 加 review（`// ×4`），种子 20260914、300 走、40 步。 |
| `test/unit/review-run.test.ts` | 只加一条：`trace 序列 == 答案卷`（ok 交付 / no_chat / partial_read / 只有坏转写 四种昨天，各跑两次；行 id 序列与内联答案卷逐字相等；每条记录 trace_id / feature / seq / ts；effects ⊆ 行声明、journal 只在终态；终态 ↔ journal.status；trace 文件不含记忆值 / 亮点原文 / brief）。 |
| `test/unit/review-machine.test.ts`（新） | 闸 2 条：抠掉 `COLLECTED` → trace `["rv-start", "collecting --COLLECTED--> failed_partial [unknown]"]`、整合器没被调、记忆 / 会话文件不存在、journal partial_read + warning、`throw` 模式抛；抠掉 `DELIVERED` → 前面四行 allowed 照跑、终态被拦、deliver 副作用挂在 unknown 那条上诚实可见。 |
| `test/unit/review-invariants.test.ts`（新） | 四条各一红一绿（8 条）。绿 = 真实 `runReview` 真落盘的证据过 oracle；红 = 篡改证据（多一份 journal / attempts 不递增 / 条目多一条；旧值消失或新值 active；source 指向不存在的轮 / 会话 / 缺 source；亮点整行或 ≥ 20 字子串复述，19 字不算）。 |
| `test/unit/docs.test.ts` | **改了一处既有断言**：`contracts/*.machine.ts` 文件数 `toBe(3)` → `toBe(4)`。第四张表存在这条必红，没有别的办法；派工说「只允许改 busy 那一条」，这里显式声明。 |
| `docs/ARCHITECTURE.md` | 机器清单加 `review`（闸）行、session-runtime 行的「谁证明」改为三格 allowed；「三张表」→「四张表」；目录加 `src/review/`。 |
| `AGENTS.md` | 地图：contracts 加 `review.machine.ts`、session-runtime 行注明 ⑦；`src/review/` 加 R7 一行；测试表加 `review-machine.test.ts` / `review-invariants.test.ts`，contracts / explore 两行改「四份 / 四张」。 |
| `docs/TEST_REPORT.md` §0 | `npm test` 26 文件 239 条；contracts 12、explore 7、review-run 11、新增 review-machine 2、review-invariants 8；合计 26 / 239；contracts:check 4 份。正文未动（§1 里「盘上 3 份 JSON」「三张表」两处已过时，按派工不改，留给 R9）。 |

## 先红后绿（红都真红过；输出摘自当时的 vitest）

| 测试 | 红时的失败输出 | 让它绿的改动 |
|---|---|---|
| `contracts.test` 盘上 `contracts/review.contract.json` == toContract() | `expected false to be true // Object.is equality`（文件不存在） | `scripts/contracts.ts` 收集全部表 + `npm run contracts:gen` |
| `contracts.test` session-runtime（#19 ⑦ Q4）三格 allowed | `expected { status: 'unknown', …(6) } to match object { status: 'allowed', …(2) }` | 会话表加 queued / executing 与三行 |
| `contracts.test` review 表 covered_by / evidence 在盘上 | `expected [ …(2) ] to deeply equal []`（指向的新测试文件 / oracle 符号还不存在） | 本票新测试与 `src/review/invariants.ts`、`run.ts::unknownTransition` |
| `docs.test` 机器清单 == contracts/*.machine.ts | `机器清单少了 review: expected '# ARCHITECTURE …' to match /\| \`review\` \| (闸\|影子\|旅程) \|/` | ARCHITECTURE 加行 |
| `review-machine.test` 闸（两条） | `ENOENT: no such file or directory, open '…/trace/reviews/A-2026-09-15.jsonl'`（先建了 trace 模块、未接表时：没有 trace、没有闸） | `run.ts` 接表 |
| `review-run.test` trace 序列 == 答案卷 | 同上（未接表时 trace 文件不存在） | `run.ts` 接表 |
| `review-invariants.test` ① 红 | 桩 oracle（恒返回 `[]`）下：`expected '' to match /journal 应恰 1 份，实际 2 份/` | 实现 `idempotent` |
| `review-invariants.test` ② 红 | `expected 0 to be greater than 0` | 实现 `noOverwriteOnConflict` |
| `review-invariants.test` ③ 红 | `expected '' to match /s1 第 99 轮.*不存在/` | 实现 `everyHighlightHasSource` |
| `review-invariants.test` ④ 红 | `expected '' to match /与昨天 s1 第 2 轮 user 的原话逐字重合/` | 实现 `briefNotVerbatim` |

四条不变量的红是用**桩 oracle** 先跑出来的（先写测试 → 桩返回空 → 4 条红例红、4 条绿例绿 → 实现 → 8 条绿），所以红是「篡改证据没被点名」，不是「模块不存在」。实现后 ② 的红例把 regex 从「不再 active」放宽为「(不见了|不再 active)」——oracle 对「旧值整条消失」与「旧值状态被改」分开报，比测试初稿更准。

最承重的一条（闸 `unknown_never_silent`）的变异就是 `review-machine.test` 本身：残缺表 = 对表的变异，两处（COLLECTED / DELIVERED）都被拦下并记 trace。没有再做逐条变异。

## 随机探索（`6-explore-review.txt`）

`explore(reviewMachine, { seed: 20260914, walks: 300, maxSteps: 40 })`：2491 步，**0 违反、12 行全被碰到、rowsNeverHit = []**。没有红出洞——因为表写的时候就按「带守卫的格最后一行无守卫兜底」来写；contracts.test 里另有一条静态检查守着这个规则。

## 门禁

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | 0 错 | `2-typecheck.txt` |
| `npm run contracts:check` | 4 份契约 0 漂移（turn / session / session-runtime / review） | `3-contracts.txt` |
| `npm test` | 26 文件 239 条全绿（既有 224 条：只改了 issue 明说的 busy 那一条 + docs.test 的 3→4；新增 15） | `4-unit.txt` |
| `python3 evals/judge.py evals/live-trace` | files=42 turns=54 transitions=243 passed=54 failed=0 unknown=0 | `5-judge.txt` |
| `npm run test:live` | not_run（本片不需要模型） | — |

基线对照：开工前在本 worktree 自己跑过（2026-09-15）：typecheck 0、`npm test` 24 文件 224 条全绿、contracts:check 3 份 0 漂移、judge 54 passed。

Q5 确认：`REVIEW_TRACE_DIR = "trace/reviews"`，在 `.gitignore` 的 `trace/` 下；`evals/judge.py` 只递归它的入参目录（门禁传的是 `evals/live-trace`），`src/machine/evidence.ts` / `live-evidence.test.ts` 同样只看 `evals/live-trace/`。复盘 trace 不会混进 turn 的判分。NEXT_STEPS 没改。

## 没做 / 不确定

- **unknown 收尾写 journal**：与 turn 的 unknown（照样写一条 error 答案进历史）同法，journal 记 `partial_read` + warning。代价是同键此后按幂等只递增 attempts、不自动重跑；如果想「闸拦下的可以重试」，要么不写 journal（但 `ReviewResult.journal` 非空的既有类型就得改），要么给 journal 加 `status: "failed"`（改共享类型）。留给拍板。
- **review 答案卷内联在测试里**，没进 `contracts/journeys.json`：`journeys.test.ts` 的 `machines` 映射只有三张表，加 review 旅程就得改那条既有测试；本票不动它。R9 若要统一，把映射改成从 `scripts/contracts.ts::collectContracts` 取即可。
- 派工写的守卫名是 `coverageNone / coverageFull / coveragePartial`；实际是 `coverageNone / nothingReadable / coveragePartial` + 无守卫兜底「其余即 full」。原因：三个互斥守卫没有兜底会被 explore 报 guard 洞；而「partial 但一个可读会话都没有」（R6 已有的落盘状态）需要 `nothingReadable` 单独一行。
- `Row` 没加 `note` 字段（会改 `toContract` 形状、动三份既有契约）；⑦ 的 note 写在三行 `reason` 与不变量 `note` 里。
- `docs/TEST_REPORT.md` §1 两处「3 份 JSON」「三张表」过时，按派工不动正文。
- 交付（deliver）是 presenting 那一步的副作用，发生在 `DELIVERED` 被解释之前（与 turn 里工具在 `TOOLS_DONE` 之前执行同法）；所以抠掉 `DELIVERED` 时交付已发生、终态被拦——`review-machine.test` 第二条按这个事实断言，没有假装它没发生。
