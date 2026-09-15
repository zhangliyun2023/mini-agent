# 状态机决定（mini-agent）

依据：[`docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md`](../standards/2026-09-01-ai时代软件状态机测试与可观测性.md)。2026-09-14 定，2026-09-16 交付前有效。

## §1 比参照强在哪

参照标准写给带 UI 的 Electron 产品；这里是一个无 UI 的 Agent Runtime。强的一点：**runtime 是从零写的，循环可以直接由状态表驱动**，不存在「先影子后闸」的改造期——表就是 loop 的控制流，unknown 转移在代码里没有对应分支可走。

## §2 决定

| # | 决定 |
|---|---|
| D1 | **轮循环（turn）是闸**：每一步先 `interpret(state, event, facts)`，`allowed` 才执行副作用；`unknown` 不执行，本轮以 `error` 终态结束并记 trace |
| D2 | **表达形式 = 数据表 + 一个通用解释器**（从参照 JS 解释器移植到 TS，语义不变：定义期校验、guard 顺序、enumerate、reachable、toContract） |
| D3 | **P0 不变量四条可执行**：无工具执行于解析失败之后；一轮恰一个最终答案；三终态互斥可区分；答案 == 盘上历史末条 == trace 末次决策。其余 `planned` |
| D4 | **打点单位 = 一次转移**：`{trace_id, step, from, to, event, status, reason, effects}`；`trace_id = 用户/会话/轮次`；llm / tool / compact 调用作为 effects 挂在转移上；本地全量落盘，无采样；API key 不进 trace |
| D5 | **自动 E2E = 从表 BFS 生成路径清单，对账手写测试的 `covered_by`**；缺一条即红；不让 LLM 写用例；驱动是 FakeLLM 脚本 |
| D6 | **范围**：① 轮循环——接代码；② 会话生命周期（new → active → compacting）——只建表打标签；③ 会话并发（idle / busy 收到新输入或异步完成）——表里标 `kind:'unknown'`，不接代码 |
| D7 | 组件层 / Storybook：**不适用**（无 UI） |
| D8 | **unknown 处理**：测试模式 = 失败；CLI = 记 trace + 本轮 `error` 终态 |
| D9 | **第二层 oracle**：真实模型五个 live 场景即 smoke；报告写「少量 smoke」，不写可靠率 |
| D10 | **文档**：`AGENTS.md` 唯一入口（含守文档的测试）、本文件、`docs/TEST_REPORT.md`（对标 §13）、`docs/NEXT_STEPS.md`；README 只留运行方式与指路 |
| D11 | **时间边界**：明天中午前状态表线未绿 → 砍生成器与文档，只留表 + 闸 |

## §3 表形状

```
feature: turn        anchor: docs/SPEC.md#实现决策 → 循环
initial: deciding
states:  deciding | executing_tools | done(terminal) | max_steps(terminal) | error(terminal)
events:  LLM_OK | LLM_FAILED | PARSED_TOOL_CALLS | PARSED_FINAL | PARSED_ERROR | TOOLS_DONE
guards:  hasStepsLeft(facts) —— facts 只有机器自己维护的 {step, maxSteps}
kinds:   行级 allowed / rejected(必带 reject_code) / noop / unknown；未列出的 (state, event) = unknown
verdict: 判定级 allowed / blocked / noop / unknown —— rejected 行命中即 blocked（runtime 只跑 onBlocked 回喂，状态不变）
rows:    每行显式 id（t-llm-ok 风格，定义期查重）；答案卷 / trace / journeys.json 都用行 id
```

每条 P0 行带 `covered_by: ['test/unit/<file>::<测试名>']`；enforced 不变量带 `evidence`，planned 不变量带 `note`。

## §4 打点

一次 `interpret` 一条 JSONL 记录：`{trace_id, feature, step, from, to, event, status, reason, reject_code?, transition, effects}`；`transition` = 命中的行 id（unknown 为 null）；`status` 是判定级 verdict（allowed / blocked / noop / unknown），行级 `kind` 里的 rejected 命中即 blocked。`effects` 里放该转移触发的 llm / tool / compact 调用摘要（模型、耗时、token、参数、结果预览），llm / tool 各带一个 `request_id`（`r-` + 短随机，runtime 生成）。`stop` 记录被终态转移取代。

