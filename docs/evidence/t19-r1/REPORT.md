# t19-r1 —— #19 R1：轮末写不压缩的逐轮转写（Raw 层）

评价对象：commit `f53cfa1`（origin/main）+ 本票改动；证据文件由 `GATE_LIVE=0 bash scripts/gate.sh t19-r1` 落在本目录，2026-09-15 UTC 10:25。

依据：issue #19 正文 ⑧（不改 turn 主循环；复盘独立模块 `src/review/`）+ 第一条评论 Q2（昨天的材料来自不压缩的逐轮转写：轮末把本轮消息追加到 `data/transcripts/<user>/<session>.jsonl`，每行 `{ts, userId, sessionId, turn, traceId, role, content, name?}`，user 的 ts = 轮开始，其余 = 轮结束）。

## 做了什么

| 文件 | 内容 |
|---|---|
| `src/review/types.ts` | 新增。评论里的共享类型原样 `export`（Source / MemoryEntry / Highlight / Brief / Consolidation / Coverage / ReviewJournal），R2–R8 按这份并行开工 |
| `src/review/transcript.ts` | 新增。`TranscriptLine`、`TranscriptStore { append / read / list }`；`MemoryTranscriptStore`（测试与单进程用）；`FileTranscriptStore`（`<root>/<user>/<session>.jsonl`，append-only，复用 `appendJsonl`；`read` 按文件行序回放，`list` 只扫本用户目录） |
| `src/runtime/agent.ts` | `AgentOptions.transcripts?: TranscriptStore`（默认内存版）；`createAgent` 返回值多一个 `transcripts`；`transition()` 终态收尾处：`stripThink(working)` 的结果先进 `session.history` + `sessions.save`，**同一批**再 `transcripts.append`——user 行 ts = 轮开始（`startedAt`），其余行 ts = 轮结束；assistant 内容保留 `<final>` 标签，与 history 一致。**不改** turn 表、不改 trace 形状、不加副作用种类 |
| `src/cli.ts` | 传 `new FileTranscriptStore("data/transcripts")`（`data/` 已在 .gitignore） |
| `test/unit/transcript.test.ts` | 4 条，见下 |
| `docs/TEST_REPORT.md` §0 | 只改数字：`npm test` 行 17 文件 171 条 → 18 文件 175 条；条数表新增 `transcript.test.ts | 4`，合计 18 文件 175 |
| `AGENTS.md` 地图 | 代码地图加 `src/review/` 一行；测试表加 `test/unit/transcript.test.ts` 一行（守文档测试要求所有 `test/unit/*.test.ts` 都列出） |

## 先红后绿（红真红过）

测试先写完，实现前跑 `npx vitest run test/unit/transcript.test.ts`：

红 1（模块不存在）：

```
FAIL  test/unit/transcript.test.ts
Error: Cannot find module '../../src/review/transcript.js' imported from '.../test/unit/transcript.test.ts'
Test Files  1 failed (1)   Tests  no tests
```

红 2（`src/review/transcript.ts` 写好、runtime 还没接）——4 条全红，失败信息各自落在承重面：

```
× Given 文件转写存储，When 跑两轮（第二轮带工具），Then 盘上 JSONL 每行有 ISO ts 且单调不减、role/content 逐条等于历史、turn/traceId 对上、user 的 ts 不晚于同轮其余行
  AssertionError: .../transcripts/A/w1.jsonl: expected false to be true          ← 文件不在盘上
× Given 盘上已有两轮转写，When 用新实例 read，Then 顺序与文件逐行一致；list 只见本用户的会话
  Error: ENOENT: no such file or directory, open '.../transcripts/A/w1.jsonl'
× Given 不传 transcripts（默认内存实现），When 跑一轮，Then agent.transcripts 读回的 role/content 与历史一致；MemoryTranscriptStore.list 只见本用户
  TypeError: Cannot read properties of undefined (reading 'read')                 ← createAgent 还没返回 transcripts
× Given 模型输出带 <think>，When 落转写，Then 转写里的 assistant 内容已剥 think（与历史同一批）
  TypeError: Cannot read properties of undefined (reading 'read')
Tests  4 failed (4)
```

