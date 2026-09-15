# AGENTS.md — mini-agent 唯一入口

给人和 Agent 看的第一页。改代码前先读；这页引用的文件与命令由 `test/unit/docs.test.ts` 守着，写错就红。

## 产品是什么

从零写的最小 Agent Runtime（TypeScript，无框架，无 UI）：loop / 工具注册 / 输出解析 / session / context 压缩 / trace。**轮循环由状态表驱动**：`contracts/turn.machine.ts` 就是 loop 的控制流，runtime 每一步先查表，`allowed` 才执行副作用，`rejected` 行命中即 `blocked`（只回喂、状态不变），表里没列的组合被拦下并留下记录。架构与机器清单见 `docs/ARCHITECTURE.md`，决定与词汇见 `docs/product/SPEC-state-machines.md`，产品规格见 `docs/SPEC.md`。

## 铁律

1. **改行为先改表**：用户可见行为变化先改 `contracts/*.machine.ts`，`npm run contracts:gen` 重生成契约 JSON，再动代码。契约 JSON 是生成物，不手改。
2. **先红后绿**：每个切片先写红的测试、跑一次、记下失败输出，再最小实现到绿。红没红过不算。
3. **断言只打用户可见契约**：返回值、trace 记录内容、盘上文件、模型实际收到的 messages。不断类名、不断中间函数。
4. **不绕闸**：`src/runtime/agent.ts` 里不许绕过 `transition()` 改状态或执行工具；`apply` 只在 `allowed` 跑，回喂只在 `onBlocked` 跑。
5. **unknown 就是「还没决定」**：不为了绿把 unknown 改成 allowed；测试模式下 unknown = 失败；trace 里 `status:"unknown"` 永远单独列出。
6. **每行有身份**：表里每行带显式 `id`（`t-llm-ok` 风格）；答案卷、trace、旅程都用行 id，改 `reason` 不引起答案卷漂移。
7. **rejected 必带 `reject_code`，planned 不变量必带 `note`，enforced 不变量必带 `evidence`**——定义期校验，缺了表都建不起来。
8. **白名单落盘**：API key 不进 trace；工具 args 走 `redact`；唯一显式例外是终态转移上的 `answer` 全文（不变量 ④ 需要）。
9. **不让 LLM 写用例**：用例来自表 + runner 协议 + 手写 + 随机探索；真实模型只做少量 smoke，不写可靠率。
10. **报告口径五个词不混**：已验证（进程内）/ 真实模型少量 smoke / not_run / skipped / 失败；SKIPPED ≠ 通过。

## 门禁

| 命令 | 作用 |
|---|---|
| `npm run typecheck` | `tsc --noEmit`，含 `contracts/` `scripts/` |
| `npm test` | 全部单测（不需要 key，vitest） |
| `npm run contracts:check` | 盘上 `contracts/*.contract.json` 与表是否漂移，漂了退出码 1 |
| `npm run contracts:gen` | 改了表之后重新生成契约 JSON（然后看 diff） |
| `npm run check` | typecheck + contracts:check + test，提交前跑这个 |
| `npm run test:live` | 真实模型 5 个 smoke 场景，需要 `.env` 里有 key；trace 写到 `evals/live-trace/` |
| `bash scripts/gate.sh <label>` | 一键门禁：typecheck → test → contracts:check → live，每步输出落 `docs/evidence/<label>/`，首行环境、末行 `exit N (expected M)`；无 key 时 live 写 SKIP（skipped ≠ 通过） |
| `npm run chat -- --user A --session w1` | CLI；加 `--native-tools` 切原生 function calling，`--quiet` 关 trace 回显 |

## 地图

文档：

| 文件 | 内容 |
|---|---|
| `docs/ARCHITECTURE.md` | 运行单元、机器清单（表 · 接法 · 谁证明）、kind/verdict、答案卷、打点、目录 |
| `docs/SPEC.md` | 产品规格：词汇、用户故事 1–44、实现决策、测试决策 |
| `docs/product/SPEC-state-machines.md` | 状态机线的 11 条决定（D1–D11）、表形状、打点白名单、切片 S0–S6 |
| `docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md` | 依据的参照标准 |
| `docs/TEST_REPORT.md` | 测试报告：三层分开；对标标准 §13 八条逐条给证据；门禁数字与 `docs/evidence/` 一致；**单测条数的唯一事实源（§0 表）** |
| `docs/NEXT_STEPS.md` | 没做与下一步 |
| `AI-LOG.md` | AI 协作记录：提示、真实模型暴露的偏差、处置 |
| `README.md` | 运行方式 + 指路 |

代码：

