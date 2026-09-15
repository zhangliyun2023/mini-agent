# t12 — 记忆块计入 context 预算并设上限（#12）

分支 `t12-membudget`，基于 `a531d0e`。不需要真实模型；全部证据为进程内假模型单测。

## 做了什么

| 切片 | 提交 | 行为 |
|---|---|---|
| 1 | `feat(memory)` | `ContextOptions.memoryMaxChars`（默认 1200 = `maxHistoryChars` 12k 的 10%）；`renderMemory(mem, limit)` → `{block, truncated?:{total, kept}}`，按写入顺序从最新一条往回装，装不下的最老条目截掉 |
| 2 | `feat(trace)` | `Effect` 新增 `{kind:"memory_truncated", total, kept, limit}`；agent 组 context 时报截断就走 `pendingEffects` 挂在本轮第一条转移上（与 `compact` 同法）；CLI 回显 |
| 3 | `test(context)` | 锁定 `needsCompaction` 只量 history（system prompt 另有上限，两个独立上限）；README「Context 与 memory」段与代码对齐 |

选字符数不选条目数：预算单位本来就是字符，几条长 value 就能撑爆条目数上限却仍「合规」；字符上限直接约束的就是占用。

不改表：截断是 warning 类 effect，不是状态转移；与 compact 一样挂在轮首第一条转移上。契约 0 漂移。

## 验收标准逐条

| AC | 证据 |
|---|---|
| 写入 60 条记忆后 system prompt 记忆块只含上限内条目，trace 有 `memory_truncated`（含总数与保留数） | `session-context.test`「写入 60 条记忆后，模型收到的 system prompt 记忆块只含上限（默认 1200 字符）内最新的条目，最老的被截掉」；「记忆被截时，本轮第一条转移的 effects 里有一条 memory_truncated（含总数、保留数、上限），与 compact 同一挂法；未截时没有」 |
| 未超限时行为不变 | 既有 128 条断言一条没改，全绿；`renderMemory` 不传 limit 时 = 原行为 |
| `needsCompaction` 阈值与 system prompt：文档写明为什么分开 + 一条测试锁定 | README「预算是两个独立上限」；`session-context.test`「记忆块顶满上限、历史未超 maxHistoryChars 时不触发压缩」 |
| README 对应段落更新，docs 测试绿 | README「Context 与 memory」段 + 「最大轮次」行；`docs.test` 绿 |

## 红过什么（TDD 循环里那次失败的原文）

切片 1：
```
× 写入 60 条记忆后，模型收到的 system prompt 记忆块只含上限（默认 1200 字符）内最新的条目，最老的被截掉
AssertionError: expected 2898 to be less than or equal to 1200
 ❯ test/unit/session-context.test.ts:196:26
```

切片 2：
```
× 记忆被截时，本轮第一条转移的 effects 里有一条 memory_truncated（含总数、保留数、上限），与 compact 同一挂法；未截时没有
AssertionError: expected [ 'llm' ] to deeply equal [ 'memory_truncated', 'llm' ]
 ❯ test/unit/session-context.test.ts:215:46
```

切片 3 锁的是既有行为，TDD 拿不到自然的红，做了一次变异（`needsCompaction` 里 `chars` 加 1200 模拟把 system prompt 算进去）：
```
× 记忆块顶满上限、历史未超 maxHistoryChars 时不触发压缩——system prompt 长度不计入历史阈值，记忆自己有上限
AssertionError: expected [ { kind: 'compact', …(3) }, …(1) ] to deeply equal []
 ❯ test/unit/session-context.test.ts:237:38
```
还原后绿。

## 门禁（已验证，进程内）

- `npm run typecheck`：0 错 → `1-typecheck.txt`
- `npm test`：12 文件 131 条全绿（基线 128 + 本票 3）→ `2-unit.txt`
- `npm run contracts:check`：3 份契约 0 漂移 → `3-contracts.txt`
- `npm run test:live`：not_run（本票不需要真实模型）

## 偏离与没做

- `docs/TEST_REPORT.md` 只动了 §0 条数表的三个数字（session-context 11→14、合计 128→131、`npm test` 行）。派工说不碰该文件，但 `docs.test` 用它做「条数单一事实源」逐文件对账，加测试就必须改，否则 docs 测试红；没有写任何报告内容进去。
- 写入顺序依赖 JS 对象插入序：整数样式的 key（如 `"1"`）会被排到最前，`remember` 的 key 实际不会这么起，注释里写明，没有为此改文件格式。
- 单条记忆本身就超过 `memoryMaxChars` 时整块为空、`kept: 0`，上限是硬的；没有为「至少保一条」开例外。
- 记忆的时间衰减、检索式召回不做（NEXT_STEPS 第 11 条保留）。
