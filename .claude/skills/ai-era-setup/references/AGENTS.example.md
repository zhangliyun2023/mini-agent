<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# 接着做 / Web 参照仓 — 给任何 agent 的操作手册

这份文件是唯一入口。`tests/platform/docs.test.mjs` 守着它和它指向的文档：章节缺了、机器表少列了、命令改名了都会红。改规则先改这里，再改测试。

## 这个产品是什么（一句话）

**网页版 4399，但每个游戏都能被任何人一句话接着改。** 匿名打开就能玩；登录后拿到别人的链接，用一句话让 AI 改出自己的版本并发布，链接一直活着、来源可追溯。免费、不做积分/付费；第一批用户是学生朋友圈。用户只做一件事——打字；可靠性靠「候选沙箱试运行」流水线（`docs/product/SPEC-sandbox-verify.md`），不靠缩小 AI 可改范围。完整定位见 `docs/product/PRD.md` 1.1。

## 铁律（改行为前必读）

1. **机器表是唯一事实源。** 每个有状态的功能都有一张 `contracts/<feature>.machine.mjs`（statechart 的表格化）。改任何行为：**先改表 → `npm run contracts:sync` → 再动代码**。`*.contract.json`、`*.scenarios.json` 是生成物，不手改；`npm run contracts:check` 漂移即红。
2. **闸 / 影子 / 旅程 三种接法，不要混。** 闸：副作用必须经 `dispatch`，blocked 就不发请求（`run`、`editor`、`login`、`publish`）。影子：只观察、只记录、不拦（`runtime`、`manual`、`members`、`workspace`、`admin`）。旅程：跨页一台机器，状态与 `trace_id` 经 `sessionStorage`（`fork`、`invite`）。新页面先影子再升闸。
3. **未列出的 (状态, 事件) = unknown，永远可观测。** 测试模式 unknown = 测试失败；生产只记录不拦，进管理员页「未建模转移」队列。发现 unknown 的处理是**补表**，不是删断言。
4. **一次用户意图一个 `trace_id`，一次 HTTP 一个 `request_id`。** 两个 id 都要落到 `runs / audit / events` 行、worker `TRACE` 日志、失败 toast 与候选面板。新意图 = 离开初始状态 或 行上标 `effects.intent`。
5. **对答案只看两样：答案卷 + 镜像组件。** `contracts/journeys.json` 是期望的转移序列；`node scripts/machine-check.mjs --db <sqlite>` 判分；页面上 `[data-machine-state] [data-machine=<feature>]` 的 `data-state` 就是「UI 说机器在哪」。**只有 `public/platform/machine-state.mjs` 这一处绑定需要看源码核对**（Storybook「状态机/镜像组件」story），其余一律看答案卷。
6. **先写红的测试，红必须真红过。** 断言打在用户可见契约上：可见文案、焦点、请求次数、Cookie、URL、DOMRect、computed style、接口返回、DB 行、worker 日志。**不断类名、不断隐藏元素、不断中间函数。** 例外（纯文档、纯重命名、探针脚本）要显式说出来。
7. **报告口径分层，SKIPPED ≠ 通过，harness 自测 ≠ 模型结果。** 已验证（Next E2E）/ 已验证（Node/HTTP）/ demo / 未运行 / skipped 五个词不混用。少量 smoke 不写成可靠率。
8. **候选不改草稿，应用不发布，发布只移指针。** 坏的候选（沙箱加载或点击报错）永远不以 ready 展示；无浏览器如实标 skipped，不假装通过。
9. **AI 侧分层写在 prompt 里，用户看不见。** 可调项进 `config.json` / `CONFIG`，核心循环独立；不做用户可见的参数表单。
10. **不删 `requireLocal()`。** 本地适配器只允许回环地址；公网走 hosted 模式（未做），不是拆门。

## 门禁（提交前必须全绿，顺序固定）

```bash
npm run lint && npm run typecheck && npm test        # 单测含 machine / contracts / trace / verify / verify_chain / docs
npm run contracts:check                               # 表 ↔ 生成物 无漂移
npm run test:http                                     # 离线 HTTP 集成
npm run build && npm run test:e2e:next                # 真实 Next 生产构建 + Chromium/Firefox/mock-AI 三轮（末尾：全链路零 unknown + 答案卷逐条对）
npm run test:storybook                                # 组件层：每个 story 的 play() 无头重放
RUN_LIVE_AI=1 npm run test:ai-behavior                # 真实模型（要 .env 密钥，有费用）——改了 provider / prompt / 沙箱才跑
bash scripts/verify.sh v0.<n>                         # 一次跑完上面全部并落证据到 docs/evidence/v0.<n>/
```

