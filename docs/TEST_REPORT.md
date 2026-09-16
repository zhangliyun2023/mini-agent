# TEST_REPORT — mini-agent（2026-09-15；v0.2 一节见 §7，v0.3 一节见 §8）

对标 `docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md` §13 与 §17.1：**分层写，不把前一层冒充后一层**。

## 0. 实跑输出

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | `tsc --noEmit`，含 `contracts/` `scripts/` |
| `npm run contracts:check` | 4 份契约 0 漂移 | turn / session / session-runtime / review |
| `npm test` | **27 文件 250 条全绿**（#19 R7 复盘状态表 + R8 CLI 后；R6 后 24 文件 224 条；R1–R5 后 22 文件 205 条） | 不需要 key。**逐文件条数只写在下面这张表里**，`test/unit/docs.test.ts` 用源码静态计数逐文件对账 |
| `npm run test:live` | **5/5**（v0.3，UTC 06:27，18.4s）；afterAll 不变量检查真跑：7 文件 / 9 轮 / 42 条转移，25 allowed + 17 noop，0 unknown，0 违反 | 本机有 key；详见 §3 与 §8 |

### 条数（唯一事实源）

| 文件 | 层 | 条数 |
|---|---|---|
| `test/unit/machine.test.ts` | 纯函数 | 10 |
| `test/unit/contracts.test.ts` | 纯函数 | 12 |
| `test/unit/generator.test.ts` | 纯函数 6 + 假模型 10 | 16 |
| `test/unit/journeys.test.ts` | 纯函数 3 + 假模型 5 | 8 |
| `test/unit/explore.test.ts` | 纯函数 | 7 |
| `test/unit/parser.test.ts` | 纯函数 | 16 |
| `test/unit/tools.test.ts` | 纯函数 | 18 |
| `test/unit/docs.test.ts` | 纯函数 | 8 |
| `test/unit/live-evidence.test.ts` | 只读真实证据 | 3 |
| `test/unit/llm-errors.test.ts` | 纯函数 | 21 |
| `test/unit/llm-retry.test.ts` | 假模型 | 6 |
| `test/unit/judge-py.test.ts` | 子进程真跑（Python 判分器） | 4 |
| `test/unit/native-tools.test.ts` | 假模型 + 本地 HTTP 端点 | 8 |
| `test/unit/unknown-transition-default.test.ts` | 假模型 | 1 |
| `test/unit/agent-loop.test.ts` | 假模型 | 11 |
| `test/unit/session-context.test.ts` | 假模型 | 14 |
| `test/unit/invariants.test.ts` | 假模型（含真落盘） | 12 |
| `test/unit/transcript.test.ts` | 假模型（含真落盘） | 4 |
| 合计 | 27 文件 | 250 |
| `test/unit/review-present.test.ts` | 纯函数 | 8 |
| `test/unit/review-window.test.ts` | 纯函数 | 8 |
| `test/unit/review-collect.test.ts` | 纯函数（夹具 TranscriptReader） | 8 |
| `test/unit/memory-entries.test.ts` | 假模型 + 纯函数 + 真落盘 | 6 |
| `test/unit/review-consolidate.test.ts` | 假模型（FakeLLM）+ 纯函数 | 9 |
| `test/unit/review-run.test.ts` | 夹具整合器 + 假模型 + 真落盘 | 11 |
| `test/unit/review-cli.test.ts` | 子进程真跑 + 假模型 + 真落盘 | 11 |
| `test/unit/review-machine.test.ts` | 夹具整合器 + 残缺表 + 真落盘 | 2 |
| `test/unit/review-invariants.test.ts` | 夹具整合器 + 真落盘 | 8 |

## 1. 第一层：纯函数通过（不碰模型、不碰 runtime）

条数见 §0 表；这里只写覆盖。

