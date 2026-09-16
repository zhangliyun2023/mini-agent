# NEXT_STEPS — mini-agent

按价值排序。每条写清“做什么、绿 = 什么”。

## 有 key 之后立刻做

1. ~~修两个 live 暴露的旧问题（#3、#4）~~ → 已在 #6（`83d078a`）修复，修后 live 5/5（`docs/TEST_REPORT.md` §3）。剩下：live 再连跑一次 5/5 且 afterAll 不变量检查过（需要 key）。
2. **API key 不进 trace 的自动测试**：配置里放一个可辨认的假 key 跑一轮（可用 FakeLLM 包一层读配置的客户端），grep `trace/` 与 `data/` 产物；绿 = 找不到。把表里 `api_key_never_in_trace` 从 planned 改 enforced。

## 复盘线（#19 之后）

- **混合输出待拍板**：模型一次输出里一个 tool_call 合法、一个坏 JSON 时，现在执行合法的那些并回喂错误（`t-tools` 行 + parser 消息）。探针审计认为它与“解析失败不跑工具”的直觉冲突；两种修法：errors 非空整体回喂（更保守，多一次模型调用），或维持现状并在不变量 ① 的文字里写明“只针对无任何合法调用的那一步”。拍板后改表。
- **整合器先看已有记忆**：live smoke 里模型把 `remember` 已写的事实换措辞再写一遍，成了 conflict；prompt 里给它现有条目，同义就刷新不新增。
- **partial_read 可补跑**：现在任何已存在的 journal 都当“已定”只递增 attempts；partial 应允许在转写修好后补跑一次（journal 加 `failed` 或允许 partial 覆盖）。
- review 表的答案卷进 `contracts/journeys.json`（现在内联在测试里）；证据工具（`judge.py` / `live-evidence`）按 `feature` 分表查契约，把 `trace/reviews/` 也纳入。
- `extractJsonObject` 从 `protocol/parser.ts` 导出，`consolidate.ts` 不再拷贝。
- 规则兜底同一行多句命中时 key 加句序，避免自碰 conflict。
- 会话表 `busy / queued × ASYNC_DONE` 已建模、运行时未接：HTTP 服务时接队列。

## 状态机线的后续切片

3. **② session 表接代码**：`run()` 开头的 needsCompaction / compactSession 改为走 `sessionMachine` 的 `COMPACT_NEEDED → compacting → COMPACT_DONE|COMPACT_FAILED`，记转移；绿 = 压缩两条既有测试不改断言，契约里 session 表的 P1 行带 covered_by。
4. **③ busy 决策**：决定“忙时新输入”是排队、拒绝还是打断，把 `busy + INPUT` 从 unknown 改成 allowed/rejected 并实现（HTTP 服务时才需要；CLI 单进程不会触发）。
5. **重试作为转移**：`LLM_FAILED [canRetry] → deciding`，facts 加 `{attempt, maxRetries}`；绿 = 重试次数在 trace 上逐次可见，生成器多出重试路径且答案卷仍全对。
6. ~~属性测试 + 自动缩减~~ → **模型层**已做（#5 B2：`src/machine/explore.ts` 随机游走 + ddmin，只用表 + interpret）。剩下**运行层**：随机长事件序列真跑 FakeLLM，失败时缩到最短 FakeLLM 脚本；绿 = 一条故意注入的 runtime bug 被缩到 ≤3 步复现。
7. **解析 warning 回喂**：`<invoke>` 别名目前只进 trace 不回喂；评估是否值得作为 rejected 行（`reject_code: TAG_ALIAS`）让模型自我纠正。
8. **探索器补一条“影子表的 allowed 行必须有 covered_by 或 note”不变量**：B3 变异（unknown 谎报 allowed）目前只在契约层红，探索层不红；绿 = 同一变异探索也红。
9. **journeys.json 的 session / session-runtime 旅程**：两张影子表接代码后补旅程，`checkJourney` 才有东西对。

## 产品线

10. 流式输出（解析器按整段工作，需要增量解析或先流后解析）。
11. 记忆检索式召回（条目多时全量注入会撑 context）。
12. 并发写同一会话的锁（多进程 CLI 同时进同一 `--session`）。
