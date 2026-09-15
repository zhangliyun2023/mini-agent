# 改一个行为的固定流程

不管是修 bug、加功能还是改判据，都走这十步。跳步的代价这个仓库都实测付过（见 `docs/TEST_REPORT.md` 各轮「抓到的真缺口」）。

## 0. 先分清是哪一层的活

| 你要改的 | 属于 | 起点 |
|---|---|---|
| 用户可感知的状态/转移（按钮能不能点、什么时候发请求、失败后怎样） | 第一层：软件交互机器 | `contracts/<feature>.machine.mjs` |
| AI 有没有理解需求、改得对不对 | 第二层：模型 + 沙箱 | `server/provider.mjs` SYSTEM_PROMPT、`server/verify.mjs`、`tests/platform/ai_behavior.py` |
| 纯样式、文案、文档 | 不改行为 | 可以不写红测，但要说出来 |

## 0.5 先当一次新用户（碰公开页 / 登录页 / 编辑器入口时必做）

无痕窗口，不带任何账号，只拿一条别人发来的作品链接：玩 → 点「改成我的版本」→ 一路走到自己副本的编辑器。一边走一边数：点了几次、填了几个框、看到了哪句只有开发者才懂的话（「本机」「本地」「演示」「.env」）。对照 `contracts/journey-budget.json`（PRD 2.4）；超预算或看到开发者文案，先记成本轮要修的缺口。走不动的地方就是用户流失的地方——它们不会在机器表里红，只会在这一步被看见。

## 1. 用户一句话

`用户从 X 做到 Y，结果是 Z`。写不出这句话不许动代码。

## 2. 矩阵（分析，不是测试文件）

正例 | 反例 | 必须继续保留的邻近不变量 | 生产装配里有没有同样的输入。圈 P0（本轮）/ P1（记账）。参考标准 §6.1 的七个维度：输入、控件、动作、API、通知、生命周期、布局。

## 3. 改表

在 `contracts/<feature>.machine.mjs` 加/改行：`{id, from, event, guard?, to, kind, reject_code?, effects, invariants, p0, allow, forbid, drive?, fixture?, covered_by?}`。

- 新功能：新建一张表（复制 `contracts/manual.machine.mjs` 的骨架），`initial` 清楚，`terminal` 标对。
- 每个 P0 行的 `covered_by` 写它将被谁证明（`file::text`），文本此刻可以还不存在——它就是你的红测锚点。
- 需要独立意图的行（一次新的提交/发送/应用）标 `effects.intent:true`。
- 不变量 `enforcement: enforced` 必须带 `evidence`，否则写 `planned` + `note`。
- `npm run contracts:sync`，看 `git diff contracts/` 是不是你想要的。

## 4. 答案卷

`contracts/journeys.json` 加/改旅程：期望的转移 id 序列（同一 trace_id）。轮询可能跳状态的写 `alternatives`。

## 5. 红测（先红）

按层选一条，**跑一次看它红在对的原因上**：

| 层 | 写在哪 | 断什么 |
|---|---|---|
| 解释器/契约 | `tests/platform/contracts.test.mjs`（拒绝转移探针在 `probes`） | 真实服务拒绝码、covered_by 文本在盘上 |
| 服务/worker | `tests/platform/core.test.mjs`、`verify_chain.test.mjs`、`trace.test.mjs` | DB 行、DTO、TRACE 行、request_id/trace_id |
| 组件 | `docs/storybook/src/*.stories.js` 的 play() | 请求次数（fake api）、alert 文案、焦点、导航目标、机器记录的转移 |
| 真实装配 | `tests/platform/next_e2e.py` | 可见文案、DOMRect、Cookie、URL、`machine_rows()`、`expect_journey()`、镜像组件 `mirror(page, feature)` 的 `data-state` |

红测里写上 `covered_by` 用的锚点文本（如 `cov('submit-empty')`、`# manual-save-conflict`）。

## 6. 接机器

- 闸：处理器里 `const g=rt.dispatch(EVENT, facts); if(g.status!=='allowed'){toast(...);return;}` 然后 `api(path,{…,trace:g.trace_id})`；API 结果再 `dispatch('API_RESULT',{outcome})`。
- 影子：同样 dispatch，但不因 blocked 拦动作。
- 旅程：`machineRuntime(machine, null, 'app:machine:<feature>:<key>')`，页面加载时 `dispatch('PAGE_VIEW', facts)`。
- 被 disabled 的按钮：在容器上捕获 `pointerdown` 再 dispatch，否则 noop 观察不到。
- 布局事件（RESIZE）在所有状态都合法——别只列一个状态。

## 7. 实现到绿

最小实现。`npm run build` 后再跑 E2E（`public/platform/*`、`contracts/*`、`server/*` 都被打进构建）。

## 8. 对答案

`node scripts/machine-check.mjs --db <sqlite>` 全绿、无 unknown。E2E 末尾的 `no_unknown_transitions` 会自动跑一遍。出现 unknown 的处理是补表，不是删断言。

## 9. 门禁与证据

`AGENTS.md` 的门禁顺序；一轮完整改动用 `bash scripts/verify.sh v0.<n>` 落证据。`docs/TEST_REPORT.md` 加一节：做了什么、门禁数字、**这轮抓到的真缺口**、诚实边界（没验证什么）。

## 10. 提交

显式路径 `git add`；一个切片一个提交；PR 描述列切片与门禁。见 `AGENTS.md` 提交纪律。

## 深 vs 浅：什么时候需要读源码

- **浅（默认）**：只看答案卷 + 镜像组件 + 转移行。任何页面、任何状态都这么验。
- **深（只有一处）**：`public/platform/machine-state.mjs`——它是「UI 说的」与「机器说的」之间唯一的绑定。改它必须跑 Storybook「状态机/镜像组件」story 和一次 E2E。
- 第二处需要深看的是 `contracts/machine.mjs` 解释器本身（`tests/platform/machine.test.mjs`）；其他一切文件都是表的解释。

## 三个反例（都真发生过）

- 写了「已知基线失败」清单给子代理，结果那 4 条是子代理自己引入的，真的基线失败没列——**基线只能自己刚跑过**。
- 测试模式全量上报把 `/api/events` 算进用户写预算，真实 `POST /apply` 被 429——**遥测不能吃用户预算**，答案卷抓的。
- 撤权 toast 原来断「任意红 toast 可见」，收紧成文案后当场发现猜错了分支——**断言不落在承重面上，坏了也绿**。