| 文件 | 覆盖 |
|---|---|
| `test/unit/machine.test.ts` | 未列组合 unknown；显式 kind:'unknown' 行；同格 guard 顺序取首条、守卫全不命中 unknown；rejected 行 verdict=blocked 带 reject_code、noop 不改状态；定义期校验（终态出边 / 未知守卫 / 无守卫行挡后行 / 非 allowed 改状态 / covered_by 格式 / enforced 无 evidence / rejected 无 reject_code / 行 id 缺失与重复 / planned 无 note）；enumerate 全表；reachable 与不可达点名；toContract 逐字确定（id + signature）|
| `test/unit/contracts.test.ts` | 盘上 4 份 JSON == toContract()（v0.5 起含 review 表）；turn 8 行全 P0 且 covered_by 在盘上；enforced 不变量（v0.3 起 5 条）evidence 在盘上；reachable 无不可达；30 格列 6 格其余 24 格 unlisted；session-runtime 的 busy 行为 declared_unknown 可见 |
| `test/unit/generator.test.ts`（前 6 条） | gaps 为空；maxSteps=2 生成 10 条路径覆盖 3 个终态；生成路径走过的行 == 全表行；生成集合 ⊆ 手写 covered_by；答案卷是行 id 序列；改 reason 不引起答案卷漂移 |
| `test/unit/journeys.test.ts`（前 3 条） | journeys.json 每条 id 存在、从 initial 出发、首尾相接、落终态；validateJourney 点名坏 id / 断链；生成器 10 条路径与 journeys 集合相等 |
| `test/unit/explore.test.ts` | 同 seed 同结果；guard 洞点名 + ddmin 缩到 1 步；ddmin 单测；turn / session / session-runtime / review 四张表 300 走零违反、每行都被碰到 |
| `test/unit/parser.test.ts` | 协议正例、裸文本、多调用、坏 JSON、缺 name、call+final 冲突、`<invoke>` 别名、裸 JSON、`<tool_code>` 外包、`<function=…>` 标签变体（#4）、闭合标签写成开标签、`<final>` 重复开标签 / 无闭合（2026-09-15 CLI 实测第五、六种偏差） |
| `test/unit/tools.test.ts` | 全部走 `registry.invoke`：specs 形状、未注册、缺必填、类型错、未知参数、枚举外、默认截断、自定义 compact、重名、handler 抛错；四个工具的可见行为；mock 搜索中文二元组命中（#3） |
| `test/unit/docs.test.ts` | AGENTS.md 七章节按序、铁律 ≤10；引用的文件与命令存在；测试文件全列出；ARCHITECTURE 机器清单 == contracts/*.machine.ts 且证明文件在盘上；gate.sh 四步顺序；TEST_REPORT 三层分开、§13 八条齐；**§0 条数表 == 源码静态计数，AGENTS / README 不写总数**（v0.3） |
| `test/unit/live-evidence.test.ts` | 只读文件：仓库里已提交的 `evals/live-trace/**/*.jsonl` 都是 #6 之后的形状（带 `feature` 与 `transition` 行 id）；逐轮过 ① ② ③ ⑤ + unknown 点名、每轮落终态、有 noop 无 unknown；篡改一条记录证明检查会红（点名到文件、trace_id、不变量 id） |

## 2. 第二层：假模型通过（FakeLLM 脚本驱动 `agent.run`，断用户可见契约）

条数见 §0 表。

| 文件 | 覆盖 |
|---|---|
| `test/unit/agent-loop.test.ts` | 直接回复、单/多工具、max_steps、坏 JSON 回喂、**坏 JSON 那步是 blocked（reject_code=PARSE_ERROR，trace 数出 1 次，回喂在 onBlocked）**、工具失败回喂、LLM 异常、解析失败到上限、**残缺表验证闸**（unknown → 不执行副作用 + 记 trace + error 终态；测试模式抛出） |
| `test/unit/session-context.test.ts` | 两窗口隔离、纯对话追问、带工具追问、think 剥离、压缩（模型摘要 / 规则兜底，compact 作为副作用挂在轮首转移）、memory 跨会话与跨用户、**remember 的 value 不进 trace（redact）**、**trace 转移序列 == 行 id 答案卷**、**每个 llm / tool effect 有唯一 request_id** |
| `test/unit/generator.test.ts`（后 10 条） | 10 条生成路径逐条真跑，trace 序列 == 答案卷（含 `[noop]` / `[blocked]`），终态 ↔ stoppedBy 对应，无 unknown；**每条路径的证据过五条 P0 不变量**（v0.3） |
| `test/unit/journeys.test.ts`（后 5 条） | checkJourney 三态：passed（带 trace_id）/ failed（closest 实际序列）/ not_observed（空 rows、别的 trace_id、别的 feature）；alternatives 命中；unknownRows 点名残缺表下的 unknown 记录 |
| `test/unit/invariants.test.ts` | 五条 P0 不变量各一红一绿（见 §4；⑤ 另有反向红：删表上声明 → 真实记录不合账）；④ 用 FileSessionStore + FileTraceSink 真落盘并断 checkTurnInvariants 跑的是五条；文件持久化“tmpdir 存 → 新实例读 → 接着聊”，remember 落盘可读，list 只见本用户 |

## 3. 第三层：真实模型少量 smoke（D9：写“少量 smoke”，不写可靠率）

`test/live/live.test.ts` 5 个场景（计算、搜索 + 追问、待办跨轮 + 跨窗口、remember 跨会话、原生 function calling）+ 一条收尾：afterAll 对当次产出的 trace 跑“只凭 trace 就能判”的不变量（v0.3 起）。

历次实跑（qwen3-max，DashScope，2026-09-15 UTC）：

| 批次 | 结果 | trace | 状态 |
|---|---|---|---|
| 05:24 / 05:25（v0.1 审阅时两次） | **3/5，再跑 5/5** | 已删除 | #6 之前的旧格式（无 `feature` / `transition` 行 id，LLM_OK 记 allowed 而非 noop），离线检查过不了（每条都“行 id 在表里不存在”），v0.3 `git rm`；两条失败归因见下 |
| 05:59（v0.2 门禁，commit 955c136） | **5/5** | `evals/live-trace/2026-09-15-05-59*` | 在库；离线过不变量 |
| 06:14（#6 修 #3 #4 后，commit 83d078a） | **5/5** | `evals/live-trace/2026-09-15-06-14*` | 在库；离线过不变量 |
| 2026-09-15-06-27（v0.3 门禁，本次） | **5/5** | `evals/live-trace/2026-09-15-06-27*` | 在库；afterAll 与离线检查都过（`docs/evidence/v0.3/4-live.txt`） |

- **oracle 触到真实证据（v0.3）**：在库的 live 记录由 `test/unit/live-evidence.test.ts` 离线逐轮过 ① ② ③ ⑤ 与 unknown 点名：21 文件 / 27 轮 / 126 条转移，75 allowed + 51 noop，0 blocked，0 unknown，27 轮全落 done。④ 需要返回值与盘上历史，只凭 trace 判不了，不在离线检查内。`test/live/live.test.ts` 的 afterAll 对每次 live 产出跑同一检查。
- 05:24 那次的两条失败，都不是当时改动引入的（main 同时段基线 5/5），已在 #6（`83d078a`）修复：
  - “搜索 + 追问”：模型搜的是“上海今天天气”（无空格），mock search 按整串子串匹配，语料标题是“上海今日天气”→ 没找到 → 模型答“无法获取”。mock 搜索的分词缺陷（issue #3，已修：中文二元组）。
  - “原生 function calling”：模型没走 `tool_calls`，直接输出 `<function=calculator><parameter=expression>99*99</parameter></function>`——第四种标签变体，解析器不认、当成 final。解析器别名缺口（issue #4，已修）。
- 样本仍是少量 smoke（累计 5 批 × 5 场景，其中两批的 trace 因旧格式删除），不写可靠率。

另：CLI 冒烟（手工，v0.1）——把 `OPENAI_BASE_URL` 指到不可达端口跑 `npm run chat`，看到 `deciding --LLM_FAILED--> error` 回显、`助手> 模型调用失败：Connection error.`、trace 文件一条转移记录且 key 字符串不在 trace 与 session JSON 里。

### 换模型 smoke（2026-09-15，DeepSeek `deepseek-flash`，官方端点）

只改 `.env` 三行（`OPENAI_BASE_URL=https://api.deepseek.com`、`MODEL=deepseek-flash`），runtime 与 prompt 一字未动：`npm run test:live` **5/5 + afterAll 证据检查 0 违反**，单次模型调用约 1.0–1.5s（qwen3-max 约 1–3s）。CLI 三句（计算 / 记两条待办 / 标完成）全部按表走，一步两个工具调用正常。转移记录见 `evals/live-trace/` 最新两个目录。仍是少量 smoke，不写可靠率；也没有观察到 qwen3-max 那六种标签偏差是否在 deepseek 上出现——样本太小，不下结论。

