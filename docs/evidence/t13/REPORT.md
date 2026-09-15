# t13 —— Python 判分器 `evals/judge.py`（#13）

评价对象：commit `a531d0e`（origin/main）+ 本票未提交的改动；证据文件由 `GATE_LIVE=0 bash scripts/gate.sh t13` 落在本目录，2026-09-15 UTC 07:51。

## 做了什么

只新增，不改表、不改 TS runtime：

| 文件 | 内容 |
|---|---|
| `evals/judge.py` | 只用标准库（Python 3.9.6 实测）。递归收集 `*.jsonl`，按文件、按 `trace_id` 分轮，轮内按 `seq` 稳定排序，逐轮跑 ① `no_tool_after_parse_error` ② `exactly_one_final_answer` ③ `terminal_states_distinct` ⑤ `effects_declared` + `unknown_never_silent`。⑤ 的声明从 `--contract`（默认 `contracts/turn.contract.json`）的 `rows[].effects` 读，终态集合从 `terminal` 读；compact 只允许在 seq 1。输出每轮一行 `trace_id<TAB>passed|failed<TAB>file`，failed 的轮缩进列 `✗ [不变量 id] 明细`，unknown 记录另起一节点名，末行 `files=… turns=… transitions=… passed=… failed=… unknown=…`；`--json` 结构化。退出码 0 / 1（有 failed 或 unknown）/ 2（没有任何轮，打印 `not_observed`）。 |
| `test/judge/judge-py.test.ts` | 4 条，全部用 `child_process.spawnSync("python3", ["evals/judge.py", …])` 真跑，断退出码 + stdout（用户可见契约），不 import Python 判据。 |
| `scripts/gate.sh` | 加第 6 步 `run 6-judge 0 python3 evals/judge.py evals/live-trace`，落 `docs/evidence/<label>/6-judge.txt`（5 留给变异证据，与 v0.2 的 `5-mutation-B3.txt` 对齐）。 |

**测试为什么放 `test/judge/` 而不是 `test/unit/`**：`test/unit/docs.test.ts`「条数单一事实源」把 `test/unit/*.test.ts` 的 `it(` 静态计数与 `docs/TEST_REPORT.md` §0 表逐文件对账；本票不碰 TEST_REPORT.md，所以放在 `test/judge/`（`vitest.config.ts` 的 include 是 `test/**/*.test.ts`，`npm test` 照跑）。要挪回 `test/unit/` 只需同时给 §0 表加一行 `judge-py.test.ts | … | 4`，并把合计 +1 文件 +4 条。

## 先红后绿

红：测试先写，`evals/judge.py` 不存在时跑 `npx vitest run test/judge`：

```
× … > 仓库里已提交的 evals/live-trace/ 全部通过：每轮一行 passed，退出码 0；轮数 / 转移数 / 违反数 / unknown 数与 TS 侧 checkTraceFiles 一致
  → /Library/Developer/CommandLineTools/usr/bin/python3: can't open file '/private/tmp/ma-judge/evals/judge.py': [Errno 2] No such file or directory
  : expected 2 to be +0 // Object.is equality
× … > 篡改一条记录（把 TOOLS_DONE 上的 tool 副作用挪到 PARSED_ERROR 转移上）→ 该轮 failed 且点名 trace_id / seq / 不变量 id，退出码 1；其余轮仍 passed；违反的不变量 id 与 TS 侧一致
  → … can't open file … : expected 2 to be 1
× … > 目录里没有任何 .jsonl → 输出 not_observed，退出码 2（不是 0：没观察到 ≠ 通过）
  → expected '' to be 'not_observed'
× … > 契约文件是判据来源：用一份把 t-tools-done 的 effects 声明删掉的契约跑同一批证据 → 每个带 tool 副作用的轮都在 ⑤ 上 failed（反向红：表说了算，不是脚本写死）
  → … can't open file … : expected 2 to be 1
Test Files  1 failed (1)   Tests  4 failed (4)
```

绿：写完 `evals/judge.py` 后同一条命令 `Tests 4 passed (4)`。

四条各自固定的用户可见契约：