**落盘白名单与显式例外（拍板③）**：API key 不进 trace；模型输出只进 `outputPreview`（截断）；工具 `args` 按工具声明的 `redact(args)` 脱敏（`remember` 的 value 只留长度），工具结果只进 `resultPreview`（截断）。**唯一显式例外：终态转移上 `answer` 副作用带最终答案全文**——不变量 ④「答案 == 盘上历史末条 == trace 末次决策」需要逐字对齐，截断就没法对。

## §5 自动 E2E

`reachable('deciding')` 给出所有可达行；生成器把每条路径展开成「FakeLLM 脚本 → 期望行 id 序列（答案卷）」；测试断言 trace 里的转移序列 == 答案卷，且每条 P0 行的 `covered_by` 在盘上找得到。答案卷另落盘为 `contracts/journeys.json`，`src/machine/check.ts::checkJourney` 吃 trace 行答 passed / failed(closest) / not_observed（人、AI、测试同一个函数）。模型层另有随机探索（`src/machine/explore.ts`：种子游走 + 通用不变量 + ddmin），三张表都跑。

## §6 切片与验收

| 切片 | 内容 | 绿 = |
|---|---|---|
| S0 | 解释器移植 + 单测 | 未列组合 unknown、guard 顺序、enumerate、reachable、toContract 确定性 |
| S1 | `contracts/turn.machine.ts` + 生成 `turn.contract.json` + 漂移测试 | `contracts:check` 0 漂移；reachable 无不可达状态 |
| S2 | 循环改为表驱动（闸）；trace 改为转移记录 | 既有 36 条单测 + 5 条 live 全绿不改断言；trace 序列测试改为对答案卷 |
| S3 | 生成器 + covered_by 对账 | 生成集合 ⊆ 手写覆盖；缺项红一次再补 |
| S4 | 四条 P0 不变量的 oracle 测试 | 每条一红一绿；④ 三处对齐用 FileSessionStore + FileTraceSink 真落盘验 |
| S5 | ②③ 两张表（只建表 + 契约 JSON） | 契约生成；busy 行为 unknown 诚实可见 |
| S6 | 文档四件套 + AGENTS.md 守文档测试 | 文档测试绿；TEST_REPORT 八条逐条有证据 |

## §7 不做

并发 busy 处理的代码；流式输出；LLM 生成用例；组件层；生产采样与告警；跨进程锁。

## §8 拍板记录（issue #5，2026-09-15）

| # | 分歧 | 结论 |
|---|---|---|
| ① | 终态吸收态 vs 禁止出边 | 保留「终态无出边」（定义期校验不放开）；turn 表终态 × 事件在 runtime 不可达，轮结束后到达的事件属外层 `session-runtime` 表。探索器的 terminal-absorbing 不变量按此口径写 |
| ② | 步数上限在解析后拦 vs 工具跑完再拦 | 保留现状（工具跑完 → `TOOLS_DONE` 无 guard 兜底行 `t-tools-done-cap` → max_steps）；理由写进该行 reason |
| ③ | answer 全文进 trace vs 白名单落盘 | 保留全文（不变量 ④ 需要），§4 列为显式例外；工具 args 加 `redact` |
| ④ | 表外状态名 / 事件名返回 unknown 而不抛 | 接受现状（TS 类型编译期挡笔误），已接受的分歧 |
| ⑤ | 状态是字符串数组而非带 meaning/kind 的对象 | 接受现状；契约里 `cells / reachable` 段比参考更有用 |

## §9 实施状态（2026-09-15 追加）

S0–S6 全部落地，`npm run check` 全绿（typecheck、3 份契约 0 漂移、89 条单测）。真实模型 live 本次未重跑（无 key）。

**v0.2（issue #5，2026-09-15）**：行 id / request_id / rejected→blocked / planned note / redact / 答案卷落盘 / 随机探索 / 变异 / 门禁与七章节文档全部落地；`bash scripts/gate.sh v0.2` → typecheck 0、113 条单测全绿、3 份契约 0 漂移、live 5/5，证据在 `docs/evidence/v0.2/`。入口见 `AGENTS.md`，逐条证据见 `docs/TEST_REPORT.md`，剩余项见 `docs/NEXT_STEPS.md`。规格未写死而由实现补的判断（compact 挂哪条转移、unknown 默认处理、runner 协议）记录在 `AI-LOG.md` §3。
