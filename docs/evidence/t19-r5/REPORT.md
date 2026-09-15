# t19-r5 —— #19 R5 呈现门槛 `src/review/present.ts`

评价对象：origin/main `f53cfa1` + 本票改动；分支 `t19-r5-present`。证据文件由本目录各 `*.txt` 记录（2026-09-15，本机 vitest 3.2.7，不需要 key）。

## 做了什么

纯函数片，不依赖存储、不依赖模型、不改表。

| 文件 | 内容 |
|---|---|
| `src/review/types.ts` | issue #19 第一条评论的共享类型原样 `export`（Source / MemoryEntry / Highlight / Brief / Consolidation / Coverage / ReviewJournal）。**没加任何别的东西**，以便 R1/R2/R3 建的同名文件内容一致、合并时以先合入的为准。 |
| `src/review/present.ts` | `present(consolidation, yesterdayLines) → { brief, dropped, warnings }`。门槛顺序：① `why_today` 缺失 → `missing_why_today`；表外值 → `invalid_why_today:<值>`；② `source` 不是 `{sessionId: string, turn: number}` → `missing_source`；③ 不复述原话：highlight.text 与昨天任一行 content 去空白后相等，或是该行 ≥ 20 字（码点）的连续子串 → `verbatim` + warning「亮点「…」与昨天 <session> 第 <turn> 轮 <role> 的原话逐字重合，已过滤」。剩余为空 → `brief: null`；否则 `text` = 每条一行，前缀按 why_today：「今天到期：」「昨天没收尾：」「你说过今天要：」，保持输入顺序，不加寒暄。上游 `consolidation.warnings` 原样带到输出 warnings 前部。 |
| `test/unit/review-present.test.ts` | 8 条，断言只打返回值（brief.text 精确文本 / brief null / dropped / warnings 内容）。 |
| `docs/TEST_REPORT.md` §0 | 只改数字与本票行：`npm test` 行 18 文件 179 条；条数表新增 `review-present.test.ts | 纯函数 | 8`；合计 18 / 179。 |
| `AGENTS.md` 地图 | 代码树加 `src/review/` 一行；测试表加 `review-present.test.ts` 一行。 |

**`TranscriptLine` 放在哪**：共享类型评论里没有转写行类型，所以按 issue Q2 的形状定义在 `present.ts` 里并 `export`（`{ts, userId, sessionId, turn, traceId, role, content, name?}`），`present` 只读 `content` / `sessionId` / `turn` / `role`。R1 落盘时若在别处定义了同形类型，结构类型可直接传入；R6 编排接线时可把这里的定义改成 re-export，不影响本片测试。

## 先红后绿

红 1（模块不存在）：`0-red-missing-module.txt`

```
FAIL  test/unit/review-present.test.ts
Error: Cannot find module '../../src/review/present.js'
Test Files  1 failed (1)   Tests  no tests
```

红 2（桩实现只返回 `{brief: null, dropped: [], warnings: []}`，让断言真的打在契约上）：`1-red-stub.txt`

```
× 有 due_today 的亮点 → brief 一条，文本带「今天到期：」前缀，不加寒暄
  AssertionError: expected null to deeply equal { highlights: [ { …(3) } ], …(1) }
× 三种 why_today 各一条 → 每条一行、前缀各异、保持输入顺序
  AssertionError: expected undefined to be '昨天没收尾：PR #19 收尾合并\n今天到期：把发票交给财务\n你说过今…'
× 亮点都没有合法 why_today（缺失 / 表外值）→ 全部丢弃并记 reason，brief 为 null
  AssertionError: expected [] to deeply equal [ 'missing_why_today', …(1) ]
× 缺 source（没有 / 不是 {sessionId, turn}）→ 丢弃并记 reason，其余保留
  AssertionError: expected [] to deeply equal [ { highlight: { …(2) }, …(1) }, …(1) ]
× 不复述原话：亮点与昨天某行逐字重合（去空白后相等）→ 过滤并 warning，其余保留
  AssertionError: expected undefined to be '今天到期：把发票交给财务'
× 不复述原话：亮点是某行 ≥ 20 字的连续子串 → 过滤；< 20 字的子串放行
  AssertionError: expected undefined to be '昨天没收尾：PR #19 今晚合不完'
× 所有亮点都被门槛拦下 → brief 为 null，dropped 与 warnings 仍如实记录；上游 warnings 原样带出
  AssertionError: expected [] to deeply equal [ { highlight: { …(3) }, …(1) } ]
Tests  7 failed | 1 passed (8)
```

（「只有闲聊 → null」那条在桩上就绿，是预期：桩恰好返回 null。它的承重由「桩 → 真实现后仍绿」+ 下面的变异共同保证。）

绿：最小实现后 `8 passed (8)`。

## 变异（最承重的不变量：不复述原话）

把 `present.ts` 里 `if (hit)` 改成 `if (false && hit)`（关闭逐字重合过滤）→ `5-mutation-verbatim-off.txt`：3 条红（两条「不复述原话」+「所有亮点都被门槛拦下」），`3 failed | 5 passed`。还原后 8/8 绿，`git diff` 干净。

## 门禁

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | 0 错 | `2-typecheck.txt` |
| `npm run contracts:check` | 3 份契约 0 漂移 | `3-contracts.txt` |
| `npm test` | 18 文件 179 条全绿（既有 171 条一条不改，新增 8） | `4-unit.txt` |
| `npm run test:live` | not_run（本片纯函数，不需要模型） | — |

## 没做 / 不确定

- `≥ 20 字` 按去空白后的 Unicode 码点数；issue 只写「20 字」，中英混排时英文按字符计，没有另定规则。
- 「只发一句或不发」：本片只给 `brief: null`，发不发那一句由 R6/R8 决定。
- 相等判定只去空白，没做标点归一化；「把发票交给财务。」vs「把发票交给财务」会被视为不同——如需更严可在 R6 接线时收紧 `squash`。