## 9. v0.4（#10–#13 并行四票 + #14 收尾）—— 门禁数字与证据

证据目录 `docs/evidence/v0.4/`（`bash scripts/gate.sh v0.4`，2026-09-15 UTC 07:59）。四票由四个 agent 在各自 worktree 并行完成、各开 PR（#15 #16 #17 #18），审阅者逐个 rebase 到 main、解冲突（`agent.ts` / `trace.ts` 三处）、把各票放在 `test/` 子目录里的测试搬回 `test/unit` 并同步条数表后合并。

| 步骤 | 结果 | 口径 |
|---|---|---|
| typecheck | 0 错 | 已验证（进程内） |
| 单测 | **17 文件 171 条全绿**（v0.3 的 125 → +3 记忆上限 +27 重试分类 +4 Python 判分 +8 原生 FC +1 unknown 默认值 +3 解析器补丁） | 已验证（进程内） |
| 契约漂移 | 3 份 0 漂移 | 已验证（进程内） |
| 真实模型 | **5/5 + afterAll 证据检查 0 违反**（DeepSeek `deepseek-flash`；7 文件 / 9 轮 / 39 条转移，23 allowed + 16 noop；原生场景 `mode: native`）；trace 入库 `evals/live-trace/2026-09-15-07-59*` | 少量 smoke，不写可靠率 |
| Python 判分 | `evals/judge.py evals/live-trace`：**42 文件 / 54 轮 / 243 条转移，54 passed，0 failed，0 unknown**，与 TS `checkTraceFiles` 口径一致 | 已验证（进程内） |