绿：接上 runtime 后同一条命令 `4 passed (4)`。

## 断言落在哪（用户可见契约，不断类名 / 中间函数）

| 条 | Given / When / Then | 断什么 |
|---|---|---|
| 1 | 文件存储，跑两轮（第二轮 calculator 工具） | `readFileSync` 读盘上 JSONL：6 行；`ts` 是 ISO 且逐行单调不减；每轮 user 行 ts ≤ 同轮其余行；`[role, content]` 序列 == `session.history` 的序列；assistant 三条内容原样含 `<final>` / `<tool_call>`；`turn`/`traceId` 与 `run()` 返回值一致；tool 行 `name === "calculator"`，user 行无 `name` |
| 2 | 盘上已有 A/w1 两轮 + B/w9 一轮，新建 `FileTranscriptStore` | `read("A","w1")` deep-equal 文件逐行解析结果（保序）；`[turn, role, content]` 序列逐条对；`list("A") == ["w1"]`、`list("B") == ["w9"]`、`list("nobody") == []`、`read("A","w9") == []` |
| 3 | 不传 `transcripts`（默认内存版），A 与 B 各跑一轮 | `agent.transcripts.read` 的 `[role, content]` == 历史；每行 `turn === 1`、`traceId === "A/s/1"`、ts 是 ISO；`list` 只见本用户；新建的 `MemoryTranscriptStore.read` 为空 |
| 4 | 模型输出含 `<think>` | 转写 assistant 内容已剥 think，与历史同一批（两处相等） |

## 门禁（进程内，已验证）

| 步 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | exit 0 | `1-typecheck.txt` |
| `npm test` | **18 文件 175 条全绿**（基线 17 文件 171 条一条未改，只加 4） | `2-unit.txt` |
| `npm run contracts:check` | 3 份契约 0 漂移 | `3-contracts.txt` |
| `npm run test:live` | **not_run**（GATE_LIVE=0，本票不需要真实模型） | `4-live.txt`（SKIP ≠ 通过） |
| `python3 evals/judge.py evals/live-trace` | files=42 turns=54 transitions=243 passed=54 failed=0 unknown=0（turn 表未动，判分器不受影响） | `6-judge.txt` |

## CLI 冒烟（进程内，已验证；不用真实模型）

`printf '你好\n/exit\n' | OPENAI_BASE_URL=http://127.0.0.1:9 OPENAI_API_KEY=x npm run chat -- --user smoke --session s1 --quiet`
→ `助手> 模型调用失败：network: Connection error.`（结束原因：error）。盘上 `data/transcripts/smoke/s1.jsonl` 两行：

```
{"ts":"2026-09-15T10:25:27.640Z","userId":"smoke","sessionId":"s1","turn":1,"traceId":"smoke/s1/1","role":"user","content":"你好"}
{"ts":"2026-09-15T10:25:28.554Z","userId":"smoke","sessionId":"s1","turn":1,"traceId":"smoke/s1/1","role":"assistant","content":"<final>模型调用失败：network: Connection error.</final>"}
```

error 终态也落转写（三终态 done / max_steps / error 走同一段收尾），user 行 ts 早于 assistant 行约 0.9s（两次退避重试）。

## 没做 / 不确定

- 真实模型 smoke 未跑（not_run）；本票的行为不依赖模型输出形状，假模型覆盖了 final / 工具 / think 三种。
- 未做变异测试：本票承重不变量是「转写 == 写进 history 的同一批」，测试 1 与 4 直接拿 `session.history` 对照，红 2 已证明测试能抓到「没写」。
- 转写只在终态收尾写：一轮中途进程被杀，这一轮不落转写（与 history 行为一致）。复盘侧（R2）按 Q2 把「转写文件缺失或读不出」判 `partial_read`。
- 原生工具模式（`--native-tools`）下 assistant 行的 `toolCalls` 与 tool 行的 `toolCallId` **不进转写行**（评论里行形状没有这两个字段，本票不扩形状）；复盘只需 role/content。若 R4 需要，加字段时先改 `TranscriptLine`。
