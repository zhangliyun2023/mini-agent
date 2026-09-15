# 术语对照：本仓的话 ↔ 学术 / 工业的话

这个仓库的做法不是发明，是下面这些已有体系的表格化与简化。知道对应关系，就知道哪里可以去查更成熟的做法，哪里是我们有意简化的。

| 本仓的东西 | 术语 | 出处 / 去哪学 | 我们简化了什么 |
|---|---|---|---|
| `contracts/<feature>.machine.mjs`：状态、事件、guard、转移、effects | **Statechart（状态图）/ 有限状态机** | Harel 1987 *Statecharts: A Visual Formalism for Complex Systems*；statecharts.dev；UML 状态机；SCXML；XState | 没有层级状态、没有历史状态；并行靠多台机器各自跑 |
| 十一台机器同时活着、靠事件各自转 | **正交区域 / 通信状态机（communicating FSMs）** | Harel 的 orthogonal regions；CSP（Hoare）；actor 模型 | 机器之间不直接发事件，靠页面代码在两台上各 dispatch |
| `fork` / `invite` 跨页一台机器 | **旅程 / 长事务状态机（saga）** | saga 模式；XState 的 persisted actors | 持久化只在 sessionStorage |
| 未列出的 (状态, 事件) = `unknown` | **完全性检查 / 未建模转移可观测** | 标准 §17.4；model checking 里的 deadlock/unspecified reception | 不做静态完备性证明，靠运行时观测 |
| `machine.interpret()`、`enumerate()`、`reachable()` | **解释器；状态×事件判定表；可达性分析（BFS）** | model checking 的 state-space exploration | 只有确定性 BFS，没有随机探索、没有缩减 |
| `contracts/journeys.json` + `scripts/machine-check.mjs` | **Test oracle；conformance testing；trace checking / runtime verification** | Utting & Legeard *Practical Model-Based Testing*；runtime verification 综述 | 只比精确序列与 alternatives，没有时序逻辑（LTL） |
| 契约由表生成、盘上不一致即红 | **Model-based testing (MBT)：模型是唯一定义，测试从模型生成** | 同上；`@xstate/test` | 场景生成器只做了登录一台机器的通用驱动 |
| P0 / covered_by / 圈格 | **覆盖准则（coverage criteria）：state / transition / transition-pair coverage** | MBT 教材第 4 章 | 我们只到 transition coverage |
| 「笛卡尔穷举不过来，挑有意义的」 | **等价类划分（equivalence partitioning）+ 组合测试（pairwise / t-way）** | NIST ACTS；Kuhn 等 *Introduction to Combinatorial Testing* | 没用 pairwise 工具，靠矩阵手圈 |
| `invariants`（enforced / planned） | **不变量 / 契约式设计（Design by Contract）/ 属性** | Meyer *Object-Oriented Software Construction*；property-based testing | 断言是手写的，没有随机生成输入 |
| `reachable()` + 随机走 + 不变量（未做） | **Stateful property-based testing / state machine testing** | Hypothesis `RuleBasedStateMachine`；QuickCheck / PropEr 的 statem | 未做 |
| `machine_transition` 事件、`trace_id` / `request_id` | **事件溯源（event sourcing）/ 分布式追踪（trace / span）** | Fowler *Event Sourcing*；OpenTelemetry 的 trace/span 模型 | 只有一层 trace，没有 span 树 |
| 一次意图一个 `trace_id` | **causation / correlation id** | 消息系统的 correlation id | — |
| `machine-state.mjs` 镜像组件 | **模型状态的可观测投影（observability）** | — | 只投影状态与最近转移 |
| 闸 / 影子 | **enforcing vs monitoring runtime verification** | runtime verification 文献里的 enforcement monitor / observer | — |
| 候选沙箱试运行 + 差分基线 | **差分测试（differential testing）+ 冒烟测试** | McKeeman *Differential Testing for Software* | 只比报错，不比行为 |
| `verify.sh` 的 exit=3 SKIPPED ≠ 通过 | **测试结果分类：pass / fail / skip / blocked / not observed** | 任何成熟的测试框架 | — |
| 第二层「AI 有没有理解需求」 | **LLM 评测 / agent 评测（behavioural evaluation）** | 标准 §16 | 五条固定需求，样本极小 |

## 学习路径（按投入产出）

1. statecharts.dev 通读（半天）。
2. Harel 1987 原文（两小时）。
3. XState 教程 + `@xstate/test`（一两天，动手）。
4. Hypothesis stateful testing 文档（一晚）。
5. *Practical Model-Based Testing* 前四章（覆盖准则那章对应我们的 P0 圈法）。
6. 想走深：TLA+ 视频课；Petri nets（并发触发）。
