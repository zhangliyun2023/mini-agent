---
name: ai-era-setup
description: Bring a repository onto the AI-era system for the first time (or upgrade its version) — explore, audit, grill, scaffold, then write AGENTS.md with the "which skill when" table so the vocabulary skills fire on their own afterwards.
disable-model-invocation: true
version: 2.0.0
---

# 第一次：把一个仓库带上「状态表 + 打点 + 从表生成的测试」体系

一句话原则：**四个动词是日常，心得是默认，AGENTS.md 是分发器。** 本技能只在两种时候敲：第一次在一个仓库用这一族；仓库已有体系但要升到新版本（`AGENTS.md` 版本行 ≠ 本族版本）。之后的日常只用 `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement`；心得技能靠本技能写进 `AGENTS.md` 第 9 节的表让模型自取。

标准原文：[`references/standard.md`](references/standard.md)（§5 状态契约、§6 语义穷举、§7 组合爆炸、§8 打点、§9 不变量、§13 验收、§16 两层状态机、§17 坑）。每步有完成判据；没到判据不进下一步。

## 1. 探索，定分支（不要假设）

| 看什么 | 怎么看 | 决定 |
|---|---|---|
| 有没有 DOM / 页面 / 自己的 HTTP 服务 | `src/` `public/` `app/`、路由文件、`index.html` | 有 → **Web 分支**；都没有（CLI / Agent Runtime / 库 / 守护进程）→ **runtime 分支** |
| Node 版本、`package.json`、测试框架 | `node -v`（Web 脚手架需 ≥ 22）；vitest / pytest / `node --test` | 决定第 5 步用脚手架还是移植 |
| 已跑过一次的痕迹 | `contracts/`、`scripts/contracts-sync.*`、`tests/machines/`、`AGENTS.md` 版本行 | 有 → 升级路径：只做第 3、6、7 步 |
| `AGENTS.md` / `CLAUDE.md` 哪个存在 | `CLAUDE.md` 是否只是 `@AGENTS.md` | 第 6 步写哪个 |
| 已有事件 / 遥测表 | 后端 schema | 判分用 `--db` 还是 `--rows` / JSONL |

**完成判据**：一句话写出「本仓走 Web / runtime 分支，因为 ___」，加上是新装还是升级。

### 分支换算表（runtime 分支必读；Web 分支跳过）

词汇技能默认说浏览器的话。runtime 分支先按这张表换算，再调它们，否则它们会把你往浏览器带。

| 词汇技能里说的 | 无 UI 仓库里指的 | 谁定的 |
|---|---|---|
| 页面 / 机器 | 一个有生命周期的运行单元：Agent 的**一轮**（turn）、一个 job、一次 CLI 命令 | `machine-contract` |
| `trace_id` = 一次用户意图 | 一轮的 id（`用户/会话/轮次` 或 uuid），在 `run()` 入口生成 | `trace-transitions` |
| `request_id` = 一次 HTTP | **每次外部调用**（模型 API、工具的网络请求）一个 id，记进该转移的 `effects` | `trace-transitions` |
| `X-Trace-Id` 请求头 | 不存在；trace_id 直接写进每条转移记录与每条 effect | — |
| 镜像组件 `[data-machine][data-state]` | **`RunResult` 的终态字段**（如 `stoppedBy`）必须 == trace 末条转移的 `to`；一条单测深测 | `answer-key` |
| 转移落库（sqlite） | **JSONL**：一次 `interpret` 一行；判分函数吃 rows 不吃 db | `answer-key` |
| 夹具 `fixture` / 驱动 `drive` | fixture = 脚本化假依赖（FakeLLM 的脚本名）；drive = 触发事件的输入 | `model-e2e` |
| 组件层 / Storybook；布局 / 主题 oracle | **不适用**，报告里写明 | `model-e2e` |
| `setup.mjs` 脚手架 | **不跑**。按第 5 步 runtime 列移植解释器四接口；已有 vitest/pytest 就用它 | 本技能 |
| 生产 unknown「只记录、动作照常」 | **闸的语义**：unknown 不执行副作用，本单元以 `error` 终态结束并记 trace；测试模式 unknown = 红 | 问题库 Q8 |
| 三处对齐（界面 · 接口 · 磁盘） | **返回值 · 盘上持久化 · trace** | 标准 §9 |
| 第二层（AI 产出）oracle | 若仓库本身调模型：真实模型几条 smoke，断行为不断措辞；报告写「少量 smoke」 | 标准 §16 |
| 文档四件套 + PLAYBOOK + GLOSSARY | 收窄为 `AGENTS.md` + `docs/ARCHITECTURE.md`（含机器清单）+ `docs/TEST_REPORT.md` + `docs/NEXT_STEPS.md`；词汇表进规格；PLAYBOOK 不写 | 第 6 步收窄 |