四票各自的红测、红输出与偏差在 `docs/evidence/t10/ … t13/REPORT.md`。要点：

- **#10 原生 function calling**：原生模式 system prompt 不再教标签、工具只经 API `tools`；`tool_calls` 以真 assistant / tool 消息（带 `tool_call_id`）进历史并原样回放；llm effect 标 `mode`。这是 #4“模型在原生模式下吐 `<function=…>` 文本”的根源修法——两套协议不再打架。一次 live 不能证明偶发不再出现，只能说冲突已消除。
- **#11 重试分类**：401 / 400 / 404 一次即 error 终态；429 / 5xx / 超时 / 网络错指数退避（sleep 可注入，测试不真等）；逐次尝试 `tries[{n, errorClass, waitMs}]` 进 trace。`unknownTransition` 默认 `error`，全仓无 `VITEST`。
- **#12 记忆上限**：记忆块 ≤ 1200 字符（历史预算的 10%），从最新往回装、截最老，`memory_truncated` 挂在轮首转移；历史预算与记忆预算分开，一条变异锁定。
- **#13 Python 判分器**：与 TS oracle 对同一批证据结论一致；篡改一条记录两侧同样点名。④ 三处对齐凭 trace 判不了，两侧都不含。

not_run：无。skipped：无。未做：混合历史（先文本后原生）无测试；CLI `--native-tools` 未手工冒烟；四票均无变异测试（B3 那次仍是唯一一次）。

## 10. v0.5（#19 每日复盘 = 记忆整合，R1–R9）—— 门禁数字与证据

证据目录 `docs/evidence/v0.5/`（`bash scripts/gate.sh v0.5`，2026-09-15）。九片四波并行，每片 PR（#20–#27）各带 `docs/evidence/t19-r<n>/REPORT.md`。

| 步骤 | 结果 | 口径 |
|---|---|---|
| typecheck | 0 错 | 已验证（进程内） |
| 单测 | **27 文件 250 条全绿**（v0.4 的 171 → +79） | 已验证（进程内） |
| 契约漂移 | **4 份** 0 漂移（turn / session / session-runtime / review） | 已验证（进程内） |
| 真实模型（turn） | 5/5 + afterAll 0 违反（7 文件 / 9 轮 / 42 条转移） | 少量 smoke |
| 真实模型（复盘） | R4 一次：3 stated + 1 due_today、无 warning；R8 一次：两轮 chat → 次日 review `ok`，entries 3，1 条 due_today，重跑 attempts=2 不调模型（`docs/evidence/t19-r8/live-smoke.txt`） | 少量 smoke，不写可靠率 |
| Python 判分 | 49 文件 / 63 轮 / 285 条转移，63 passed，0 failed，0 unknown（只看 turn） | 已验证（进程内） |

复盘线四条 P0 不变量（`test/unit/review-invariants.test.ts`）各一红一绿：幂等、冲突不覆盖、每条亮点有来源、不复述原话。变异：R2 两条、R4 一条、R5 一条、R6 一条、R8 一条——各红一次已还原。review 表随机探索 300 走 2491 步零违反。

not_run：无。skipped：无。未做：见 `docs/NEXT_STEPS.md`“复盘线”。

## 4. 五条 P0 不变量（D3 四条 + ⑤ 副作用对账）

