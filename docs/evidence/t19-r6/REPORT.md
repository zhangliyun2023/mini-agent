# t19-r6 —— #19 R6 复盘编排 `src/review/run.ts` + 复盘日志 `src/review/journal.ts`

分支 `t19-r6-run`，基于 origin/main `1e061e9`（R1 / R2 / R3 / R5 已合入）。本片不需要真实模型；R4 的 `consolidate` 另一分支实现，这里通过依赖注入拿函数、测试用夹具。

## 做了什么

| 文件 | 内容 |
|---|---|
| `src/review/journal.ts` | `ReviewJournalStore { get(userId, date); save(j) }`。内存版 + 文件版（`<root>/<user>/<date>.json`，即 `data/reviews/<user>/<date>.json`）。一键一文件，save 整条覆盖。 |
| `src/review/run.ts` | `runReview(deps, opts) → { journal, replayed }`。`deps = { transcripts, memory, sessions, journal, consolidate, now? }`，`opts = { userId, date, tz, deliverTo? }`。流程：③ 幂等（同键已有 → `attempts + 1` 存回，不重跑整合、不重写记忆、不重发，返回原 journal 标 `replayed: true`）→ `yesterdayWindow` → `collectYesterday`（R1 `FileTranscriptStore` 经 `transcriptReader` 适配：抛错 → null）→ ⑥ none → `no_chat`（不调整合器、不写记忆、不交付）/ partial → `partial_read` 并写明 `unreadable` / full → `ok` → `consolidate` → 每条 `memory.upsert`（同 key 异值走 conflict，不覆盖）→ `present` → brief → ⑩ `deliverTo` 给了且 brief 非空才往目标会话追加 `{ role: "assistant", content, kind: "review_brief" }` → journal 落盘。⑪ 接收人只由 `opts.deliverTo` 决定。 |
| `src/review/types.ts` | `ReviewJournal` **只增**两个可选字段：`unreadable?: string[]`（⑥ 覆盖范围）、`warnings?: string[]`（整合 + 呈现门槛警告）。其余既有定义一字不动。 |
| `src/llm/types.ts` | `ChatMessage` 加可选 `kind?: "review_brief"`。发厂商时 `toWireMessages` 只取 role / content，不上线。 |
| `src/machine/invariants.ts` | Q8：`TurnEvidence` 加可选 `history?: ChatMessage[]`；新增 `lastTurnMessage(history)`（从后往前跳过 `kind: "review_brief"`）；`answerAligned` 给了 `history` 就取「最近一轮的末条」，否则仍用 `lastHistoryMessage`（既有 ④ 测试不改）。`evidence.ts` 不读会话历史，不用改。 |
| `test/unit/review-run.test.ts` | 10 条，真落盘（tmpdir 下 FileTranscriptStore / FileUserMemoryStore / FileSessionStore / FileReviewJournalStore），断言只打 journal 文件、记忆文件、会话文件、返回值。 |
| `docs/TEST_REPORT.md` §0 | `npm test` 行 23 文件 215 条；条数表新增 `review-run.test.ts | 10`；合计 23 / 215。顺手修了 main 上的两处合并残留：第 1 行标题被一条 `npm test` 行吞掉、三条重复的 `npm test` 行并成一条。 |
| `AGENTS.md` 地图 | 代码树加 `src/review/` R6 一行；测试表加 `review-run.test.ts` 一行；删掉第 1 行（H1 之前一条游离的 memory-entries 表行，合并残留）。 |

不做：trace（R7 接表后再落 `trace/reviews/`）、CLI（R8）、`consolidate` 实现（R4）。

## 先红后绿

红 1（模块不存在）：`0-red-missing-module.txt`

```
FAIL  test/unit/review-run.test.ts
Error: Cannot find module '../../src/review/journal.js'
Test Files  1 failed (1)   Tests  no tests
```

红 2（`journal.ts` 真实现 + `run.ts` 桩：不落盘、返回 no_chat、适配器直接透传抛错；让断言真的打在契约上）：`1-red-stub.txt`，10/10 红：

```
× full → ok …                 Error: ENOENT … reviews/A/2026-09-15.json
× 同 key 不同值 → conflict …   AssertionError: expected [ [ 'deadline', '9 月 18 日交报告', …(2) ] ] to deeply equal [ [ 'deadline', …(3) ], …(2) ]
× ③ 同 date 跑两次 …           AssertionError: expected false to be true
× no_chat …                    Error: ENOENT … reviews/A/2026-09-15.json
× partial_read 一好一坏 …       Error: ENOENT … reviews/A/2026-09-15.json
× 只有坏转写 适配成 null …       SyntaxError: Unexpected token 'o', "not json at all" is not valid JSON
× 只有坏转写跑复盘 …            Error: ENOENT … reviews/A/2026-09-15.json
× ⑪ 注入 …                      AssertionError: expected undefined to be '昨天没收尾：把总结发给 B'
× 不给 deliverTo …             Error: ENOENT … reviews/A/2026-09-15.json
× Q8 ④ deliver 后 …            AssertionError: expected { role: 'assistant', …(1) } to deeply equal { role: 'assistant', …(2) }
Tests  10 failed (10)
```

绿：最小实现后 `10 passed (10)`（`1-green-r6.txt`）。

## 变异（最承重的不变量：③ 幂等）

把 `run.ts` 里 `if (existing)` 改成 `if (existing && false)`（关掉幂等短路）→ `5-mutation-idempotence-off.txt`：`③ 同 date 跑两次` 红（`expected false to be true`，第二次没标 replayed），`1 failed | 9 passed`。还原后 10/10 绿，`grep 'existing && false'` 为 0。

## 门禁

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | 0 错 | `2-typecheck.txt` |
| `npm run contracts:check` | 3 份契约 0 漂移 | `3-contracts.txt` |
| `npm test` | 23 文件 215 条全绿（既有 205 条一条不改，新增 10） | `4-unit.txt` |
| `python3 evals/judge.py evals/live-trace` | files=42 turns=54 transitions=243 passed=54 failed=0 unknown=0 | `5-judge.txt` |
| `npm run test:live` | not_run（本片不需要模型） | — |

基线对照：开工前在本 worktree 自己跑过 `npm test` = 22 文件 205 条全绿（2026-09-15）。

## 没做 / 不确定

- `ConsolidateInput` 的形状（`{ userId, date, sessions: Array<{ sessionId, lines }> }`）按派工里给的签名定在 `run.ts`；R4 若把入参定义在别处，合并时把这里改成 re-export 即可，测试不受影响。
- `entries_written` 按「交给 `upsert` 的条数」计（refreshed / conflict / appended 都算写过）；要按「新增条数」计的话改一行。
- ④ 的 `history` 与 `lastHistoryMessage` 并存：给了 `history` 就用它。R8 CLI 与 live 收尾若要跳过 review_brief，须传 `history`（全量）。
- 幂等把任何已存在的 journal（含 `no_chat` / `partial_read`）都当「已定」；issue ③ 的字面口径是「同一键重跑 journal 只有一条（attempts 递增）」，如需「partial 可补跑」要另加状态。