## 2. 审计（只读，派子代理）

派一个只读子代理，prompt 用 [`references/audit-prompt.md`](references/audit-prompt.md)，填仓库路径与标准路径。runtime 分支**追加一段**：「本仓无 UI；§7A / §10 判『有无对应物』（工具/能力清单对账、输出格式）；§8 的 traceId/requestId 按换算表判。」

**完成判据**：报告逐条带 **file:line**；标准 §5、§6、§7、§7A、§8、§9、§10、§11、§13、§16 每节一个等级（满足 / 部分 / 不满足 / 不适用）+ 证据；三条「测试是否落在承重面」抽查；按投入产出排的前五条行动；子代理写明证据边界（没看什么、什么是推断）。

## 3. 拷问，定决策

调 `/grill-with-docs`。问题库按分支选：Web → [`references/web-question-bank.md`](references/web-question-bank.md)；runtime → [`references/runtime-question-bank.md`](references/runtime-question-bank.md)。每题给推荐；用户说「按你的推荐来」时先**复核**每条（找出会改口的那一两条），再定。

**外部锚点（Web 分支，碰公开页 / 登录页 / 主链入口前）**：无痕窗口、不带账号，只拿一条别人发来的链接从头走到目标状态，数点了几次、填了几个框、看到几句只有开发者才懂的话；对照 `contracts/journey-budget.json`（`machine-contract`「旅程预算」）。机器表红不了「用户流失」，只有这一步看得见。

**完成判据**：每题都有决定，写进仓库 `docs/product/SPEC-state-machines.md`（§1 比参照强在哪、§2 决定、§3 表形状、§4 打点、§5 自动测试、§6 切片与验收、§7 不做）。范例：[`references/adoption-example.md`](references/adoption-example.md)。

## 4. 分批与派工

三批的默认切法（Web）：① 主链核心状态机（服务端已有真实状态的那台先做闸）+ 跨页旅程 + 运行时/宿主；② 登录升闸、发布/保存类对话框；③ 成员/权限、列表分页、管理员。runtime：主循环 → 生命周期（新建/恢复/压缩）→ 并发（busy 时新输入 / 异步完成）。

切片清单进 tracker 走 `/to-tickets`（它自带并行派工规则：不相交文件分组、每票独立报告、条数表允许改正文不许改、基线提交）。

**完成判据**：tracker 上一个 issue，列 S0…Sn 与每片的红测名。

## 5. 脚手架 / 切片

**新仓库、Web 分支**：跑脚手架，从不覆盖已有文件；先 `--dry-run`。

```bash
node <本技能目录>/references/setup.mjs <repo> --browser-dir <前端目录> --tests-dir tests/machines
```

它写入 `contracts/{machine.mjs, example.machine.mjs, journeys.json, README.md}`、`scripts/{contracts-sync, machine-scenarios, machine-check}.mjs`、测试骨架、浏览器运行时三件（`machine-client / machine-state / input-cause`）、`docs/agents/ai-era.md`，合并 `package.json` 的 `contracts:sync / contracts:check / test:machines`，追加指向块。**完成判据**：脚本末尾 `verify test:machines → pass N fail 0` 且 `contracts:check` 无 DRIFT；再把两条命令接进现有门禁链（顺序固定）。

**新仓库、runtime 分支**：把 [`references/machine.example.ts`](references/machine.example.ts) 放进仓库。**语义是契约、字段形状不是**：保留 guard 顺序取首条、未列组合 unknown 不静默、定义期校验、契约 JSON 确定性；字段名、状态形状随实现。表样例 [`references/turn.machine.example.ts`](references/turn.machine.example.ts)，trace 形状 [`references/trace-shape.md`](references/trace-shape.md)，判分 [`references/machine-check.example.ts`](references/machine-check.example.ts)，门禁 [`references/gate.example.sh`](references/gate.example.sh)。

**已有仓库（两分支通用）**：按切片表逐片，每片先红后绿、一片一提交。