| # | 不变量 | oracle | 绿 | 红 |
|---|---|---|---|---|
| ① | 无工具执行于解析失败之后 | `noToolAfterParseError` | 坏 JSON → 正确调用 → final：tool 副作用只在 executing_tools + TOOLS_DONE，前一条是 allowed 的 PARSED_TOOL_CALLS | 把 tool 副作用挪到 PARSED_ERROR 转移上 → 点名 |
| ② | 一轮恰一个最终答案 | `exactlyOneFinalAnswer` | 恰 1 条终态转移在末尾、恰 1 个 answer 副作用、历史恰 1 条 `<final>` | 复制终态转移 / 历史多塞一条 `<final>` → 点名 |
| ③ | 三终态互斥可区分 | `terminalStatesDistinct` | final / max_steps / error 三轮，终态 ↔ stoppedBy 一一对应 | 终态 done 却报 stoppedBy=error → 点名 |
| ④ | 答案 == 盘上历史末条 == trace 末次决策 | `answerAligned` | 文件存储真落盘：返回值、`data/sessions/A/w1.json` 末条、`trace/w1.jsonl` 末条 answer 三处一致 | 改盘上 JSON 末条 / 改 JSONL 末条 answer → 各自点名 |
| ⑤ | 副作用对账：每条记录的 `effects[].kind` ⊆ 记录 `transition` 行 id 命中行声明的 `effects`；compact 只在轮首第一条转移 | `effectsDeclared` | 轮首压缩 + 坏 JSON + 工具 + final 的一轮逐条对账通过，compact / llm / parse / tool / answer 五种都出现；对 noop（t-llm-ok）/ blocked（t-parse-error）记录同样成立；生成器 10 条路径与在库 live 转移也过 | 把 tool 挪到 t-llm-ok 上 / compact 挪到非轮首 / 幽灵行 id → 各自点名；**反向**：记录不动、删表里 TOOLS_DONE 行的声明 → 真实记录立刻不合账 |

oracle 实现在 `src/machine/invariants.ts`，只看 trace 记录、返回值、盘上历史，不碰 runtime 内部。只凭 trace 能判的 ① ② ③ ⑤ + unknown 点名打包为 `checkTraceOnlyInvariants`，由 `src/machine/evidence.ts` 接到 JSONL 文件上。

## 5. 对标标准 §13 八条

| # | §13 条目 | 状态 | 证据 |
|---|---|---|---|
| 1 | 所有定义的可达状态和转移都有覆盖记录 | **满足**（turn 表） | `reachable` 无不可达状态/行；8 行全部 covered_by 指向盘上手写测试；生成路径走过的行 == 全表行（`contracts.test.ts`、`generator.test.ts`）；行声明的 effects 与 trace 实际 effects 双向对账（⑤） |
| 2 | 至少一个意外状态能被 oracle 自动判定，而非人工发现 | **满足** | 残缺表下 unknown 转移被闸拦下并记 `status:'unknown'`（`agent-loop.test.ts::表里没列的转移在运行时被拦下`）；五条不变量的红例均由 oracle 点名；表未声明的副作用被 ⑤ 判为 unmodeled；oracle 已跑在在库的真实模型转移上（`live-evidence.test.ts`，条数见 §3） |
| 3 | 全链路同一 traceId 串联 | **满足**（本项目的链路 = 模型 / 工具 / 压缩 / 会话落盘） | 每条转移记录带 `trace_id = 用户/会话/轮次`；④ 从盘上 JSON 与 JSONL 两处读回对齐；离线检查按 `trace_id` 分轮 |
| 4 | 失败场景能自动缩减并重新回放 | **模型层满足，运行层部分** | 模型层：`explore.ts` ddmin 缩到最短事件序列，`replay(m, steps)` 回放；运行层：每条生成路径的 id 就是事件序列，`scriptFor()` 一步还原成 FakeLLM 脚本；FakeLLM 脚本级缩减未做（NEXT_STEPS 6） |
| 5 | 主题和菜单布局有结构化断言 | **不适用** | 无 UI（D7） |
| 6 | 工作空间重命名、刷新、重启、定时任务恢复有正例、反例、邻近 invariant | **部分**（按对应物） | 重启对应物：新实例读盘接着聊（正例）、别的用户 `list` 为空 / 看不到 memory（反例）、压缩失败退回规则（邻近）；重命名与定时任务无对应物 |
| 7 | 报告区分已验证、失败、未覆盖、跳过、外部依赖不可用 | **满足** | 本报告 §0–§3：已验证（进程内）条数只在 §0 表，由 `docs.test.ts` 对账；真实模型少量 smoke 逐批列出、失败已归因并修；not_run / skipped 在 §8 分开写；未覆盖见 §6 |
| 8 | 敏感数据不进测试产物或 trace | **部分** | ④ 里一条弱断言（trace 文件不含 `apiKey|OPENAI`）+ CLI 冒烟手工确认 key 字符串不在 trace / session；工具 args 走 `redact`；表里 `api_key_never_in_trace` 仍标 planned，因为还没有“把真 key 放进配置再 grep 产物”的自动测试 |

## 6. 未覆盖 / 诚实边界