```
contracts/
  turn.machine.ts              ① 轮循环表（闸）+ runner 协议（哪个状态发哪些事件、facts 怎么推进）
  session.machine.ts           ② 会话生命周期表（影子）
  session-runtime.machine.ts   ③ 会话并发表（影子；busy 行为标 unknown）
  journeys.json                答案卷：旅程名 → 行 id 序列
  *.contract.json              由表生成的契约；npm run contracts:gen 重生成
src/machine/
  interpreter.ts               通用解释器：defineMachine / interpret / enumerate / reachable / toContract
  generator.ts                 从表 + runner 协议 BFS 出路径清单（答案卷）
  check.ts                     对答案：checkJourney 三态 + unknownRows + validateJourney
  explore.ts                   随机探索：种子游走 + 通用不变量 + ddmin
  invariants.ts                五条 P0 不变量的独立 oracle（含 ⑤ 副作用对账）+ checkTraceOnlyInvariants（只凭 trace 判 ① ② ③ ⑤ + unknown）
  evidence.ts                  读 JSONL 按 trace_id 分轮过不变量：离线过 evals/live-trace/，live 收尾 afterAll 也过
src/runtime/
  agent.ts                     表驱动的 turn runner（闸）：transition() 先 interpret，allowed → apply，blocked → onBlocked
  trace.ts                     打点单位 = 一次转移 {trace_id, feature, transition, status, reject_code, effects[request_id]}
src/protocol/                  system prompt 构建 + 模型输出解析（永不抛）
src/tools/                     注册表（校验 → 执行 → 精简 → redact 进 trace）+ calculator / search / todo / remember
src/session/                   会话存储（内存 / 文件）+ context 组装与压缩
src/memory/                    用户级长期记忆（内存 / 文件）
src/review/                    复盘（#19）：types.ts 共享类型；transcript.ts 逐轮转写（Raw 层，内存 / 文件 data/transcripts，轮末追加、不压缩）
src/review/                    复盘（#19）：types.ts 共享类型；present.ts 呈现门槛（why_today + source 必备、不复述原话、空则 brief null）
src/review/                    复盘（#19）：types.ts 共享类型 + TranscriptReader 最小读接口；window.ts 计划日期 + 时区 → 昨日 [start, end)（只用 Intl）；collect.ts 按区间取转写行、三态 coverage（full / partial / none，读不出 ≠ 没聊）
src/llm/                       LLMClient 接口 + OpenAI-compatible 实现 + FakeLLM
scripts/contracts.ts           contracts:gen / contracts:check 的实现
scripts/gate.sh                一键门禁，证据落 docs/evidence/<label>/
```

测试（`npm test`；逐文件条数只写在 `docs/TEST_REPORT.md` §0 那张表里，`test/unit/docs.test.ts` 用源码 `it(` 静态计数对账，这里不写数字）：

