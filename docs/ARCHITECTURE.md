# ARCHITECTURE — mini-agent

一页说清：运行单元是什么、哪几张状态表、各自怎么接进代码、谁证明它们没漂。词汇与决定见 `docs/product/SPEC-state-machines.md`（D1–D11）。

## 运行单元

一次 `agent.run({userId, sessionId, input})` = **一轮（turn）** = 一个 `trace_id`（`用户/会话/轮次`）。轮里每次模型调用、每次工具调用各一个 `request_id`（`r-` + 短随机）。返回值 `RunResult.stoppedBy` 是「代码说的终态」，trace 末条转移的 `to` 是「机器说的终态」，两者由不变量 ③ 绑定。

```
用户输入 ──▶ run()
             │ needsCompaction? → compactSession（挂到本轮第一条转移的 effects）
             ▼
        ┌─ deciding ──LLM_OK[noop]──▶ 解析 ──PARSED_FINAL──▶ done
        │     │                          ├──PARSED_TOOL_CALLS──▶ executing_tools ──TOOLS_DONE──▶ deciding / max_steps
        │     │                          └──PARSED_ERROR ──[hasStepsLeft] blocked：回喂错误，留在 deciding
        │     │                                            └─ 步数用尽 → max_steps
        │     └──LLM_FAILED──▶ error
        └─ 未列 (状态, 事件) → unknown：不执行副作用、记 trace、本轮 error（测试模式抛出）
```

每一步都走 `src/runtime/agent.ts::transition()`：先 `interpret(表, state, event, facts)`，`allowed` 才跑 `apply`（副作用），`blocked` 只跑 `onBlocked`（回喂消息，状态不变），`noop` 什么都不跑，`unknown` 拦下。落到终态的那条转移同时写历史、存盘、挂 `answer` 副作用。

## 机器清单（表 · 接法 · 谁证明）

接法：**闸** = 代码每步先查表，表就是控制流；**影子** = 只建表 + 契约 JSON，代码没接，行为在表里诚实标 `unknown`；**旅程** = 只做答案卷、不单独建表（本仓没有）。

| 表 | 接法 | 文件 | 谁证明 |
|---|---|---|---|
| `turn` | 闸 | `contracts/turn.machine.ts` → `contracts/turn.contract.json` | 契约 0 漂移 + 8 行 covered_by 在盘上：`test/unit/contracts.test.ts`；生成器 10 条路径逐条真跑 == 答案卷：`test/unit/generator.test.ts`；答案卷落盘对账与三态判分：`test/unit/journeys.test.ts`；随机探索零违反：`test/unit/explore.test.ts`；闸拦得住残缺表：`test/unit/agent-loop.test.ts`；五条 P0 不变量一红一绿：`test/unit/invariants.test.ts`；在库 live trace 离线过不变量：`test/unit/live-evidence.test.ts` |
| `session` | 影子 | `contracts/session.machine.ts` → `contracts/session.contract.json` | 契约 0 漂移、三态可达、`compacting + INPUT` 标 unknown：`test/unit/contracts.test.ts`；随机探索零违反：`test/unit/explore.test.ts` |
| `session-runtime` | 影子 | `contracts/session-runtime.machine.ts` → `contracts/session-runtime.contract.json` | 契约 0 漂移、busy + INPUT 仍 declared_unknown 可见、#19 ⑦ 的 busy / idle + ASYNC_DONE 与 queued + TURN_DONE 三格 allowed（解释器级，运行时不接）：`test/unit/contracts.test.ts`；随机探索零违反：`test/unit/explore.test.ts`；变异（unknown 谎报 allowed 必须红）：`docs/evidence/v0.2/5-mutation-B3.txt` |
| `review` | 闸 | `contracts/review.machine.ts` → `contracts/review.contract.json` | 契约 0 漂移 + 12 行全 P0 且 covered_by 在盘上 + 每个带守卫的格都有兜底：`test/unit/contracts.test.ts`；每步先 interpret、trace 序列 == 答案卷、终态 ↔ journal.status：`test/unit/review-run.test.ts`；闸拦得住残缺表（unknown → failed_partial、后续副作用不跑）：`test/unit/review-machine.test.ts`；四条 P0 不变量一红一绿：`test/unit/review-invariants.test.ts`；随机探索零违反：`test/unit/explore.test.ts` |