- ② session 表与 ③ session-runtime 表只建表 + 契约，**没有接代码**；`compacting + INPUT`、`busy + INPUT/ASYNC_DONE` 标 unknown。
- LLM 重试在 `callLLM` 内部，trace 上只见 `attempts` 数，不是逐次转移。
- 真实模型只有少量 smoke（§3 逐批列出），不写可靠率。
- 不变量 oracle 目前跑在三处：单测、生成器路径、live 证据（离线 + live 收尾）；**CLI 运行时不跑**，用户交互产生的 `trace/*.jsonl` 需要手动用 `src/machine/evidence.ts` 过一遍。④ 只在单测里跑（需要返回值与盘上历史）。
- 既有测试中有 3 处 trace 断言因 D4（打点单位改为转移）而改写：两处 compact 改为看副作用，一处 trace 序列改为对答案卷；其余 33 条断言未动。

## 7. v0.2（issue #5：对齐 skill）—— 本轮门禁数字与证据

证据目录 `docs/evidence/v0.2/`（`bash scripts/gate.sh v0.2`，2026-09-15 UTC 05:59，commit 955c136）。每个文件首行环境、末行 `exit N (expected M)`。

| 步骤 | 文件 | 结果 | 口径 |
|---|---|---|---|
| typecheck | `1-typecheck.txt` | `tsc --noEmit` exit 0 | 已验证（进程内） |
| 单测 | `2-unit.txt` | **11 文件 113 条全绿**（机器 10 · 契约 9 · 工具 16 · 旅程 8 · 会话/上下文 11 · 循环 11 · 生成器 16 · 不变量 9 · 探索 6 · 解析 10 · 文档 7） | 已验证（进程内） |
| 契约漂移 | `3-contracts.txt` | 3 份契约 0 漂移 | 已验证（进程内） |
| 真实模型 | `4-live.txt` | **5/5**（qwen3-max，DashScope，18.4s）；trace 在 `evals/live-trace/2026-09-15-05-59*`：42 条转移，25 allowed + 17 noop，0 blocked，0 unknown；26 个 llm/tool effect 各带唯一 `request_id`；remember 的 args 只见 `value_len`；无 key 字符串 | 真实模型少量 smoke（1 × 5，不写可靠率）。issue #3（mock 搜索分词）/ #4（`<function=…>` 标签变体）本次没触发，**没修**，仍是已知问题 |
| 变异 | `5-mutation-B3.txt` | 见下 | 一次性验证，已还原 |

not_run：无。skipped：无（本机有 key，live 真跑了一次）。

### 切片逐条：红过什么

| 片 | 红测（测试名） | 红的输出（摘） |
|---|---|---|
| A1 行 id | machine.test“A1：行 id 必填且定义期查重”；generator.test“答案卷是行 id 序列”；agent-loop / session-context 序列断言 | `expected [Function] to throw an error`；`expected [ 'deciding --LLM_FAILED--> error' ] to deeply equal [ 't-llm-failed' ]` |
| A2 request_id | session-context.test“A2：每次模型调用、每次工具调用各有一个 request_id” | `.toMatch() expects to receive a string, but got undefined` |
| A3 blocked | machine.test“rejected 行的 verdict 是 blocked”；agent-loop.test“A3：坏 JSON 那一步是 blocked” | `expected { status: 'rejected', … } to match object { status: 'blocked', … }`；`expected [ 't-llm-ok', 't-parse-error', …(2) ] to deeply equal [ 't-llm-ok [noop]', …(3) ]` |
| A4 planned note | machine.test“A4：planned 不变量必须带 note” | `expected [Function] to throw an error` |
| A5 redact | session-context.test“A5：remember 的 value 不进 trace” | `expected '{"key":"city","value":"上海徐汇区"}' not to contain '上海徐汇区'` |
| B1 答案卷 | journeys.test 整文件 8 条 | `Cannot find module '../../src/machine/check.js'` |
| B2 探索 | explore.test 整文件 6 条 | `Cannot find module '../../src/machine/explore.js'` |
| C1 文档 | docs.test 4 条 | `expected [ '一句话', '命令', … ] to deeply equal [ '产品是什么', '铁律', … ]`；`ENOENT … docs/ARCHITECTURE.md` |

### A3 之后的 blocked 计数

- 单测：坏 JSON 场景 trace 里恰 1 条 `status:"blocked"`（`transition: t-parse-error`, `reject_code: PARSE_ERROR`），回喂消息由 `onBlocked` 发出，第二次模型调用末条是 parser 的 tool 消息。连续坏 JSON 到上限：`t-llm-ok [noop] > t-parse-error [blocked] > t-llm-ok [noop] > t-parse-error-cap`。
- live（1 × 5）：0 blocked——模型本次没有输出过坏 JSON。

