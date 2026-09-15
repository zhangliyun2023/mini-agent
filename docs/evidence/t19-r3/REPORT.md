# t19-r3 —— 记忆统一为条目：stated / inferred、conflict 不覆盖、预算丢弃顺序（#19 ④ + Q3 + Q6）

评价对象：分支 `t19-r3-entries`（基于 origin/main `f53cfa1`）；证据文件由 `GATE_LIVE=0 bash scripts/gate.sh t19-r3` 落在本目录（2026-09-15，见各文件首行时间与 commit）。本票不需要真实模型，`4-live` 是 **skipped ≠ 通过**。

## 做了什么

| 文件 | 内容 |
|---|---|
| `src/review/types.ts`（新） | issue #19 第一条评论「共享类型」逐字 `export`。R1 片也会建同名文件、内容相同，合并以先合入的为准。 |
| `src/memory/entries.ts`（新） | 纯函数 `upsertEntry`：同 key 同值 → 刷新 date / source；同 key 不同值 → 追加 `status: "conflict"`、`conflictWith: 旧值`，旧条目保留 active **不覆盖**；不同 key → 追加。`kvView`：active 且 stated 的 key → value。 |
| `src/memory/user-memory.ts` | `UserMemoryStore` 改为条目集合：`entries(userId)`、`upsert(userId, entry)`；保留 `load(userId)`（KV 视图）兼容既有调用；`set()` 保留为便捷写法（stated / 1 / source direct），同样走 upsert 规则。文件实现盘上格式改为 `{ entries: [...] }`，读到旧格式（纯 KV 对象）视为 stated / confidence 1 / source `{sessionId:"legacy", turn:0}`，date 取文件 mtime，下次写入即转新格式。`renderMemory` 接受条目（也仍接受 KV 对象）：stated `- k: v`；inferred `- k: v（推断）`；conflict `- k（待确认：昨天说 新值，之前记 旧值）`；`dropOrder` = conflict → inferred（confidence 低先）→ stated（最老先），同级按写入顺序。 |
| `src/tools/remember.ts` | 写 `{kind: "stated", confidence: 1, source: {sessionId, turn}}`；结果文本仍不回显 value；成了 conflict 时告诉模型「旧值保留，新值标为待确认」。 |
| `src/tools/registry.ts` | `ToolContext` 加可选 `turn`，`invoke` 透传。 |
| `src/runtime/agent.ts` | toolCtx 带 `turn`；组 context 改为 `renderMemory(memory.entries(userId), …)`（之前是 KV 视图）。`memory_truncated` effect 形状不变。 |
| `test/unit/memory-entries.test.ts`（新） | 6 条，断言全部打在用户可见契约上：模型收到的 system prompt 记忆块文本、盘上 memory 文件内容、`remember` 后 entries 的字段、trace 里 `memory_truncated` 的数字。 |
| `docs/TEST_REPORT.md` §0 | 只改数字与本票行：18 文件 177 条；新增 `memory-entries.test.ts | 6`。 |
| `AGENTS.md` | 地图加 `src/review/`、改 `src/memory/` 一行；测试表加本票一行。 |

既有 171 条断言一条没改（含 #12 的三条记忆上限测试，名字与断言都没动）。不动 `.claude/skills/`、`docs/standards/`、README、TEST_REPORT 正文。

## 先红后绿（按竖切顺序）

**片 A（remember 写 stated / conflict 不覆盖 / 同值刷新）** —— 先写 3 条测试，实现前跑 `npx vitest run test/unit/memory-entries.test.ts`：

```
TypeError: memory.entries is not a function
TypeError: memory.entries is not a function
TypeError: memory.upsert is not a function
 Test Files  1 failed (1)
      Tests  3 failed (3)
```

写完 types / entries / store / remember / ToolContext.turn 之后仍有一条红——runtime 还在渲染 KV 视图，conflict 到不了模型：

```
AssertionError: expected '<memory>\n- city: 上海\n</memory>' to contain '（待确认：昨天说 北京，之前记 上海）'
      Tests  1 failed | 2 passed (3)
```

把 `agent.ts` 的 `renderMemory(memory.load(userId))` 改成 `renderMemory(memory.entries(userId))` 后 3 绿，且 `session-context.test.ts` 14 条照常绿。

**片 B（「（推断）」渲染 / 预算丢弃顺序）** —— 再写 2 条，实现丢弃顺序前跑：

```
AssertionError: expected [ '- food: 辣（推断）', '- name: 小张', …(1) ] to deeply equal [ Array(4) ]
      Tests  1 failed | 4 passed (5)
```

（#12 的「最老先丢」把最老的两条 stated / inferred 丢了、conflict 却留着。）实现 `dropOrder` 后 5 绿。

**片 C（旧 KV 文件读为 stated）** —— 1 条。

### 两格没有自然的红（如实写）

1. 「inferred 带（推断）」：`renderEntryLine` 在片 A 已顺手写了三种样子，片 B 那条测试第一次跑就绿。
2. 「旧 KV 文件兼容」：文件实现的兼容分支在片 A 重写 store 时已写，片 C 那条第一次跑就绿。

按纪律对这两格做了变异验红（改实现 → 同一条命令 → 还原）：

```
=== 变异 1：旧格式分支直接 return []
AssertionError: expected {} to deeply equal { city: '上海', name: '小张' }
      Tests  1 failed | 5 passed (6)
=== 变异 2：inferred 不加「（推断）」
AssertionError: expected '<memory>\n- city: 上海\n- lang: 中文\n</m…' to contain '- lang: 中文（推断）'
AssertionError: expected [ '- city: 上海', '- lang: 中文', …(3) ] to deeply equal [ Array(5) ]
      Tests  2 failed | 4 passed (6)
```

还原后 6/6 绿（`git diff` 只剩本票改动）。

## 门禁数字（`docs/evidence/t19-r3/`）

| 步 | 结果 | 口径 |
|---|---|---|
| 1-typecheck | exit 0 | 已验证（进程内） |
| 2-unit | **18 文件 177 条全绿**（171 + 6） | 已验证（进程内） |
| 3-contracts | 3 份契约 0 漂移 | 已验证（进程内） |
| 4-live | **skipped**（GATE_LIVE=0，本票不需要真实模型） | not_run |
| 6-judge | `evals/judge.py` 全 passed，exit 0 | 已验证（子进程） |

## 没做 / 拿不准的（给审阅者）

- **`set()` 语义变了**：之前是覆盖，现在走 upsert（同 key 不同值 → conflict，不覆盖）。「一套记忆」要求只有一种规则，所以没保留覆盖路径；既有测试里没有对同 key 写两次不同值的用法，全绿。
- **conflict 的渲染文案**固定为「（待确认：昨天说 X，之前记 Y）」，与派工原文一致；但 remember 产生的 conflict 未必是「昨天」说的。文案要改只动 `renderEntryLine` 一处。
- **同 key 同值刷新**只刷 date / source，不升 kind / confidence（一条 inferred 被用户亲口确认时仍是 inferred）。派工只说刷新 date/source，没做多余的升级。
- **旧格式的 date** 取文件 mtime（派工没规定）；`set()` 的 source 用 `{sessionId:"direct", turn:0}` 与 legacy 区分。
- **「全 stated 时与 #12 行为一致」**靠 #12 的三条既有测试（断言未动）作为邻近不变量守着，本票没再加一条专门的等价测试。
- `src/review/types.ts` 与 R1 片重复建文件，内容相同；合并时以先合入的为准。