四张表共用一个解释器 `src/machine/interpreter.ts`（定义期校验：行 id 必填查重、rejected 必带 reject_code、planned 不变量必带 note、终态无出边、guard 顺序）。

## 行级 kind 与判定级 verdict

| 表里写（`kind`） | interpret / trace 答（`status`） | runtime 做什么 |
|---|---|---|
| `allowed` | `allowed` | 跑 `apply`，状态按 `to` 走 |
| `rejected`（必带 `reject_code`） | `blocked` | 只跑 `onBlocked`（回喂），状态不变，trace 记 `reject_code` |
| `noop` | `noop` | 不跑任何副作用，状态不变 |
| `unknown`（诚实声明）/ 未列 | `unknown` | 不跑副作用，记 trace，本轮 error（测试模式抛） |

## 答案卷（怎么对答案）

- `contracts/journeys.json`：旅程名 → `{feature, expect: [行 id…], alternatives?}`。手写，与表拴在一起（每个 id 存在、首尾相接、落终态）。
- `src/machine/check.ts::checkJourney(rows, journey)`：吃 trace JSONL 行，答 `passed` / `failed(closest)` / `not_observed`；`unknownRows(rows)` 永远单独列。
- `src/machine/generator.ts`：从表 + runner 协议 BFS 出路径，`rowIds` 与 journeys.json 集合相等（`maxSteps=2` 时 10 条），`expected` 与 `MemoryTraceSink.sequence()` 同格式（行 id，非 allowed 追加 ` [status]`）。
- `src/machine/explore.ts`：带种子随机游走，通用不变量（已建模格不得 unknown、blocked/noop 停留、allowed 落 modeled 状态、终态吸收），红了 ddmin 缩到最短复现。

## 打点（trace）

一次 `interpret` 一行 JSONL：`{ts, trace_id, feature, seq, step, from, to, event, status, reason, reject_code?, transition, effects[]}`。`transition` = 行 id（unknown 为 null）。`effects` 里 `llm` / `tool` 各带 `request_id`；`tool.args` 走工具声明的 `redact`（`remember` 的 value 只留长度）；模型输出与工具结果只进截断的 preview。**唯一显式例外**：终态转移的 `answer` 副作用带最终答案全文——不变量 ④ 要逐字对齐。API key 从不进 trace。

## 目录

```
contracts/     四张表（*.machine.ts）+ 生成的契约（*.contract.json）+ 答案卷 journeys.json
src/machine/   interpreter（解释器）/ generator（路径生成）/ check（对答案）/ explore（随机探索）/ invariants（P0 oracle）/ evidence（trace 证据离线过不变量）
src/runtime/   agent（闸 + 循环）/ trace（转移记录、request_id、sink）
src/protocol/  system prompt 构建 + 模型输出解析（永不抛）
src/tools/     注册表（校验 → 执行 → 精简；redact 进 trace）+ calculator / search / todo / remember
src/session/   会话存储（内存 / 文件）+ context 组装与压缩
src/memory/    用户级长期记忆（内存 / 文件）
src/review/    复盘（#19）：window / collect / consolidate / present / journal + run（闸：由 review 表驱动，每步先 interpret）/ trace（trace/reviews/<user>-<date>.jsonl）/ invariants（四条 P0 oracle）
src/llm/       LLMClient 接口 + OpenAI-compatible 实现 + FakeLLM
scripts/       contracts.ts（契约生成 / 漂移检查）· gate.sh（一键门禁落 docs/evidence/）
docs/evidence/ 门禁证据（入库）；trace/ 与 data/ 是运行产物（不入库）
```
