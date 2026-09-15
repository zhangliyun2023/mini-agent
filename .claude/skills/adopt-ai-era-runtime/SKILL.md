---
name: adopt-ai-era-runtime
description: Bring a NO-UI repository (CLI tool, agent runtime, library, daemon) onto the AI-era system — same standard, same vocabulary skills, but with the browser/HTTP assumptions replaced by runtime equivalents (turn = trace_id, LLM call = request_id, RunResult = mirror component, JSONL = transition store). Use instead of /adopt-ai-era when the repo has no DOM, no pages, no HTTP server of its own.
disable-model-invocation: true
version: 1.2.0
---

# 把一个无 UI 仓库带上「状态表 + 打点 + 从表生成的测试」体系

`/adopt-ai-era` 假定仓库有页面、浏览器、HTTP 后端；这份是它在 **CLI / Agent Runtime / 库** 上的版本。标准原文同一份（本仓 `docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md`），词汇技能同一套（`machine-contract` / `trace-transitions` / `model-e2e` / `answer-key` / `honest-evidence` / `agents-md`），只把落点换掉。**先读这一节的换算表，再调词汇技能，否则它们会把你往浏览器带。**

## 0. 换算表（词汇技能里的词 → 本类仓库的落点）

| 词汇技能里说的 | 无 UI 仓库里指的 | 谁定的 |
|---|---|---|
| 页面 / 机器 | 一个有生命周期的运行单元：Agent 的**一轮**（turn）、一个 job、一次 CLI 命令 | `/machine-contract` |
| `trace_id` = 一次用户意图 | 一轮的 id（`用户/会话/轮次` 或 uuid），在 `run()` 入口生成 | `/trace-transitions` |
| `request_id` = 一次 HTTP | **每次外部调用**（模型 API、工具的网络请求）一个 id，记进该转移的 `effects` | `/trace-transitions` |
| `X-Trace-Id` 请求头 | 不存在；trace_id 直接写进每条转移记录与每条 effect | — |
| 镜像组件 `[data-machine][data-state]` | **`RunResult` 的终态字段**（如 `stoppedBy`）必须 == trace 末条转移的 `to`；这是「代码说的」与「机器说的」唯一绑定，用一条单测深测 | `/answer-key` |
| 转移落库（sqlite） | **JSONL**：一次 `interpret` 一行；判分函数吃 rows 不吃 db | `/answer-key` |
| 夹具 `fixture` / 驱动 `drive` | fixture = 脚本化假依赖（FakeLLM 的脚本名）；drive = 触发事件的输入 | `/model-e2e` |
| 组件层 / Storybook | **不适用**，报告里写明 | `/model-e2e` |
| 布局 / 主题 oracle | **不适用** | — |
| `setup-ai-era` 脚手架（`.mjs` + `node --test` + 浏览器运行时） | **不跑**。按下面 S0 用仓库自己的语言移植解释器四接口；已有 vitest/pytest 就用它 | `/setup-ai-era` 自己写了这条出路 |
| 生产 unknown「只记录、动作照常」 | **闸的语义**：unknown 不执行副作用，本单元以 `error` 终态结束并记 trace；测试模式 unknown = 红 | `question-bank` Q8 |
| 三处对齐（界面 · 接口 · 磁盘） | **返回值 · 盘上持久化 · trace** 三处 | 标准 §9 |
| 第二层（AI 产出）oracle | 若仓库本身调模型：真实模型的几条 smoke 场景，断行为不断措辞；报告写「少量 smoke」 | 标准 §16 |
| 文档四件套 + PLAYBOOK + GLOSSARY | 收窄为 `AGENTS.md` + `docs/ARCHITECTURE.md`（含机器清单，被守文档测试对账）+ `docs/TEST_REPORT.md` + `docs/NEXT_STEPS.md`；词汇表放规格文件里，PLAYBOOK 不写 | `/agents-md` 收窄 |

## 1. 审计（只读，派子代理）

prompt 用 [`references/audit-prompt.md`](references/audit-prompt.md)，**追加一段**：「本仓无 UI；§7A / §10 判『有无对应物』（工具/能力清单对账、输出格式）；§8 的 traceId/requestId 按上表换算后判。」子代理的报告必须逐条 file:line，并写证据边界（没运行测试就写没运行）。

**完成判据**同 `/adopt-ai-era`。

## 2. 拷问，定决策

用 `/grill-with-docs` 跑 [`references/question-bank-runtime.md`](references/question-bank-runtime.md)。用户「按推荐来」时先复核，改口的地方明说。决定写进 `docs/product/SPEC-state-machines.md`（一页：比参照强在哪 / D1–D11 / 表形状 / 打点 / 自动测试 / 切片与验收 / 不做）。

## 3. 切片（每片一个提交，先红后绿）

