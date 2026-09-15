# TEST_REPORT — mini-agent（2026-09-15；v0.2 一节见 §7）

对标 `docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md` §13 与 §17.1：**分层写，不把前一层冒充后一层**。

## 0. 实跑输出

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | `tsc --noEmit`，含 `contracts/` `scripts/` |
| `npm run contracts:check` | 3 份契约 0 漂移 | turn / session / session-runtime |
| `npm test` | 9 文件 89 条全绿（v0.1）→ **11 文件 113 条全绿（v0.2，见 §7）** | 不需要 key |
| `npm run test:live` | 两次运行：**3/5，再跑 5/5** | 审阅者本机有 key；两条失败是模型抖动暴露的旧问题，见 §3 |

## 1. 第一层：纯函数通过（不碰模型、不碰 runtime）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/unit/machine.test.ts` | 10 | 未列组合 unknown；显式 kind:'unknown' 行；同格 guard 顺序取首条、守卫全不命中 unknown；rejected 行 verdict=blocked 带 reject_code、noop 不改状态；定义期校验（终态出边 / 未知守卫 / 无守卫行挡后行 / 非 allowed 改状态 / covered_by 格式 / enforced 无 evidence / rejected 无 reject_code / 行 id 缺失与重复 / planned 无 note）；enumerate 全表；reachable 与不可达点名；toContract 逐字确定（id + signature）|
| `test/unit/contracts.test.ts` | 9 | 盘上 3 份 JSON == toContract()；turn 8 行全 P0 且 covered_by 在盘上；4 条 enforced 不变量 evidence 在盘上；reachable 无不可达；30 格列 6 格其余 24 格 unlisted；session-runtime 的 busy 行为 declared_unknown 可见 |
| `test/unit/generator.test.ts`（前 6 条） | 6 | gaps 为空；maxSteps=2 生成 10 条路径覆盖 3 个终态；生成路径走过的行 == 全表行；生成集合 ⊆ 手写 covered_by；答案卷是行 id 序列；改 reason 不引起答案卷漂移 |
| `test/unit/journeys.test.ts`（前 3 条） | 3 | journeys.json 每条 id 存在、从 initial 出发、首尾相接、落终态；validateJourney 点名坏 id / 断链；生成器 10 条路径与 journeys 集合相等 |
| `test/unit/explore.test.ts` | 6 | 同 seed 同结果；guard 洞点名 + ddmin 缩到 1 步；ddmin 单测；turn / session / session-runtime 三张表 300 走零违反、每行都被碰到 |
| `test/unit/parser.test.ts` | 10 | 协议正例、裸文本、多调用、坏 JSON、缺 name、call+final 冲突、`<invoke>` 别名、裸 JSON、`<tool_code>` 外包 |
| `test/unit/tools.test.ts` | 16 | 全部走 `registry.invoke`：specs 形状、未注册、缺必填、类型错、未知参数、枚举外、默认截断、自定义 compact、重名、handler 抛错；四个工具的可见行为 |