日常验证用定点：`node --test tests/platform/<file>.test.mjs`、`E2E_BROWSERS=chromium E2E_SKIP_MOCKAI=1 E2E_FAIL_FAST=1 npm run test:e2e:next`。改了 `public/platform/*` 或 `contracts/*` 或 `server/*` 必须 `npm run build` 再跑 E2E（它们被打进构建）。E2E 失败看回放包 `docs/evidence/next-e2e/failures/<浏览器>-<步骤>/`（trace.zip / DOM / 截图 / api.jsonl / console / TRACE）。

## 地图（去哪找什么）

| 要做的事 | 看 |
|---|---|
| 架构、进程、数据表、模块职责、十一台机器清单 | `docs/ARCHITECTURE.md` |
| 改一个行为 / 加一个功能的固定流程 | `docs/PLAYBOOK.md` |
| 本仓的话 ↔ 学术/工业的话 | `docs/GLOSSARY.md` |
| 契约怎么和代码拴在一起、怎么对答案、trace 字段 | `contracts/README.md` |
| 产品定位、目标用户、增长循环 | `docs/product/PRD.md`、`docs/product/TECH_SPEC.md` |
| 两份已确认的规格 | `docs/product/SPEC-sandbox-verify.md`、`docs/product/SPEC-state-machines.md` |
| 每一轮的门禁数字与诚实边界 | `docs/TEST_REPORT.md`、`docs/evidence/` |
| 安全边界与残余风险 | `docs/SECURITY_NOTES.md` |
| 接口 | `docs/API.md` |
| 下一步 | `docs/NEXT_STEPS.md` |
| 组件层 | `docs/storybook/README.md` |

## 禁止事项

- 手改 `contracts/*.contract.json` / `*.scenarios.json`；跳过 `contracts:sync`。
- 为了变绿放宽 oracle（把文案断言改成「可见」、把精确序列改成子序列、把 unknown 从断言里剔掉）。
- 用 LLM 生成测试用例；用 LLM 判定「这个转移应该 allowed」——那是人拍板后进表。
- 生产拦截 unknown。
- 把 `demoProposal` 的预设改名成真实 Agent；把 `test:ai-behavior:selftest`（mock）写成模型结果。
- 提交 `.env`、`.data`、`next-env.d.ts` 的构建改动、`docs/evidence/next-e2e/failures/`。
- 在没跑过基线对照的情况下写「已知基线失败」。
- 用 `git add -A`；用 Playwright 全量 E2E 当日常验证入口。

## 提交纪律

门禁绿 → `git checkout -- next-env.d.ts` → `rm -rf docs/evidence/next-e2e/failures` → `git diff --check` → **只用显式路径 `git add`** → conventional commit、中文摘要、正文写清红过什么、门禁数字 → 证据落 `docs/evidence/<label>/` → 一个切片一个提交 → PR 描述列切片与门禁。密钥扫描：`grep -rn -E "sk-[A-Za-z0-9]{20,}" --exclude-dir=node_modules --exclude=.env .` 必须为空。

## 证据口径

| 词 | 含义 |
|---|---|
| 已验证（Next E2E） | `next start` 生产构建 + 真实 Chromium（部分再跑 Firefox）+ 独立 worker/runtime + 临时库上通过 |
| 已验证（Node/HTTP） | `node --test` 单测或离线 HTTP 集成 |
| demo | `AI_PROVIDER=demo` 预设修改，不是真实 AI |
| harness 自测 | mock 供应商走真实适配器/worker/浏览器；证明链路，不证明模型 |
| 真实模型 | `RUN_LIVE_AI=1`，少量 smoke，费用记「未知」除非供应商回报 |
| skipped / not_observed / unknown | 没有条件执行 / 该机器没有观察到转移 / 状态表没列的组合——三者都不是通过 |

## Agent skills / tracker / 标签

- 项目级 skill 在 `.claude/skills/`（随 git 走）；tracker 是 GitHub issues，认领 `/implement #<n>`；分诊标签 `ready-for-agent`。
- 领域文档：`CONTEXT.md`（词汇表）、`docs/adr/`（决定记录）。

## 什么时候用哪个 skill

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

本仓技能族：ai-era-skills 2.0.0