| 切片 | 用 | 绿 = |
|---|---|---|
| S0 解释器 | `machine-contract`；Web 用脚手架的 `contracts/machine.mjs`，runtime 移植 `machine.example.ts` | 单测：未列组合 unknown、guard 顺序取首条、定义期校验抛错、enumerate 全表、reachable 无不可达、toContract 同表同输出 |
| S1 第一张表 | `machine-contract`：挑最小的机器（登录页 / 一轮）；契约 JSON 由表生成 | `contracts:check` 0 漂移；每条 P0 行有 `covered_by` |
| S2 闸 + 打点 | `trace-transitions`：主链副作用先 `interpret` 后执行；trace_id + request_id 贯穿；一次转移一行；镜像组件（runtime：终态字段绑定） | 进程内：三处同 id；真实装配：界面 == 接口 == 库（runtime：返回值 == 盘上 == trace） |
| S2.5 承重面补洞 | 审计指出的「绕过真实路径」的测试改走真实入口 | 每条一红一绿 |
| S3 生成器 + 答案卷 | `model-e2e`：BFS 出场景，生成集合 == 手写覆盖集合；`answer-key`：`contracts/journeys.json` + 判分 | 第一次跑就红出手写套件的遗漏——那是它工作的证据；判分 passed / failed / not_observed 三态 |
| S3.5 随机探索 | `model-e2e`「模型层随机探索」：只用 interpret 和表，几秒 | 零 guard 洞；发现的洞先补表 |
| S4 P0 不变量 + 变异 | `tdd`：每条不变量一条 Given/When/Then；三处对齐用文件实现真落盘；承重的一两条做变异（unknown 谎报成 modeled → 必须红） | 各一红一绿；变异红写进报告 |
| S5 其余影子 | 每台机器先影子，只建表 + 生成契约；没实现的行为标 `kind:'unknown'` | 契约生成；reachable 豁免 unknown 状态 |
| S6 组件层（仅 Web） | Storybook + 同一张表；`test-storybook` 进门禁 | 变异一处（去掉某个 disabled）→ story 红 |
| S7 写死 | 第 6 步 | 守文档测试绿 |

时间边界：约定时点没绿 → 砍 S3/S5/S6 的生成器与文档，只留 S0–S2（表 + 闸），报告里写明。

**建表 checklist**（每张表过一遍；不适用写「不适用」）：Web 六类见 `machine-contract`「建表 checklist」；runtime 补：busy 时又来一次（轮进行中新输入 / 上一轮异步工具到达）、外部调用失败后的重试（超时 / 限流 / 5xx 各一个等价类，重试用尽是独立事件）、解析失败连发到步数用尽有兜底行、事件早到 / 乱序（轮结束后到达的工具结果、取消后的结果）、终态无出边（轮后事件由外层 session 表接）、步数 / 预算用尽是无 guard 兜底行。

**第二层（产品里有 AI 产出）**：标准 §16——模型输出带结构化可执行的检查步骤；候选在真实沙箱逐条执行并展示 ✓ / ✗ / □；不过退回修一次再记 `CHECKS_FAILED`；沙箱自身故障记 `skipped` 不背锅；`CANDIDATE_BROKEN` 与 `CHECKS_FAILED` 分开；坏候选不以 ready 展示。

## 6. 写 AGENTS.md（分发器）

`AGENTS.md` 是任何 agent 的唯一入口，`CLAUDE.md` 只写 `@AGENTS.md`。范例：[`references/AGENTS.example.md`](references/AGENTS.example.md)、守文档测试 [`references/docs.test.example.mjs`](references/docs.test.example.mjs)（runtime 收窄版 [`references/runtime-docs.test.example.ts`](references/runtime-docs.test.example.ts)）。写法照 `writing-for-agents`：步骤带完成判据、领词、正向表述、长参考推到 `docs/`。

九个章节，顺序固定；框架托管块原样留在最上面：

