---
name: ai-era-setup
description: Bring a repository onto the AI-era system for the first time (or upgrade its version) — explore, audit, grill, scaffold, then write AGENTS.md with the "which skill when" table so the vocabulary skills fire on their own afterwards.
disable-model-invocation: true
version: 2.0.1
---

# 第一次：把一个仓库带上「状态表 + 打点 + 从表生成的测试」体系

一句话原则：**四个动词是日常，心得是默认，AGENTS.md 是分发器。** 本技能只在两种时候敲：第一次在一个仓库用这一族；仓库已有体系但要升到新版本（`AGENTS.md` 版本行 ≠ 本技能 frontmatter 的 `version:`）。之后的日常只用 `/grill-with-docs` → `/to-spec` → `/to-tickets` → `/implement`；心得技能靠本技能写进 `AGENTS.md` 第 9 节的表让模型自取。

标准原文：[`references/standard.md`](references/standard.md)（§5 状态契约、§6 语义穷举、§7 组合爆炸、§8 打点、§9 不变量、§13 验收、§16 两层状态机、§17 坑）。每步有完成判据；到了判据才进下一步。

## 1. 探索，定分支

| 看什么 | 怎么看 | 决定 |
|---|---|---|
| 有没有 DOM / 页面 / 自己的 HTTP 服务 | `src/` `public/` `app/`、路由文件、`index.html` | 有 → **Web 分支**；都没有（CLI / Agent Runtime / 库 / 守护进程）→ **runtime 分支** |
| Node 版本、`package.json`、测试框架 | `node -v`（Web 脚手架需 ≥ 22）；vitest / pytest / `node --test` | 决定第 5 步用脚手架还是移植 |
| 已跑过一次的痕迹 | `contracts/`、`scripts/contracts-sync.*`、`tests/machines/`、`AGENTS.md` 版本行 | 有 → 升级路径：只做第 3、6、7 步 |
| `AGENTS.md` / `CLAUDE.md` 哪个存在 | `CLAUDE.md` 是否只是 `@AGENTS.md` | 第 6 步写哪个 |
| 已有事件 / 遥测表 | 后端 schema | 判分用 `--db` 还是 `--rows` / JSONL |

**runtime 分支**：词汇技能默认说浏览器的话，先读 [`references/runtime-mapping.md`](references/runtime-mapping.md) 换算（页面 → 一轮、镜像组件 → 终态字段、sqlite → JSONL、脚手架 → 移植），再调它们；第 2、5 步里标 runtime 的段落都指向它。

**完成判据**：一句话写出「本仓走 Web / runtime 分支，因为 ___」，加上是新装还是升级。

## 2. 审计（只读，派子代理）

派一个只读子代理，prompt 用 [`references/audit-prompt.md`](references/audit-prompt.md)，填仓库路径与标准路径；runtime 分支追加 `runtime-mapping.md`「审计时追加给子代理的一段」。派工 prompt 只内联 SKILL.md 相关段与仓库 `AGENTS.md`（`WIKI.md` 是维护者的）。

**完成判据**：报告逐条带 **file:line**；标准 §5、§6、§7、§7A、§8、§9、§10、§11、§13、§16 每节一个等级（满足 / 部分 / 不满足 / 不适用）+ 证据；三条「测试是否落在承重面」抽查；按投入产出排的前五条行动；子代理写明证据边界（没看什么、什么是推断）。

## 3. 拷问，定决策

> 拷问由**主会话**做（`/grill-with-docs` 是手动技能，子代理调不到）；子代理只负责审计与出问题清单，不替用户拍板。探针里无人回答时，才由 agent 把推荐记为决定并标明。

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

**新仓库、runtime 分支**：把 [`references/machine.example.ts`](references/machine.example.ts) 放进仓库。**语义是契约、字段形状不是**：保留 guard 顺序取首条、未列组合返回 unknown、定义期校验、契约 JSON 确定性；字段名、状态形状随实现。表样例 [`references/turn.machine.example.ts`](references/turn.machine.example.ts)，trace 形状 [`references/trace-shape.md`](references/trace-shape.md)，判分 [`references/machine-check.example.ts`](references/machine-check.example.ts)，门禁 [`references/gate.example.sh`](references/gate.example.sh)。

**已有仓库（两分支通用）**：按 [`references/slices.md`](references/slices.md) 的 S0…S7 逐片，每片先红后绿、一片一提交；产品里有 AI 产出的，同文件「第二层」一节。**完成判据**：每片的「绿 =」列成立；时间不够时留 S0–S2，报告里写明砍了什么。

## 6. 写 AGENTS.md（分发器）

`AGENTS.md` 是任何 agent 的唯一入口，`CLAUDE.md` 只写 `@AGENTS.md`。九个章节、顺序、第 9 节「什么时候用哪个 skill」固定表、版本行，全部照 [`references/AGENTS.example.md`](references/AGENTS.example.md) 的形状写（框架托管块原样留在最上面）；版本行的号 == 本技能 frontmatter 的 `version:`。守文档测试照 [`references/docs.test.example.mjs`](references/docs.test.example.mjs)（runtime 收窄版 [`references/runtime-docs.test.example.ts`](references/runtime-docs.test.example.ts)）——它断言什么，就是 AGENTS.md 必须满足什么；改规则 → 同一提交里改测试。写法照 `writing-for-agents`：步骤带完成判据、领词、正向表述、长参考推到 `docs/`。

配套页（Web 分支三页；runtime 分支只 `ARCHITECTURE.md`）：`docs/ARCHITECTURE.md`（进程/目录/数据、**机器清单（接法 + 谁证明）**、一次动作的旅程、测试分层）；`docs/PLAYBOOK.md`（改一个行为的十步、深 vs 浅、三个真反例，范例 [`references/PLAYBOOK.example.md`](references/PLAYBOOK.example.md)）；`docs/GLOSSARY.md`（本仓的话 ↔ 学术的话，范例 [`references/GLOSSARY.example.md`](references/GLOSSARY.example.md)）。

**完成判据**：新开一个会话、只给它 `AGENTS.md`，它能说出产品定位、知道改行为先改哪张表、跑对门禁顺序、找到证据目录、用对口径写报告、从第 9 节取对 skill。做不到的那一条就是缺的那一段。

## 7. 完成判据（整体）

| 项 | 判据 |
|---|---|
| 门禁 | 一键门禁脚本全绿，证据落 `docs/evidence/` |
| AGENTS.md | 九章节齐，版本行 == 本技能 frontmatter 的 `version:` |
| 守文档测试 | 绿 |
| `docs/TEST_REPORT.md` | 有对标标准 §13 八条的表，每条 已验证（真实装配 / 进程内）/ 部分 / 不满足 / 不适用 + 证据；`not_run` 与 `skipped` 分列，都不是通过 |
| `docs/NEXT_STEPS.md` | 存在，没做的诚实写在里面 |
| 日常对答案 | 答案卷 + 镜像组件（runtime：终态字段绑定）可用 |

报告用 `honest-evidence` 口径：脚手架跑通 = 「进程内已验证」；假依赖单测绿 = 「harness 自测」。
