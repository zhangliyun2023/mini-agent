# AGENTS.md — mini-agent 唯一入口

给人和 Agent 看的地图。改代码前先读这页；这页引用的文件与命令由 `test/unit/docs.test.ts` 守着，写错就红。

## 一句话

从零写的最小 Agent Runtime（TypeScript，无框架）。**轮循环由状态表驱动**：`contracts/turn.machine.ts` 就是 loop 的控制流，runtime 每一步先查表，允许才执行副作用，表里没列的组合被拦下并留下记录。

## 命令

| 命令 | 作用 |
|---|---|
| `npm test` | 全部单测（不需要 key，vitest） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run contracts:check` | 盘上 `contracts/*.contract.json` 与表是否漂移，漂了退出码 1 |
| `npm run contracts:gen` | 改了表之后重新生成契约 JSON（然后看 diff） |
| `npm run check` | typecheck + contracts:check + test，提交前跑这个 |
| `npm run test:live` | 真实模型 5 个 smoke 场景，需要 `.env` 里有 key；trace 写到 `evals/live-trace/` |
| `npm run chat -- --user A --session w1` | CLI；加 `--native-tools` 切原生 function calling，`--quiet` 关 trace 回显 |

## 文档

| 文件 | 内容 |
|---|---|
| `docs/SPEC.md` | 产品规格：词汇、用户故事 1–44、实现决策、测试决策 |
| `docs/product/SPEC-state-machines.md` | 状态机线的 11 条决定（D1–D11）、表形状、切片 S0–S6 |
| `docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md` | 依据的参照标准 |
| `docs/TEST_REPORT.md` | 测试报告：分「纯函数 / 假模型 / 真实模型 smoke」三层；对标标准 §13 八条逐条给证据 |
| `docs/NEXT_STEPS.md` | 没做与下一步 |
| `AI-LOG.md` | AI 协作记录：提示、真实模型暴露的偏差、处置 |
| `README.md` | 运行方式 + 指路 |

## 代码地图

```
contracts/
  turn.machine.ts              ① 轮循环表（接代码）+ runner 协议（哪个状态发哪些事件、facts 怎么推进）
  session.machine.ts           ② 会话生命周期表（只建表）
  session-runtime.machine.ts   ③ 会话并发表（busy 行为标 unknown，只建表）
  *.contract.json              由表生成的契约；npm run contracts:gen 重生成
src/machine/
  interpreter.ts               通用解释器：defineMachine / interpret / enumerate / reachable / toContract
  generator.ts                 从表 + runner 协议 BFS 出路径清单（答案卷）
  invariants.ts                四条 P0 不变量的独立 oracle
src/runtime/
  agent.ts                     表驱动的 turn runner（闸）：transition() 先 interpret，allowed 才执行副作用
  trace.ts                     打点单位 = 一次转移 {trace_id, step, from, to, event, status, reason, effects}
src/protocol/                  system prompt 构建 + 模型输出解析（永不抛）
src/tools/                     注册表（校验 → 执行 → 精简）+ calculator / search / todo / remember
src/session/                   会话存储（内存 / 文件）+ context 组装与压缩
src/memory/                    用户级长期记忆（内存 / 文件）
src/llm/                       LLMClient 接口 + OpenAI-compatible 实现 + FakeLLM
scripts/contracts.ts           contracts:gen / contracts:check 的实现
```

## 测试地图（89 条，`npm test`）

| 文件 | 层 | 内容 |
|---|---|---|
| `test/unit/machine.test.ts` | 纯函数 | S0 解释器：unknown、guard 顺序、定义期校验、enumerate、reachable、toContract 确定性 |
| `test/unit/contracts.test.ts` | 纯函数 | S1/S5 三份契约 0 漂移；P0 行 covered_by 与 enforced 不变量 evidence 在盘上找得到；reachable 无不可达 |
| `test/unit/generator.test.ts` | 纯函数 + 假模型 | S3 生成 10 条路径、gaps 为空、生成集合 ⊆ 手写覆盖；每条路径 FakeLLM 真跑，trace 序列 == 答案卷 |
| `test/unit/invariants.test.ts` | 假模型（含真落盘） | S4 四条 P0 不变量各一红一绿；④ 用 FileSessionStore + FileTraceSink；文件持久化接着聊 |
| `test/unit/agent-loop.test.ts` | 假模型 | 循环行为 + 残缺表验证闸拦得住（error 终态 / 测试模式抛出） |
| `test/unit/session-context.test.ts` | 假模型 | 窗口隔离、追问、think 剥离、压缩、memory、trace 答案卷 |
| `test/unit/parser.test.ts` | 纯函数 | 协议解析与真实模型偏差 |
| `test/unit/docs.test.ts` | 纯函数 | S6 守文档：AGENTS.md 引用的文件与命令都存在，TEST_REPORT 三层分开 |
| `test/unit/tools.test.ts` | 纯函数 | 注册表全部走 `registry.invoke`：未注册 / 缺必填 / 类型错 / 未知参数 / 枚举外 / 截断 / handler 抛错 |
| `test/live/live.test.ts` | 真实模型 smoke | 5 场景，无 key 自动跳过 |

## 改表的流程

1. 改 `contracts/turn.machine.ts`（加行必须带 `priority` 与 `covered_by`）。
2. 先写红测试：手写测试名放进 `covered_by`，`npm test` 会因盘上找不到而红。
3. 补测试与实现，`npm run contracts:gen`，看契约 diff 是否就是你想要的。
4. `npm run check` 全绿再提交。生成器会自动告诉你 runner 协议发得出、表却没列的组合（gaps）。

## 不要做

- 不要在 `src/runtime/agent.ts` 里绕过 `transition()` 直接改状态或执行工具。
- 不要为了绿而把 unknown 组合改成 allowed；unknown 就是「还没决定」。
- 不要让 LLM 生成用例；用例来自表 + runner 协议 + 手写。
- 不要把 `data/`、`trace/`、`.env` 提交进仓库。
