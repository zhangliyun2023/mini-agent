# TEST_REPORT — mini-agent（2026-09-15）

对标 `docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md` §13 与 §17.1：**分层写，不把前一层冒充后一层**。

## 0. 实跑输出

| 命令 | 结果 | 备注 |
|---|---|---|
| `npm run typecheck` | 通过 | `tsc --noEmit`，含 `contracts/` `scripts/` |
| `npm run contracts:check` | 3 份契约 0 漂移 | turn / session / session-runtime |
| `npm test` | 9 文件 89 条全绿 | 不需要 key |
| `npm run test:live` | 两次运行：**3/5，再跑 5/5** | 审阅者本机有 key；两条失败是模型抖动暴露的旧问题，见 §3 |

## 1. 第一层：纯函数通过（不碰模型、不碰 runtime）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/unit/machine.test.ts` | 8 | 未列组合 unknown；显式 kind:'unknown' 行；同格 guard 顺序取首条、守卫全不命中 unknown；rejected/noop 不改状态；定义期校验 6 种；enumerate 全表；reachable 与不可达点名；toContract 逐字确定 |
| `test/unit/contracts.test.ts` | 9 | 盘上 3 份 JSON == toContract()；turn 8 行全 P0 且 covered_by 在盘上；4 条 enforced 不变量 evidence 在盘上；reachable 无不可达；30 格列 6 格其余 24 格 unlisted；session-runtime 的 busy 行为 declared_unknown 可见 |
| `test/unit/generator.test.ts`（前 4 条） | 4 | gaps 为空；maxSteps=2 生成 10 条路径覆盖 3 个终态；生成路径走过的行 == 全表行；生成集合 ⊆ 手写 covered_by |
| `test/unit/parser.test.ts` | 10 | 协议正例、裸文本、多调用、坏 JSON、缺 name、call+final 冲突、`<invoke>` 别名、裸 JSON、`<tool_code>` 外包 |
| `test/unit/tools.test.ts` | 16 | 全部走 `registry.invoke`：specs 形状、未注册、缺必填、类型错、未知参数、枚举外、默认截断、自定义 compact、重名、handler 抛错；四个工具的可见行为 |

| `test/unit/docs.test.ts` | 4 | AGENTS.md 引用的文件与命令存在；四件套齐；TEST_REPORT 三层分开、§13 八条齐 |

小计 51 条。

## 2. 第二层：假模型通过（FakeLLM 脚本驱动 `agent.run`，断用户可见契约）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `test/unit/agent-loop.test.ts` | 10 | 直接回复、单/多工具、max_steps、坏 JSON 回喂、工具失败回喂、LLM 异常、解析失败到上限、**残缺表验证闸**（unknown → 不执行副作用 + 记 trace + error 终态；测试模式抛出） |
| `test/unit/session-context.test.ts` | 9 | 两窗口隔离、纯对话追问、带工具追问、think 剥离、压缩（模型摘要 / 规则兜底，compact 作为副作用挂在轮首转移）、memory 跨会话与跨用户、**trace 转移序列 == 答案卷** |
| `test/unit/generator.test.ts`（后 10 条） | 10 | 10 条生成路径逐条真跑，trace 序列 == 答案卷，终态 ↔ stoppedBy 对应，全部 status=allowed |
| `test/unit/invariants.test.ts` | 9 | 四条 P0 不变量各一红一绿（见 §4）；④ 用 FileSessionStore + FileTraceSink 真落盘；文件持久化「tmpdir 存 → 新实例读 → 接着聊」，remember 落盘可读，list 只见本用户 |

小计 38 条。

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