### B2 随机探索：有没有红出 guard 洞

没有。三张表 seed=20260914、300 走 × ≤40 步（turn 表 1531 步）：0 违反，每一行都被碰到。原因：turn 表两个守卫格（`deciding + PARSED_ERROR`、`executing_tools + TOOLS_DONE`）都有无守卫兜底行，另两张表没有 guard。探索器抓得住真洞的证据（探针，未入库）：抠掉 `t-parse-error-cap` 兜底行后 300 走红 50 次，ddmin 缩到 1 步 `[{"event":"PARSED_ERROR","guards":{"hasStepsLeft":false}}]`。

### B3 变异（一次性，已还原）：`docs/evidence/v0.2/5-mutation-B3.txt`

把 `contracts/session-runtime.machine.ts` 行 `sr-input-while-busy` 的 `kind:'unknown'` 谎报成 `'allowed'`：

```
contracts:check  ✗ contracts/session-runtime.contract.json 与表不一致  exit 1
contracts.test   × 盘上 'contracts/session-runtime.contract.js…' == toContract()
                 × session-runtime：busy 时的 INPUT / ASYNC_DONE 在契约里标为 declared_unknown
                 → expected [ 'busy --ASYNC_DONE--> busy', …(1) ] to deeply equal ArrayContaining{…}
npm test         2 failed | 108 passed
```

红在契约层；**探索层没红**（allowed 自环不违反四条通用不变量）——探索器的已知边界，见 NEXT_STEPS 8。

### 既有断言改动清单（只在 issue 明说处）

- A1：三处 trace 序列断言改行 id；contracts.test 按 id 找行改 `sr-input-while-busy`；machine.test 的 toContract 断言 `id` 改显式 id + `signature`；generator.test 的 rowsUsed 对比改 `r.id`。
- A3：坏 JSON 序列出现 `[blocked]`、`LLM_OK` 出现 `[noop]`；两处“全部 status=allowed”改为“allowed 或 noop”/“无 unknown”（LLM_OK 改 noop 的直接后果）；machine.test 的 rejected 断言 `status` 改 `blocked`。
- 其余既有断言未动。

### 对标 §13 的变化

- 第 4 条（失败场景自动缩减并回放）：**部分 → 模型层满足**——`explore.ts` 的 ddmin 把违反缩到最短事件序列，回放即 `replay(m, steps)`；运行层（FakeLLM 脚本缩减）仍未做。
- 第 8 条（敏感数据不进 trace）：**部分 → 部分（更强）**——工具 args 走 `redact`，remember 的 value 只留长度（单测 + live trace 两处确认）；`api_key_never_in_trace` 仍 planned（note 写明缺自动测试）。

## 8. v0.3（issue #8：移植 epic 分支三提交）—— 第 ⑤ 条不变量、trace 证据离线 oracle、条数单一事实源

来源：`claude/epic-cerf-44n1c4` 上的 `2058831` / `d1dc4ea` / `986b1d5`，与 #6 冲突不能 cherry-pick，按其 diff 在 main（`83d078a`）的形状上重做：对账按记录上的 `transition` 行 id 找行（不按 from/event/to）；“全 allowed”一律改“无 unknown”（LLM_OK 是 noop、解析失败是 blocked）；对 noop / blocked 记录同样对账。

证据目录 `docs/evidence/v0.3/`（`bash scripts/gate.sh v0.3`，2026-09-15 UTC 06:27，评价对象 = commit 34dcf14 + 本片（docs）未提交的改动）。每个文件首行环境、末行 `exit N (expected M)`。

| 步骤 | 文件 | 结果 | 口径 |
|---|---|---|---|
| typecheck | `1-typecheck.txt` | `tsc --noEmit` exit 0 | 已验证（进程内） |
| 单测 | `2-unit.txt` | **12 文件 125 条全绿**（与 §0 表一致） | 已验证（进程内） |
| 契约漂移 | `3-contracts.txt` | 3 份契约 0 漂移 | 已验证（进程内） |
| 真实模型 | `4-live.txt` | **5/5**（qwen3-max，DashScope，18.4s）；afterAll 真跑，stderr 一行 `live trace 不变量：7 个文件，9 轮，42 条转移，status 分布 {"noop":17,"allowed":25}`，0 违反；trace 在 `evals/live-trace/2026-09-15-06-27*`（入库） | 真实模型少量 smoke（1 × 5，不写可靠率） |

