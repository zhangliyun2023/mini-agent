# runtime 分支换算表

词汇技能（`machine-contract` / `trace-transitions` / `model-e2e` / `answer-key`）默认说浏览器的话。无 UI 仓库（CLI / Agent Runtime / 库 / 守护进程）先按这张表换算，再调它们。

| 词汇技能里说的 | 无 UI 仓库里指的 | 谁定的 |
|---|---|---|
| 页面 / 机器 | 一个有生命周期的运行单元：Agent 的**一轮**（turn）、一个 job、一次 CLI 命令 | `machine-contract` |
| `trace_id` = 一次用户意图 | 一轮的 id（`用户/会话/轮次` 或 uuid），在 `run()` 入口生成 | `trace-transitions` |
| `request_id` = 一次 HTTP | **每次外部调用**（模型 API、工具的网络请求）一个 id，记进该转移的 `effects` | `trace-transitions` |
| `X-Trace-Id` 请求头 | 不存在；trace_id 直接写进每条转移记录与每条 effect | — |
| 镜像组件 `[data-machine][data-state]` | **`RunResult` 的终态字段**（如 `stoppedBy`）必须 == trace 末条转移的 `to`；一条单测深测 | `answer-key` |
| 转移落库（sqlite） | **JSONL**：一次 `interpret` 一行；判分函数吃 rows | `answer-key` |
| 夹具 `fixture` / 驱动 `drive` | fixture = 脚本化假依赖（FakeLLM 的脚本名）；drive = 触发事件的输入 | `model-e2e` |
| 组件层 / Storybook；布局 / 主题 oracle | 不适用，报告里写明 | `model-e2e` |
| `setup.mjs` 脚手架 | 换成移植 [`machine.example.ts`](machine.example.ts) 的四接口；已有 vitest/pytest 就用它 | `ai-era-setup` 第 5 步 |
| 生产 unknown「只记录、动作照常」 | **闸的语义**：unknown 不执行副作用，本单元以 `error` 终态结束并记 trace；测试模式 unknown = 红 | 问题库 Q8 |
| 三处对齐（界面 · 接口 · 磁盘） | **返回值 · 盘上持久化 · trace** | 标准 §9 |
| 第二层（AI 产出）oracle | 若仓库本身调模型：真实模型几条 smoke，断行为不断措辞；报告写「少量 smoke」 | 标准 §16 |
| 文档四件套 + PLAYBOOK + GLOSSARY | 收窄为 `AGENTS.md` + `docs/ARCHITECTURE.md`（含机器清单）+ `docs/TEST_REPORT.md` + `docs/NEXT_STEPS.md`；词汇表进规格 | `ai-era-setup` 第 6 步 |

## 审计时追加给子代理的一段

「本仓无 UI；§7A / §10 判『有无对应物』（工具/能力清单对账、输出格式）；§8 的 traceId/requestId 按换算表判。」

## 建表 checklist 的 runtime 补充

在 `machine-contract`「建表 checklist」六类之上，每张表再过一遍（不适用写「不适用」）：

- busy 时又来一次：轮进行中新输入 / 上一轮异步工具到达
- 外部调用失败后的重试：超时 / 限流 / 5xx 各一个等价类；重试用尽是独立事件
- 解析失败连发到步数用尽有兜底行
- 事件早到 / 乱序：轮结束后到达的工具结果、取消后的结果
- 终态无出边：轮后事件由外层 session 表接
- 步数 / 预算用尽是无 guard 兜底行