| 文件 | 层 | 内容 |
|---|---|---|
| `test/unit/machine.test.ts` | 纯函数 | 解释器：unknown、guard 顺序、定义期校验（行 id、reject_code、planned note…）、enumerate、reachable、toContract 确定性 |
| `test/unit/contracts.test.ts` | 纯函数 | 三份契约 0 漂移；P0 行 covered_by 与 enforced 不变量 evidence 在盘上；reachable 无不可达 |
| `test/unit/journeys.test.ts` | 纯函数 + 假模型 | journeys.json 与表拴在一起；生成器路径与旅程集合相等；checkJourney 三态；unknownRows |
| `test/unit/explore.test.ts` | 纯函数 | 随机探索：可复现、guard 洞点名 + ddmin、三张表零违反 |
| `test/unit/generator.test.ts` | 纯函数 + 假模型 | 生成 10 条路径、gaps 为空、生成集合 ⊆ 手写覆盖；答案卷是行 id 序列；每条路径 FakeLLM 真跑，trace 序列 == 答案卷 |
| `test/unit/invariants.test.ts` | 假模型（含真落盘） | 五条 P0 不变量各一红一绿（⑤ 另有反向红：删表上声明 → 真实记录不合账）；④ 用 FileSessionStore + FileTraceSink；文件持久化接着聊 |
| `test/unit/transcript.test.ts` | 假模型（含真落盘） | #19 R1 转写：两轮后盘上 JSONL 每行 ISO ts 单调不减、role/content == 历史、turn/traceId 对上；FileTranscriptStore 读回保序、list 只见本用户；默认内存版；think 已剥 |
| `test/unit/live-evidence.test.ts` | 只读真实证据 | 仓库里已提交的 `evals/live-trace/**/*.jsonl` 逐轮过 ① ② ③ ⑤ + unknown 点名；篡改一条记录证明检查会红 |
| `test/unit/llm-errors.test.ts` | 纯函数 | `classifyLlmError` 按 status / code / name / message 分八类，三类不重试 |
| `test/unit/llm-retry.test.ts` | 假模型 | 401 一次即 error；429 / 5xx / 超时 / 网络错指数退避重试，逐次尝试进 trace；不传 unknownTransition 不抛出 |
| `test/unit/judge-py.test.ts` | 子进程真跑 | `python3 evals/judge.py` 对已提交 live trace 全 passed 且与 TS 侧数字一致；篡改一条记录退出码 1 并点名；空目录 not_observed 退出码 2；契约声明是判据来源 |
| `test/unit/native-tools.test.ts` | 假模型 + 本地 HTTP 端点 | 原生模式 system prompt 不教标签；assistant.tool_calls 与 role=tool/tool_call_id 配对进本轮与历史并原样回放；llm effect 标 mode；压缩转写含 toolCalls |
| `test/unit/unknown-transition-default.test.ts` | 假模型 | 不传 unknownTransition 时未列转移以 error 终态结束、不抛出（运行时默认，不读测试环境变量） |
| `test/unit/agent-loop.test.ts` | 假模型 | 循环行为、blocked 回喂、残缺表验证闸拦得住（error 终态 / 测试模式抛出） |
| `test/unit/session-context.test.ts` | 假模型 | 窗口隔离、追问、think 剥离、压缩、memory、trace 序列 / request_id / redact |
| `test/unit/parser.test.ts` | 纯函数 | 协议解析与真实模型偏差 |
| `test/unit/docs.test.ts` | 纯函数 | 守文档：七章节、地图文件与命令存在、机器清单 == 表、gate.sh 四步顺序、TEST_REPORT §0 条数表 == 源码静态计数 |
| `test/unit/tools.test.ts` | 纯函数 | 注册表全部走 `registry.invoke`：未注册 / 缺必填 / 类型错 / 未知参数 / 枚举外 / 截断 / handler 抛错 |
| `test/unit/review-present.test.ts` | 纯函数 | #19 ⑤ 呈现门槛：due_today → 一条带「今天到期：」；三种前缀与顺序；闲聊 → brief null；缺 why_today / 表外值 / 缺 source → dropped + reason；逐字重合或 ≥ 20 字子串 → 过滤 + warning，其余保留 |
| `test/unit/review-window.test.ts` | 纯函数 | `yesterdayWindow`：UTC 与 Asia/Shanghai 同 date 区间差 8 小时；00:30 归今天；跨月 / 跨年；夏令时切换日 23 小时；坏日期 / 坏时区抛 |
| `test/unit/review-collect.test.ts` | 纯函数（夹具 TranscriptReader） | `collectYesterday`：只收 [start, end) 内的行并按会话分组；read 返回 null 或行无可解析 ts → unreadable + partial（不冒充 none）；全无 → none；只取本用户 |
| `test/live/live.test.ts` | 真实模型 smoke | 5 场景，无 key 自动跳过；afterAll 对当次产出的 trace 跑同一份不变量检查 |

## 禁止事项

- 不要在 `src/runtime/agent.ts` 里绕过 `transition()` 直接改状态或执行工具。
- 不要为了绿而把 unknown 组合改成 allowed；不要手改 `contracts/*.contract.json`。
- 不要让 LLM 生成用例；不要把「假模型单测绿」写成「真实模型已验证」。
- 不要把 `data/`、`trace/`、`.env` 提交进仓库；`docs/evidence/` 与 `evals/live-trace/` 是证据，要入库。
- 不要改既有测试的断言来迁就新结构；外层行为测试红 = 功能没做到。

## 提交纪律

- 一个切片一个提交；中文 conventional commit（`feat(machine): …` / `test(evidence): …` / `docs: …`）。
- 正文写**红过什么**（测试名 + 那几行断言输出）与**门禁数字**（typecheck / contracts:check / npm test 条数）。
- `git add` 只用显式路径；改表的提交必须同时带重生成的契约 JSON。
- 改表流程：改 `contracts/*.machine.ts`（新行带 `id` / `priority` / `covered_by`）→ 先写红测试（测试名放进 `covered_by`）→ 补实现 → `npm run contracts:gen` 看 diff → `npm run check` 全绿。

## 证据口径

- **已验证（进程内）**：`npm test` 绿的条数，只写在 `docs/TEST_REPORT.md` §0 表（docs.test 对账），证据在 `docs/evidence/<label>/2-unit.txt`。
- **真实模型少量 smoke**：`npm run test:live` 的 n/5，写具体数字与失败归因，不写可靠率；trace 在 `evals/live-trace/`。
- **not_run**：没条件跑（如无 key）；**skipped**：跑了但主动跳过（`describe.skipIf`）。两者都不是通过，报告里分开写。
- **变异**：对最承重的不变量做一次性变异（改一行 → 跑 → 记录红 → 还原），红的输出入 `docs/evidence/`；没红过的不算证据。
- **基线失败**只能来自自己刚跑过的对照，不转述。