not_run：无。skipped：无（本机有 key，live 真跑了一次；vitest 报 6 passed = 5 场景 + afterAll 所在 describe 的 1 条“trace 文件存在”）。

### 三片逐条：红过什么（先写测试跑一次，贴那次失败；不另做回退验红）

| 片 | 提交 | 红测（测试名） | 红的输出（摘） |
|---|---|---|---|
| ⑤ effectsDeclared | `feat(invariants)` | invariants.test“⑤ 副作用对账”三条；invariants.test ④ 绿（断 checkTurnInvariants 跑五条）；generator.test 10 条路径 | `TypeError: (0 , effectsDeclared) is not a function`；`expected [ 'no_tool_after_parse_error', …(3) ] to deeply equal [ …(4) ]`；`expected [ 'no_tool_after_parse_error', …(3) ] to include 'effects_declared'` |
| trace 证据离线 oracle | `feat(evidence)` | live-evidence.test 整文件；实现后、删旧格式前“每一轮都过 ① ② ③ ⑤” | `Error: Cannot find module '../../src/machine/evidence.js'`；`28 个文件，35 轮，163 条转移 … ✗ evals/live-trace/2026-09-15-05-24/calc.jsonl live/calc/1 [effects_declared] #1 行 id "undefined" 在表里不存在（deciding --LLM_OK--> deciding [allowed]）`（05-24 / 05-25 共 14 文件同样点名 → 旧格式，`git rm`） |
| 条数单一事实源 | `docs` | docs.test“条数单一事实源” | `contracts.test.ts 的 it.each 行缺 \`// ×N\` 展开标记`；加标记后 `expected {} to deeply equal { 'agent-loop.test.ts': 11, …(11) }`（报告里没有那张表） |

### 第 ⑤ 条不变量落在哪

- 表：`contracts/turn.machine.ts` 加 `effects_declared`（P0，enforced，evidence 指向 `invariants.ts::effectsDeclared` 与测试）；表头注释写清每种副作用挂在哪类行上，`compact` 只挂轮首第一条转移（t-llm-ok / t-llm-failed 声明了它）。契约 JSON 重生成，`contracts:check` 0 漂移。
- oracle：`effectsDeclared(records, machine)`——行 id 不存在点名、未声明种类点名、compact 不在 seq 1 点名；`checkTurnInvariants` 跑五条。
- 谁在跑：invariants.test（一绿一红一反向红）、generator.test 10 条路径、live-evidence.test 在库 live 转移、live.test afterAll 当次产出。

### 离线证据检查

- 检查器：`src/machine/evidence.ts`（读 JSONL → 按 `trace_id` 分轮 → `checkTraceOnlyInvariants` ① ② ③ ⑤ + unknown 点名 → 摘要）。
- 在库 live 记录：21 文件 / 27 轮 / 126 条转移，75 allowed + 51 noop，0 blocked，0 unknown，27 轮全落 done；全部落 `done`。
- 删除：`evals/live-trace/2026-09-15-05-24*`、`05-25*`（#6 之前的旧格式，见 §3 表）。
- afterAll：本次 live 收尾对 `evals/live-trace/2026-09-15-06-27*` 跑同一检查：真跑了，`live trace 不变量：7 个文件，9 轮，42 条转移，status 分布 {"noop":17,"allowed":25}`，0 违反。

### 条数单一事实源

- 条数只写在 §0“条数（唯一事实源）”那张表；`docs.test.ts` 用源码静态计数对账：`it(` 记 1，`it.each(` 行必须带 `// ×N`（contracts ×3、generator ×10、explore ×3），逐文件相等、合计行与 `npm test` 行的文件数 / 总数相等，每个文件只许出现一次。
- AGENTS.md / README 不写总数（测试断 `\d+ 条(单测|全绿)|\d+ 文件 \d+ 条` 不出现）；AI-LOG §3、SPEC-state-machines §9 里过期的“live 未跑 / 旧格式”改为引用本报告 §3。

### 既有断言改动清单（只在 issue 明说处）

- invariants.test ④ 绿：`checkTurnInvariants` 的“全过”断言前加一行断 id 列表是五条（新增断言，不改原断言）。
- generator.test 10 条路径：新增“过五条不变量”断言；既有“无 unknown”断言不动。
- contracts.test / generator.test / explore.test 的 `it.each` 行加 `// ×N` 注释（不是断言）。
- live-evidence.test 是新文件，按 issue 写“无 unknown”而非“全 allowed”，并断“有 noop”。
- 其余既有断言未动。
