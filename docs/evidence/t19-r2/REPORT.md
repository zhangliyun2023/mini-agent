# t19-r2 —— #19 R2：昨日区间（按计划日期与时区）与转写取数、三态覆盖

评价对象：分支 `t19-r2-collect`，基于 origin/main `f53cfa1`。证据文件由本目录的 `1-typecheck.txt` / `2-unit.txt` / `3-contracts.txt` 记录（2026-09-15 UTC，node 版本见 `1-typecheck.txt` 首行）。不需要真实模型，无 live 步。

## 做了什么

只新增，不改表、不改 runtime、不动既有 171 条断言：

| 文件 | 内容 |
|---|---|
| `src/review/types.ts` | issue 评论里的共享类型原样 `export`（Source / MemoryEntry / Highlight / Brief / Consolidation / Coverage / ReviewJournal）+ Q2 转写行 `TranscriptLine = {ts, userId, sessionId, turn, traceId, role, content, name?}` + 最小读接口 `TranscriptReader { list(userId); read(userId, sessionId): TranscriptLine[] \| null }`（null = 文件缺失或读不出）。R1 / R3 会建同一文件，合并以先合入者为准。 |
| `src/review/window.ts` | `yesterdayWindow(date, tz) → {start, end}`：`date` 是计划日期（今天），区间是 tz 里前一天 00:00 到当天 00:00（半开）。只用 `Intl.DateTimeFormat.formatToParts` 求当地墙钟 → 反推 UTC 瞬间，迭代两次覆盖夏令时切换日；跨月 / 跨年靠 `Date.UTC` 的日归一化。坏日期字符串、不存在的日期（02-30）、不存在的时区都抛。 |
| `src/review/collect.ts` | `collectYesterday(reader, userId, window) → {sessions, coverage, unreadable}`：按用户列会话，只收 ts ∈ [start, end) 的行并按会话分组；`read` 返回 null **或某行 ts 解析不出**（issue ⑥「读不出时间」）→ 该会话进 `unreadable`；coverage：有 unreadable → `partial`（哪怕一条区间内的行都没有，不冒充 none）；否则有行 → `full`；否则 `none`。 |
| `test/unit/review-window.test.ts` | 8 条 |
| `test/unit/review-collect.test.ts` | 8 条，夹具实现 `TranscriptReader` |
| `docs/TEST_REPORT.md` §0 | 只改数字与本票两行：17 文件 171 条 → 19 文件 187 条 |
| `AGENTS.md` 地图 | 加 `src/review/` 一行与两个测试文件行（docs.test 要求测试文件全列出） |

## 先红后绿

红：测试先写，`src/review/window.ts` / `collect.ts` 不存在时跑 `npx vitest run test/unit/review-window.test.ts test/unit/review-collect.test.ts`（全文 `0-red.txt`）：

```
 FAIL  test/unit/review-collect.test.ts [ test/unit/review-collect.test.ts ]
Error: Cannot find module '../../src/review/collect.js' imported from '.../test/unit/review-collect.test.ts'
 FAIL  test/unit/review-window.test.ts [ test/unit/review-window.test.ts ]
Error: Cannot find module '../../src/review/window.js' imported from '.../test/unit/review-window.test.ts'
 Test Files  2 failed (2)
      Tests  no tests
```

绿：写完两个模块后同一条命令 `2 passed / 16 passed`（`1-green-r2.txt`）。

## 变异（最承重的两条不变量，`5-mutation.txt`）

模块级红只证明「文件不存在会红」，所以对 collect 的两条承重不变量各做一次变异（改一行 → 跑 → 记录红 → 还原，`cmp` 确认还原）：

| 变异 | 抓住它的测试 | 红输出 |
|---|---|---|
| A：coverage 先看 `sessions.length === 0 → none`（partial 冒充 none） | 「有读不出的会话且一条区间内的行都没有 → 仍是 partial，不得冒充 none」 | `AssertionError: expected 'none' to be 'partial'` |
| B：右端闭区间 `<= end` | 「边界：今天凌晨 00:30 的行归今天不归昨天…end 本身不含」 | `expected [ '昨天凌晨', '昨天深夜', '恰好 end' ] to deeply equal [ '昨天凌晨', '昨天深夜' ]` |

其余（window 的时区算术）没做变异：8 条测试断的都是具体 ISO 值，任何偏移错误都直接红。

## 测试覆盖（断言全打在返回值上）

window：UTC 区间 ISO 值；Shanghai 区间 ISO 值；同 date 两时区 start 相差恰 8h、各 24h 长；Shanghai 00:30 归今天、23:30 / 昨天 00:30 归昨天、前天 23:59:59 不算；跨月 2026-03-01；跨年 2027-01-01；America/New_York 2026-03-09 区间 23h（夏令时）；三种坏输入抛。

collect：区间外的行不带出；只选有区间内行的会话；边界（今天 00:30 排除、end 本身排除）；read null → unreadable + partial 且其余会话照常；只有 unreadable 无行 → partial 不是 none；行 ts 缺失 / 解析不出 → partial；空用户与全在区间外 → none；别的用户不算。

## 门禁（本目录）

| 文件 | 结果 |
|---|---|
| `1-typecheck.txt` | `tsc --noEmit` exit 0 |
| `2-unit.txt` | 19 文件 187 条全绿（171 既有 + 16 新增），exit 0 |
| `3-contracts.txt` | 3 份契约 0 漂移，exit 0 |
| live | not_run（本票不需要真实模型，未跑；不是通过） |

## 没做 / 不确定

- 没实现转写存储（R1 的事）；`TranscriptReader` 只是夹具级接口，R1 的 `FileTranscriptStore` 接上时应满足 `read` 在文件缺失或 JSON 坏时返回 null 而不是抛——R6 装配时要对一次。
- 「某行 ts 解析不出 → 整个会话按 unreadable 算」是按 issue ⑥「读不出时间」推的口径，比任务书里「null = 文件缺失或读不出」多覆盖一格；如不要，删 `collect.ts` 里那个 `stamps.some(isNaN)` 分支和对应 1 条测试即可。
- `sessions` 顺序 = `reader.list` 的顺序，行顺序 = 文件顺序；没有另外排序。
- `types.ts` 里 `TranscriptLine.role` 用了 `src/llm/types.ts` 的 `Role`；若 R1 先合入且写法不同，以 R1 为准。