1. **正例 + 与 TS 侧对账**：`python3 evals/judge.py evals/live-trace` 退出码 0，36 行全 `passed`，末行与 `checkTraceFiles(listTraceFiles("evals/live-trace"))` 的数字逐字相等；`--json` 的 `summary` / `statuses` / 逐轮 `[file, trace_id, records, terminal]` 与 TS 报告相等。
2. **篡改用例（issue 验收第 2 条）**：把一份 jsonl 复制到临时目录，把某条 TOOLS_DONE 记录前一条（allowed 的 `PARSED_TOOL_CALLS`）改成被拒的 `PARSED_ERROR`（行 `t-parse-error`），tool 副作用从 TOOLS_DONE 挪上去 → 退出码 1，输出含 `<trace_id>\tfailed\t`、`[no_tool_after_parse_error] #<seq> PARSED_ERROR 转移上挂了 1 个 tool 副作用`、`[effects_declared] #<seq> t-parse-error 上出现了表未声明的副作用 "tool"`；同文件其余轮仍 `passed`；末行 `failed=1`。同一份篡改数据丢给 TS `checkTraceOnlyInvariants`，违反的不变量 id 集合相同：`["effects_declared", "no_tool_after_parse_error"]`。
3. **not_observed**：只含非 jsonl 文件的目录 → stdout `not_observed`，退出码 2。
4. **反向红（表说了算）**：把契约里 `t-tools-done` 的 `effects` 清空再跑同一批证据 → 退出码 1，每个带 tool 副作用的轮恰在 ⑤ 上 failed，failed 数 == 含 `t-tools-done`+tool 记录的轮数。

## 与 TS 侧 `live-evidence.test.ts` 对账（同一批 `evals/live-trace/` 文件）

| 口径 | TS `checkTraceFiles` | `evals/judge.py` |
|---|---|---|
| 文件数 | 28 | 28 |
| 轮数（trace_id） | 36 | 36 |
| 转移数（记录条数） | 165 | 165 |
| 违反数（failed 轮） | 0 | 0 |
| unknown 记录 | 0 | 0 |
| status 分布 | `{noop: 67, allowed: 98}` | `{noop: 67, allowed: 98}` |

对账不是手抄：`test/judge/judge-py.test.ts` 第 1 条在进程内同时跑两边并 `toEqual`。判据文字（违反明细）也逐条照抄 `src/machine/invariants.ts`，方便两边输出并排看。

## 门禁数字（`docs/evidence/t13/`）

| 步 | 结果 | 口径 |
|---|---|---|
| 1-typecheck | exit 0 | 已验证（进程内） |
| 2-unit | 13 文件 132 条全绿（基线 12 文件 128 条 + 本票 4 条） | 已验证（进程内） |
| 3-contracts | exit 0，0 漂移 | 已验证（进程内） |
| 4-live | `GATE_LIVE=0` → SKIP | **not_run**（本票不需要真实模型；skipped ≠ 通过） |
| 6-judge | `files=28 turns=36 transitions=165 passed=36 failed=0 unknown=0`，exit 0 | 已验证（进程内） |

基线对照：本票动手前在同一 worktree 跑 `npm run typecheck`（exit 0）与 `npm test`（12 文件 128 条全绿），没有基线失败。

## 诚实边界

- **④ `answer_alignment` 凭 trace 判不了**：需要 `RunResult.answer` 与盘上会话历史末条，judge.py 只读 JSONL，与 TS 侧 `checkTraceOnlyInvariants` 同样不含 ④。
- 篡改用例是**构造**的：已提交的 28 份证据里没有任何 `PARSED_ERROR` 记录（status 分布只有 noop / allowed，没有 blocked / unknown），所以「把 tool 副作用挪到 PARSED_ERROR 上」必须把一条 `PARSED_TOOL_CALLS` 改写成 `PARSED_ERROR`；这也意味着 ①③ 的 blocked / max_steps / error 分支、⑤ 的 compact-非-seq-1 分支只有 TS 侧 `invariants.test.ts` 的假模型用例覆盖，Python 侧没有真实证据跑过。
- judge.py 按 `seq` 排序，TS 侧按文件内顺序；已提交证据两者一致（逐轮 `[file, trace_id, records, terminal]` 对齐通过），乱序文件上两边可能不同。
- `scripts/gate.sh` 的第 6 步没有单独的红测（例外显式声明：shell 一行 + `docs.test.ts` C1 四步顺序仍绿），证据是本目录 `6-judge.txt` 首行环境 / 末行 `exit 0 (expected 0)`。
- 没有 `python3` 的机器上 `test/judge/` 4 条直接红（不 skip）。
