# 拷问问题库（无 UI 仓库版，配合 /grill-with-docs）

每题附推荐；用户“按推荐来”时先复核再定。

## 第一轮

**Q1 机器是闸还是影子？** 运行单元（一轮 / 一个 job）的主循环：(a) 影子——循环不动，旁边挂机器打标签；(b) 闸——循环本身由表 + 解释器驱动，每步先 `interpret`，unknown 不执行。
➡️ 从零写的 runtime 选 (b)：没有改造成本，且 unknown 在代码里没有分支可走。已有大循环的老仓库先 (a) 再升 (b)。

**Q2 表的形式？** 手写 if/else vs 数据表 + 通用解释器。
➡️ 数据表。一张表生成契约 JSON、路径清单、文档矩阵。

**Q3 哪些 oracle 可执行？** 全部 / 只 P0。
➡️ P0 可执行（典型四条：前置未满足不得有副作用；一个意图恰一个终态产物；终态互斥可区分；返回值 == 盘上 == trace）。其余 `planned`。

**Q4 打点单位与去处？** 一次转移一条 `{trace_id, step, from, to, event, status, reason, effects}`；外部调用作为 effects 挂在转移上。本地 JSONL 全量；密钥、用户内容按白名单进。
➡️ 是，全量；无 HTTP 所以没有 request 头，`request_id` 由 runtime 为每次外部调用生成。

**Q5 自动测试指哪种？** 从表 BFS 生成 + 假依赖驱动 + 不变量 oracle（确定性）/ LLM 写用例。
➡️ 前者。第一版只证明“生成集合 == 手写 covered_by 集合”。

**Q6 范围与顺序？** 盘点有状态的东西（不是文件）：主循环、生命周期（新建/恢复/压缩）、并发（busy 时收到新输入或异步完成）。
➡️ 第一批只做主循环接代码；其余建表当文档，没实现的行为标 `kind:'unknown'`。

**Q7 组件层？** ➡️ 不适用，报告里写明。

**Q8 运行时遇到 unknown？** ➡️ 测试模式 = 红；运行模式 = 记 trace + 本单元以 `error` 终态结束（闸的语义：没建模就不动）。

**Q9 第二层（AI 产出）oracle？** ➡️ 若仓库本身调模型：真实模型几条 smoke，断行为；报告写“少量 smoke”。

**Q10 文档？** ➡️ `AGENTS.md` + `docs/ARCHITECTURE.md`（含机器清单）+ `docs/TEST_REPORT.md` + `docs/NEXT_STEPS.md`；词汇表进规格；PLAYBOOK 不写。README 只留运行方式与指路。

**Q11 时间边界？** ➡️ 约定一个时点；没绿则砍生成器与文档，只留表 + 闸。

## 第二轮（依赖第一轮）

- **guard 怎么拿事实**：只看机器自维护的 `facts`（如 `{step, maxSteps, hasToolCalls, hasFinal}`），不读盘、不读外部响应——那些是 oracle 的对象。
- **trace_id / request_id**：一轮一个 trace_id（`run()` 入口生成）；每次模型/网络调用一个 request_id；两个都落到转移行与 effect。
- **旅程**：跨轮的会话算一台影子机器（新建 → 活跃 → 压缩 → 活跃），与轮机器并存。
- **夹具**：表里写 `fixture` = 假依赖脚本名；测试端同名脚本。
- **对答案**：答案卷 `journeys.json`（期望转移序列）+ 终态字段绑定（`RunResult.stoppedBy == trace 末条 to`）。
