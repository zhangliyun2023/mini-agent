# mini-agent

从零实现的最小可用 Agent Runtime：loop / 工具注册 / 输出解析 / session / context 压缩 / trace。TypeScript，运行时依赖只有 OpenAI SDK（当 HTTP 客户端）。轮循环由状态表驱动，详见 `AGENTS.md`。

> **只想看最小 loop？** 三个文件够了：`contracts/turn.machine.ts`（循环的状态表，5 状态 × 6 事件）→ `src/runtime/agent.ts`（每步先 `interpret` 再执行副作用）→ `src/protocol/parser.ts`（模型输出怎么变成事件）。其余都是围绕这条 loop 的证明：契约、不变量、生成器、探索、证据。

## 运行

```bash
npm ci
cp .env.example .env        # 填任意 OpenAI-compatible 的 key；默认 DashScope qwen3-max，DeepSeek deepseek-flash 也实测通过
npm run chat -- --user A --session w1
```

- 同一 `--user` 开两个不同 `--session` 就是两个窗口，待办与历史互不可见；同一 `--session` 再进即接着聊。
- `--native-tools` 切到厂商原生 function calling；`--quiet` 关掉 trace 回显。
- 会话落在 `data/sessions/`，长期记忆在 `data/memory/`，trace 在 `trace/<session>.jsonl`（均不入库）。
- CLI 里 `/sessions` 列出本用户会话，`/exit` 退出。

## 验证

```bash
npm test                 # 全部单测，不需要 key；条数见 docs/TEST_REPORT.md §0
npm run check            # typecheck + 契约漂移检查 + 单测
npm run test:live        # 真实模型 5 个 smoke，需要 key
bash scripts/gate.sh v0.3   # 一键门禁，证据落 docs/evidence/v0.3/（无 key 时 live 写 skipped）
```

## 系统设计

题目的四步循环就是 `contracts/turn.machine.ts` 那张表——runtime 每一步先 `interpret(state, event, facts)`，表允许才执行副作用：

```
用户输入 → deciding ──LLM_OK──▶ 解析 ──PARSED_FINAL────▶ done（返回给用户）
                        │              ├──PARSED_TOOL_CALLS─▶ executing_tools ──TOOLS_DONE──▶ deciding（继续 loop）
                        │              └──PARSED_ERROR───▶ blocked：错误回喂模型，本步不跑工具
                        └──LLM_FAILED──▶ error        步数用尽 ──▶ max_steps（交还已有结果）
```

| 题目要求 | 落点 |
|---|---|
| 从零、不依赖框架 | 运行时依赖只有 OpenAI SDK（当 HTTP 客户端）；loop / 解析 / 注册表 / session / 压缩全部自写 |
| 工具注册：名称 + 描述 + 参数 Schema，模型按 Schema 决策 | `src/tools/registry.ts`：`register(def)`，`specs()` 拼进 system prompt，`invoke()` 先校验 Schema（必填 / 类型 / 未知字段 / 枚举）再执行，结果经工具自己的 `compact` 精简、`redact` 脱敏后回填 |
| 至少三个工具 | calculator（白名单字符，不 eval 任意代码）、search（mock 语料）、todo（挂在 session 上的有状态工具）、remember（写用户级记忆） |
| 解析思考 / 工具调用 / 最终答案 | `src/protocol/parser.ts`：`<think>` `<tool_call>{json}` `<final>` 三段协议；只认开标签、JSON 靠配平大括号截取；接住真实模型实测的六种偏差（`<invoke>` 别名、裸 JSON、`<tool_code>` 外包、`<function=…>` 变体、闭合写成开标签、`<final>` 重复/无闭合）；解析错误回喂模型自纠，永不抛异常 |
| 原生 function calling | `--native-tools`：厂商 `tool_calls` 转成同一套标签走同一条解析路径 |
| session：用户 A 两个窗口独立、随时接着聊 | `(userId, sessionId)` 定位一个会话；历史、有状态工具的数据袋、轮次计数都在会话上；文件存储每会话一个 JSON，重进即续 |
| 最大轮次 | 两层：一次输入内最多 8 次模型决策（安全阀，到顶交还最近三条工具结果）；会话历史超 40 条或 12k 字符触发压缩；system prompt 里的记忆块另有 1200 字符上限（见「Context 与 memory」） |
| 异常处理 | 模型调用指数退避重试 2 次后以可读错误结束；工具抛错 / 参数错 → `[error]` 结果回喂；解析失败 → blocked 回喂；表里没列的 (状态, 事件) → unknown，不执行副作用、记 trace、error 终态 |
| trace / 执行日志 | `trace/<session>.jsonl`，一次状态转移一行：`trace_id`（一轮）、`transition`（行 id）、`status`、每个模型 / 工具调用作为 effect 带 `request_id`、耗时、token、预览；CLI 实时回显 |

