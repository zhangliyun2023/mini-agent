# NEXT_STEPS — mini-agent

按价值排序。每条写清「做什么、绿 = 什么」。

## 有 key 之后立刻做

1. **修两个 live 暴露的旧问题**（issue #3 mock search 分词、#4 `<function=…>` 标签变体）；绿 = 各一条红测转绿，live 连跑两次 5/5。
2. **API key 不进 trace 的自动测试**：配置里放一个可辨认的假 key 跑一轮（可用 FakeLLM 包一层读配置的客户端），grep `trace/` 与 `data/` 产物；绿 = 找不到。把表里 `api_key_never_in_trace` 从 planned 改 enforced。

## 状态机线的后续切片

3. **② session 表接代码**：`run()` 开头的 needsCompaction / compactSession 改为走 `sessionMachine` 的 `COMPACT_NEEDED → compacting → COMPACT_DONE|COMPACT_FAILED`，记转移；绿 = 压缩两条既有测试不改断言，契约里 session 表的 P1 行带 covered_by。
4. **③ busy 决策**：决定「忙时新输入」是排队、拒绝还是打断，把 `busy + INPUT` 从 unknown 改成 allowed/rejected 并实现（HTTP 服务时才需要；CLI 单进程不会触发）。
5. **重试作为转移**：`LLM_FAILED [canRetry] → deciding`，facts 加 `{attempt, maxRetries}`；绿 = 重试次数在 trace 上逐次可见，生成器多出重试路径且答案卷仍全对。
6. ~~属性测试 + 自动缩减~~ → **模型层**已做（#5 B2：`src/machine/explore.ts` 随机游走 + ddmin，只用表 + interpret）。剩下**运行层**：随机长事件序列真跑 FakeLLM，失败时缩到最短 FakeLLM 脚本；绿 = 一条故意注入的 runtime bug 被缩到 ≤3 步复现。
7. **解析 warning 回喂**：`<invoke>` 别名目前只进 trace 不回喂；评估是否值得作为 rejected 行（`reject_code: TAG_ALIAS`）让模型自我纠正。
8. **探索器补一条「影子表的 allowed 行必须有 covered_by 或 note」不变量**：B3 变异（unknown 谎报 allowed）目前只在契约层红，探索层不红；绿 = 同一变异探索也红。
9. **journeys.json 的 session / session-runtime 旅程**：两张影子表接代码后补旅程，`checkJourney` 才有东西对。

## 产品线

10. 流式输出（解析器按整段工作，需要增量解析或先流后解析）。
11. 记忆检索式召回（条目多时全量注入会撑 context）。
12. 并发写同一会话的锁（多进程 CLI 同时进同一 `--session`）。