| `test/unit/docs.test.ts` | 7 | AGENTS.md 七章节按序、铁律 ≤10；引用的文件与命令存在；测试文件全列出；ARCHITECTURE 机器清单 == contracts/*.machine.ts 且证明文件在盘上；gate.sh 四步顺序；TEST_REPORT 三层分开、§13 八条齐 |

小计 67 条（v0.2）。

## 2. 第二层：假模型通过（FakeLLM 脚本驱动 `agent.run`，断用户可见契约）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/unit/agent-loop.test.ts` | 11 | 直接回复、单/多工具、max_steps、坏 JSON 回喂、**坏 JSON 那步是 blocked（reject_code=PARSE_ERROR，trace 数出 1 次，回喂在 onBlocked）**、工具失败回喂、LLM 异常、解析失败到上限、**残缺表验证闸**（unknown → 不执行副作用 + 记 trace + error 终态；测试模式抛出） |
| `test/unit/session-context.test.ts` | 11 | 两窗口隔离、纯对话追问、带工具追问、think 剥离、压缩（模型摘要 / 规则兜底，compact 作为副作用挂在轮首转移）、memory 跨会话与跨用户、**remember 的 value 不进 trace（redact）**、**trace 转移序列 == 行 id 答案卷**、**每个 llm / tool effect 有唯一 request_id** |
| `test/unit/generator.test.ts`（后 10 条） | 10 | 10 条生成路径逐条真跑，trace 序列 == 答案卷（含 `[noop]` / `[blocked]`），终态 ↔ stoppedBy 对应，无 unknown |
| `test/unit/journeys.test.ts`（后 5 条） | 5 | checkJourney 三态：passed（带 trace_id）/ failed（closest 实际序列）/ not_observed（空 rows、别的 trace_id、别的 feature）；alternatives 命中；unknownRows 点名残缺表下的 unknown 记录 |
| `test/unit/invariants.test.ts` | 9 | 四条 P0 不变量各一红一绿（见 §4）；④ 用 FileSessionStore + FileTraceSink 真落盘；文件持久化「tmpdir 存 → 新实例读 → 接着聊」，remember 落盘可读，list 只见本用户 |

小计 46 条（v0.2）。

## 3. 第三层：真实模型少量 smoke（D9：写「少量 smoke」，不写可靠率）

`test/live/live.test.ts` 5 个场景（计算、搜索 + 追问、待办跨轮 + 跨窗口、remember 跨会话、原生 function calling）。

- **审阅时实跑两次**（qwen3-max，DashScope，2026-09-15 UTC 05:24 与 05:25）：第一次 **3/5**，第二次 **5/5**。转移记录在 `evals/live-trace/2026-09-15-05-24*`（含失败那次）与 `2026-09-15-05-25*`；改造前的旧格式记录已删除。全部记录 `status` 均为 allowed，无 unknown。
- 第一次的两条失败，都不是本次改动引入的（main 同时段基线 5/5）：
  - 「搜索 + 追问」：模型搜的是「上海今天天气」（无空格），mock search 按整串子串匹配，语料标题是「上海今日天气」→ 没找到 → 模型答「无法获取」。属 mock 搜索的分词缺陷（issue #3）。
  - 「原生 function calling」：模型没走 `tool_calls`，直接输出 `<function=calculator><parameter=expression>99*99</parameter></function>`——第四种标签变体，解析器不认、当成 final。属解析器别名缺口（issue #4）。
- 样本仍是少量 smoke（2 × 5），不写可靠率。

另：CLI 冒烟（手工，本次）——把 `OPENAI_BASE_URL` 指到不可达端口跑 `npm run chat`，看到 `deciding --LLM_FAILED--> error` 回显、`助手> 模型调用失败：Connection error.`、trace 文件一条转移记录且 key 字符串不在 trace 与 session JSON 里。

## 4. 四条 P0 不变量（D3）

| # | 不变量 | oracle | 绿 | 红 |
|---|---|---|---|---|
| ① | 无工具执行于解析失败之后 | `noToolAfterParseError` | 坏 JSON → 正确调用 → final：tool 副作用只在 executing_tools + TOOLS_DONE，前一条是 allowed 的 PARSED_TOOL_CALLS | 把 tool 副作用挪到 PARSED_ERROR 转移上 → 点名 |
| ② | 一轮恰一个最终答案 | `exactlyOneFinalAnswer` | 恰 1 条终态转移在末尾、恰 1 个 answer 副作用、历史恰 1 条 `<final>` | 复制终态转移 / 历史多塞一条 `<final>` → 点名 |
| ③ | 三终态互斥可区分 | `terminalStatesDistinct` | final / max_steps / error 三轮，终态 ↔ stoppedBy 一一对应 | 终态 done 却报 stoppedBy=error → 点名 |
| ④ | 答案 == 盘上历史末条 == trace 末次决策 | `answerAligned` | 文件存储真落盘：返回值、`data/sessions/A/w1.json` 末条、`trace/w1.jsonl` 末条 answer 三处一致 | 改盘上 JSON 末条 / 改 JSONL 末条 answer → 各自点名 |

oracle 实现在 `src/machine/invariants.ts`，只看 trace 记录、返回值、盘上历史，不碰 runtime 内部。

## 5. 对标标准 §13 八条

| # | §13 条目 | 状态 | 证据 |
|---|---|---|---|
| 1 | 所有定义的可达状态和转移都有覆盖记录 | **满足**（turn 表） | `reachable` 无不可达状态/行；8 行全部 covered_by 指向盘上手写测试；生成路径走过的行 == 全表行（`contracts.test.ts`、`generator.test.ts`） |
| 2 | 至少一个意外状态能被 oracle 自动判定，而非人工发现 | **满足** | 残缺表下 unknown 转移被闸拦下并记 `status:'unknown'`（`agent-loop.test.ts::表里没列的转移在运行时被拦下`）；四条不变量的红例均由 oracle 点名 |
| 3 | 全链路同一 traceId 串联 | **满足**（本项目的链路 = 模型 / 工具 / 压缩 / 会话落盘） | 每条转移记录带 `trace_id = 用户/会话/轮次`；④ 从盘上 JSON 与 JSONL 两处读回对齐 |
| 4 | 失败场景能自动缩减并重新回放 | **部分** | 回放：每条生成路径的 id 就是事件序列，`scriptFor()` 一步还原成 FakeLLM 脚本；缩减：未做属性测试与自动缩减（见 NEXT_STEPS） |
| 5 | 主题和菜单布局有结构化断言 | **不适用** | 无 UI（D7） |
| 6 | 工作空间重命名、刷新、重启、定时任务恢复有正例、反例、邻近 invariant | **部分**（按对应物） | 重启对应物：新实例读盘接着聊（正例）、别的用户 `list` 为空 / 看不到 memory（反例）、压缩失败退回规则（邻近）；重命名与定时任务无对应物 |
| 7 | 报告区分已验证、失败、未覆盖、跳过、外部依赖不可用 | **满足** | 本报告 §0–§3：已验证（进程内）89 条；真实模型少量 smoke 3/5 → 5/5，两条失败已归因并开 issue；未覆盖见 §6 |
| 8 | 敏感数据不进测试产物或 trace | **部分** | ④ 里一条弱断言（trace 文件不含 `apiKey|OPENAI`）+ CLI 冒烟手工确认 key 字符串不在 trace / session；表里 `api_key_never_in_trace` 仍标 planned，因为还没有「把真 key 放进配置再 grep 产物」的自动测试 |

## 6. 未覆盖 / 诚实边界

- ② session 表与 ③ session-runtime 表只建表 + 契约，**没有接代码**；`compacting + INPUT`、`busy + INPUT/ASYNC_DONE` 标 unknown。
- LLM 重试在 `callLLM` 内部，trace 上只见 `attempts` 数，不是逐次转移。
- 真实模型只有 smoke（两次 × 5 条），失败两条已归因、未修（issue #3、#4）。
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
| A1 行 id | machine.test「A1：行 id 必填且定义期查重」；generator.test「答案卷是行 id 序列」；agent-loop / session-context 序列断言 | `expected [Function] to throw an error`；`expected [ 'deciding --LLM_FAILED--> error' ] to deeply equal [ 't-llm-failed' ]` |
| A2 request_id | session-context.test「A2：每次模型调用、每次工具调用各有一个 request_id」 | `.toMatch() expects to receive a string, but got undefined` |
| A3 blocked | machine.test「rejected 行的 verdict 是 blocked」；agent-loop.test「A3：坏 JSON 那一步是 blocked」 | `expected { status: 'rejected', … } to match object { status: 'blocked', … }`；`expected [ 't-llm-ok', 't-parse-error', …(2) ] to deeply equal [ 't-llm-ok [noop]', …(3) ]` |
| A4 planned note | machine.test「A4：planned 不变量必须带 note」 | `expected [Function] to throw an error` |
| A5 redact | session-context.test「A5：remember 的 value 不进 trace」 | `expected '{"key":"city","value":"上海徐汇区"}' not to contain '上海徐汇区'` |
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
- A3：坏 JSON 序列出现 `[blocked]`、`LLM_OK` 出现 `[noop]`；两处「全部 status=allowed」改为「allowed 或 noop」/「无 unknown」（LLM_OK 改 noop 的直接后果）；machine.test 的 rejected 断言 `status` 改 `blocked`。
- 其余既有断言未动。

### 对标 §13 的变化

- 第 4 条（失败场景自动缩减并回放）：**部分 → 模型层满足**——`explore.ts` 的 ddmin 把违反缩到最短事件序列，回放即 `replay(m, steps)`；运行层（FakeLLM 脚本缩减）仍未做。
- 第 8 条（敏感数据不进 trace）：**部分 → 部分（更强）**——工具 args 走 `redact`，remember 的 value 只留长度（单测 + live trace 两处确认）；`api_key_never_in_trace` 仍 planned（note 写明缺自动测试）。