## Context 与 memory：放什么、何时召回、放在哪

**进 context 的**（每次模型调用的消息列表，`src/session/context.ts::assembleMessages`）：

1. system prompt：角色 + 协议 + 规则 + 工具清单（含 Schema 原文）+ **用户级记忆块**（有上限，见下）
2. 压缩摘要（如果有）：一条 system 消息「此前对话摘要」
3. 会话历史：用户输入、模型的工具调用文本、**精简后的**工具结果、最终答案
4. 本轮消息：本轮全部往返，含当轮的 `<think>`

**不进的**：历史轮的思考过程——轮次结束时剥掉（`stripThink`），它只对当轮有用；工具结果的原文超过 1500 字符的部分。

**压缩**（题目要的「基础压缩」）：历史超阈值时，保留最近 12 条原文，切点回退到 user 消息（不把一轮 tool_call / tool 从中间切断），更老的部分让模型压成 ≤200 字要点（累积在会话上）；模型失败退回规则压缩（保留用户原话 + 答案首句）。追问仍能接上，因为最近几轮原文都在。

**预算是两个独立上限，不是一个总预算**（`src/session/context.ts::ContextOptions`）：

| 上限 | 默认 | 超了怎么办 |
|---|---|---|
| 历史：`maxHistoryMessages` / `maxHistoryChars` | 40 条 / 12k 字符 | `needsCompaction` 只量 `session.history`，触发上面的压缩 |
| 记忆块：`memoryMaxChars` | 1200 字符（= 历史阈值的 10%） | `renderMemory` 按写入顺序保留最新的条目，截掉最老的；trace 记一条 `memory_truncated` warning |

为什么不把 system prompt 长度并进历史阈值：system prompt 的其余部分（协议 + 工具 Schema）是常量，唯一会长的记忆块已经被自己的上限封顶，所以 system prompt 的大小是有界、可预测的；如果把它算进历史预算，记忆一多就会让历史被提前压缩，两个原因互相掩盖，排查时说不清是哪个撑爆了。两个独立上限各管各的，trace 上 `compact` 与 `memory_truncated` 也分开可见。这条行为由 `test/unit/session-context.test.ts`「历史阈值与记忆上限是两个独立上限」锁定。

**追问**：纯对话追问靠历史里的用户输入 + 最终答案；带工具的追问（「把第一条标完成」）靠 todo 的状态挂在会话上——工具结果本身已精简，但状态在 `session.state` 里完整保留。

**用户级 memory**（跨会话）：

| | 做法 |
|---|---|
| 写入时机 | 模型显式调 `remember(key, value)`——用户说「记住…」或透露稳定信息（称呼、城市、职业、长期偏好）；没调用就不算记住，prompt 禁止口头「已记下」 |
| 召回时机 | **每轮组 context 时**，不做检索：`memory.load(userId)` 全量取出，再按上限截 |
| 放置位置 | system prompt **尾部**的 `<memory>` 块，逐条 `- key: value`，标明是过去的观察不是规则 |
| 上限与截断 | 整块 ≤ `memoryMaxChars`（默认 1200 字符，即历史阈值 12k 的 10%）；超限按**写入顺序**保留最新的条目、截掉最老的（同 key 覆写算重新写入，位置不变）；不做时间衰减、不按「最近用到」排序。截断事实作为 `memory_truncated {total, kept, limit}` warning 挂在本轮第一条转移的 effects 上（与 `compact` 同一挂法），模型看到的块里没有被截掉的条目 |
| 为什么不检索 | 条目少时全量注入比检索稳，且「召回时机 / 位置」一句话说清；现在的兜底是上限 + 截最老，够用到条目多得「最新的 1200 字符」不再是想要的那批为止——那时才值得上检索式召回，列在 `docs/NEXT_STEPS.md` |
| 隔离 | 按 userId 一个文件；别的用户看不到；trace 里 remember 的 value 只记长度 |

## 指路

- 入口（七章节）：`AGENTS.md`
- 架构与机器清单：`docs/ARCHITECTURE.md`
- 规格与用户故事：`docs/SPEC.md`
- 状态机线的决定：`docs/product/SPEC-state-machines.md`
- 测试报告（三层分开写）：`docs/TEST_REPORT.md`
- 下一步：`docs/NEXT_STEPS.md`
- AI 协作记录：`AI-LOG.md`
- 架构设计题答案（五模块各一题）：`docs/DESIGN-QUESTIONS.md`