| 切片 | 用 | 绿 = |
|---|---|---|
| S0 解释器 | 把 [`references/machine.example.ts`](references/machine.example.ts) 放进仓库。**语义是契约、字段形状不是**：必须保留的是 guard 顺序取首条、未列组合 unknown 不静默、定义期校验、契约 JSON 确定性；字段名、状态是对象还是字符串、契约 JSON 的段落随实现，不要把「和参考长得不一样」当缺陷 | 单测：未列组合 unknown、同格多行按 guard 顺序取首条、定义期校验抛错、enumerate 全表、reachable 无不可达、toContract 同表同输出 |
| S1 第一张表 | `/machine-contract`；表样例 [`references/turn.machine.example.ts`](references/turn.machine.example.ts)；契约 JSON 由表生成，`contracts:check` 漂移即红 | 0 漂移；每条 P0 行有 `covered_by` |
| S2 闸 + 打点 | 运行单元的主循环改为「先 `interpret` 后副作用」；trace 改为一次转移一行（[`references/trace-shape.md`](references/trace-shape.md)）；顺手删掉指向不存在文件的脚本 | 既有单测不改断言全绿；trace 序列测试改为对答案卷 |
| S2.5 承重面补洞 | 审计指出的「绕过真实路径」的测试改走真实入口（如工具测试走 `registry.invoke` 而不是直接调 handler）；无测试的分支补齐 | 每条一红一绿 |
| S3 生成器 + 答案卷 | `/model-e2e`：`reachable()` 生成路径集合 == 手写 `covered_by` 集合；`/answer-key`：`contracts/journeys.json` + [`references/machine-check.example.ts`](references/machine-check.example.ts) 吃 JSONL rows | 第一次跑就红出手写套件的遗漏；判分 passed / failed / not_observed 三态 |
| S3.5 模型层随机探索 | `/model-e2e`：随机游走 + 通用不变量 + ddmin 缩减 | 零 guard 洞；发现的洞先补表 |
| S4 P0 不变量 + 三处对齐 | 每条不变量一条 Given/When/Then；三处对齐用**文件实现**（不是内存实现）真落盘验；对最承重的一两条做一次变异（把 unknown 谎报成 modeled → 必须红） | 各一红一绿；变异红写进报告 |
| S5 影子表 | 其余有状态的东西只建表 + 生成契约，不接代码；没实现的行为标 `kind:'unknown'` 诚实可见 | 契约生成；reachable 豁免 unknown 状态 |
| S6 写死 | `/agents-md` 收窄版 + [`references/gate.example.sh`](references/gate.example.sh) 一键门禁落 `docs/evidence/` + `docs/TEST_REPORT.md`（对标 §13 八条）+ `docs/NEXT_STEPS.md` | 守文档测试绿；报告八条逐条有证据；skipped ≠ 通过 |

时间边界：切片线在约定时点没绿 → 砍 S3/S5/S6 的生成器与文档，只留 S0–S2（表 + 闸），并在报告里写明。

## 3.5 建表 checklist（runtime 版，每张表过一遍，不适用写「不适用」）

- **busy 时又来一次**：轮进行中收到新的用户输入 / 上一轮的异步工具在本轮到达 → 表里要有行（noop / rejected / 排队），至少标 `kind:'unknown'` 状态诚实可见。
- **外部调用失败后的重试**：超时 / 限流 / 5xx 各是一个 facts 等价类；重试次数用尽是独立事件。
- **解析失败连发**：连续 PARSED_ERROR 到步数用尽要有兜底行，不能靠 unknown。
- **事件早到 / 乱序**：工具结果在轮次已结束后到达；取消后的结果。
- **终态无出边**（解释器定义期校验）：一轮到终态循环即退出，终态 × 事件在 runtime 不可达；轮结束后到达的事件（异步工具结果、用户新输入）由外层 session-runtime 表接，不进 turn 表。（2026-09-15 拍板，runtime 参照仓 #5 ①）
- **步数 / 预算用尽**：无 guard 兜底行，不是 guard 里的 else。

随后跑一次**模型层随机探索**（`/model-e2e`「模型层随机探索」，只用 interpret 和表，几秒）：已建模的格不得返回 unknown；第一次红出来的 guard 洞补表、真实运行产生不了的组合登记为状态约束。

## 4. 完成判据

`AGENTS.md` 是唯一入口且有守文档的测试；`docs/TEST_REPORT.md` 有 §13 八条表，每条 已验证（进程内 / 真实外部依赖少量 smoke）/ 部分 / 不满足 / 不适用 + 证据；没条件跑的写 `not_run`，跑了主动跳过的写 `skipped`，两者都不是通过；`scripts/gate.sh` 落证据目录；答案卷 + 终态字段绑定是日常「对答案」的方式；没做的诚实写在 `docs/NEXT_STEPS.md`。

## 5. 不要做

不跑 `setup.mjs`；不为无 UI 仓库写镜像 DOM 组件；不让 LLM 写用例；不把「假依赖单测绿」写成「真实模型已验证」；不引用私有项目或私有框架的名字；本技能与标准原文可以随仓库公开——方法论本身就是交付物的一部分。