| # | 章节 | 内容 |
|---|---|---|
| 1 | 这个产品是什么（一句话） | 定位、第一批用户、一个核心取舍 |
| 2 | 铁律（改行为前必读） | 十条以内，每条一句 + 为什么：表是唯一事实源；闸/影子/旅程；unknown 可观测；两个 id 四处落地；对答案只看答案卷 + 镜像组件；先红后绿、断言落承重面；报告口径；不拆安全门 |
| 3 | 门禁（提交前必须全绿，顺序固定） | 一段命令块；改了什么必须重新构建也写在这 |
| 4 | 地图（去哪找什么） | 要做的事 → 文件；指向的每份文档都必须存在 |
| 5 | 禁止事项 | 只放正向说不清的硬闸：手改生成物、放宽 oracle、LLM 生成用例、生产拦 unknown、`git add -A` |
| 6 | 提交纪律 | 门禁绿 → 清理构建副产物 → `diff --check` → 显式路径 add → 中文 conventional commit（正文写红过什么、门禁数字）→ 证据目录 → 一票一提交；不加 AI 尾注 |
| 7 | 证据口径 | `honest-evidence` 的那张表 |
| 8 | Agent skills / tracker / 标签 | `.claude/skills/` 清单；tracker 与认领方式（`/implement #<n>`）；分诊标签同名字符串（`ready-for-agent`）；`CONTEXT.md` / `docs/adr/` 有没有 |
| 9 | 什么时候用哪个 skill | 下面这张表原样放进去，再加一行版本 |

第 9 节固定表（心得靠它自取，不靠人敲）：

| 你在做的事 | 先做 | 取哪个 skill |
|---|---|---|
| 改用户可见行为 | 先改 `contracts/*.machine.*` | `machine-contract` |
| 加日志 / 打点 / 要回放一次运行 | — | `trace-transitions` |
| 写测试 / 复现一次失败 | — | `model-e2e` + `tdd` |
| 跑完一次流程问「对不对」 | — | `answer-key` |
| 写报告 / 要说「已验证」 | — | `honest-evidence` |
| Electron 改动 | — | `electron-real-machine-verify` |
| 审 diff | — | `code-review` |
| 改 AGENTS.md / skill 文档 | — | `writing-for-agents` |

版本行（守文档测试对账这一行存在）：`本仓技能族：ai-era-skills 2.0.0`。

配套页（Web 分支三页；runtime 分支只 `ARCHITECTURE.md`）：`docs/ARCHITECTURE.md`（进程/目录/数据、**机器清单（接法 + 谁证明）**、一次动作的旅程、测试分层）；`docs/PLAYBOOK.md`（改一个行为的十步、深 vs 浅、三个真反例，范例 [`references/PLAYBOOK.example.md`](references/PLAYBOOK.example.md)）；`docs/GLOSSARY.md`（本仓的话 ↔ 学术的话，范例 [`references/GLOSSARY.example.md`](references/GLOSSARY.example.md)）。

守文档测试（跑在单测里）：九个章节都在；地图指向的文档存在；门禁里每条命令是真实脚本；`ARCHITECTURE.md` 机器清单 == `contracts/*.machine.*` 文件集合（少列多列都红）；版本行存在且 == 本族版本；README 指向 AGENTS.md。改规则 → 同一提交里改测试。

**完成判据**：新开一个会话、只给它 `AGENTS.md`，它能说出产品定位、知道改行为先改哪张表、跑对门禁顺序、找到证据目录、用对口径写报告、从第 9 节取对 skill。做不到的那一条就是缺的那一段。

## 7. 完成判据（整体）

| 项 | 判据 |
|---|---|
| 门禁 | 一键门禁脚本全绿，证据落 `docs/evidence/` |
| AGENTS.md | 九章节齐，版本行 == `ai-era-skills 2.0.0` |
| 守文档测试 | 绿 |
| `docs/TEST_REPORT.md` | 有对标标准 §13 八条的表，每条 已验证（真实装配 / 进程内）/ 部分 / 不满足 / 不适用 + 证据；`not_run` 与 `skipped` 分列，都不是通过 |
| `docs/NEXT_STEPS.md` | 存在，没做的诚实写在里面 |
| 日常对答案 | 答案卷 + 镜像组件（runtime：终态字段绑定）可用 |

报告用 `honest-evidence` 口径：脚手架跑通 = 「进程内已验证」，不是任何页面已接入。

## 8. 不要做

- 不在无 UI 仓库跑 `setup.mjs`、不写镜像 DOM 组件——走 runtime 分支。
- 不在执行者（做票的 agent）prompt 里给 `WIKI.md`；只内联 SKILL.md 相关段与仓库 `AGENTS.md`。
- 不让 LLM 生成用例；用例从表生成。
- 不加 AI 尾注（Co-Authored-By / Session 链接）到提交与 PR。
- 不把「假依赖单测绿」写成「真实模型已验证」；不引用私有项目名——方法论可以随仓库公开。
