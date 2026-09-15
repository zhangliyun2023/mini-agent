# t10 · 原生 function calling 完整化（issue #10）

分支 `t10-native`，基于 `a531d0e`。四片各一提交，每片先红后绿；证据文件 `1-typecheck.txt` / `2-unit.txt` / `3-contracts.txt` / `4-live.txt` 由 `bash scripts/gate.sh t10` 在 `4464a88` 上一次产出。

## 做了什么

| 片 | 提交 | 改动 |
|---|---|---|
| 1 | `d1a82f5` | `LLMClient.toolMode`；`buildSystemPrompt(tools, memory, mode)` 原生模式不教标签、不列 Schema；`FakeLLM` 加 `{ native: true }` |
| 2 | `923d1d7` | `ChatMessage.toolCalls`；runtime 把 `nativeToolCalls` 转成统一 `ParsedOutput`，本轮 assistant 带 `toolCalls`、tool 消息用厂商 id、原生答案不套 `<final>`；llm effect 加 `mode`；FakeLLM 脚本项可写 `{ toolCalls }` |
| 3 | `b0f67b5` | `OpenAICompatibleLLM` 声明 `toolMode`、不再把 tool_calls 拼成标签文本；`toWireMessages` 原生模式原样回放 `assistant.tool_calls` + `role=tool/tool_call_id`，对不上的降级 user；文本模式不变 |
| 4 | `4464a88` | 压缩转写补 `toolCalls`，规则兜底不产生空「助手：」行 |

表（`contracts/*.machine.ts`）未改：没有新增状态 / 事件 / 副作用种类，`mode` 只是 llm effect 上的字段，`contracts:check` 0 漂移。`src/runtime/trace.ts` 只加了 `mode: ToolMode` 一个字段（Effect 类型需要）。

## 红测名与红输出（`test/native/native-tools.test.ts`）

| 片 | 测试 | 红输出 |
|---|---|---|
| 1 | 原生模式：system prompt 不教标签协议（无 `<tool_call>` / `<final>` / `<think>`）、不列工具 Schema，但规则段与记忆块仍在；文本模式仍教标签 | `expect(sys.content).not.toContain("<tool_call>")`，diff 里可见整段标签协议与「参数 Schema:」清单 |
| 2 | assistant 消息带 tool_calls（id/name/arguments），紧跟的 tool 消息 role=tool 且 tool_call_id 与之对应；trace 的 llm effect 标 mode: native | `TypeError: s.replace is not a function`（FakeLLM 无原生分支，对象脚本被当文本预览） |
| 2 | 文本模式的 llm effect 标 mode: text；tool 消息仍用 runtime 自己的 step-index id | `AssertionError: expected undefined to be 'text'` |
| 3 | tool_calls 回放为 assistant.tool_calls + role=tool/tool_call_id（不降级成 user）；带工具的追问把上一轮的这对消息原样回放；tools 经 API 字段给、system 不教标签（本地 HTTP 端点收真正 POST 出去的 body） | `AssertionError: expected '你是一个可以调用工具的助手。每次回复必须严格使用下面的标签格式…' not to contain '<tool_call>'` |
| 4 | 压缩：原生历史里带 toolCalls 的 assistant 消息在摘要调用的转写里能看见调用了哪个工具；规则兜底不产生空的「助手：」行 | `AssertionError: expected '[user] 算1+1\n[assistant] \n[tool:calc…' to contain '"expression":"1+1"'` |

首跑即绿、如实声明的三条（行为已由前面的片实现，只做 AC 覆盖，未做变异）：

- 文本模式不变：不传 tools 字段，工具结果仍降级为带前缀的 user 消息，system 仍教标签（片 3，邻近不变量）
- 带工具的追问：「第一条完成了」作用在上一轮建的清单上；第二轮请求里回放的历史是 assistant.toolCalls + tool.toolCallId 配对，答案不带 `<final>`（片 4；AC 第 3 条，真实客户端版在片 3 那条里红过）
- tool_calls 的 arguments 不是合法 JSON：不执行、当解析错误回喂（blocked / PARSE_ERROR），回喂后模型重发即可完成（片 4）

## 门禁数字（`4464a88`）

| 项 | 结果 | 证据 |
|---|---|---|
| `npm run typecheck` | exit 0 | `1-typecheck.txt` |
| `npm test` | 13 文件 136 条全绿（既有 128 条一字未改，新增 8 条） | `2-unit.txt` |
| `npm run contracts:check` | 3 份契约 0 漂移，exit 0 | `3-contracts.txt` |
| `npm run test:live` | 6/6（5 场景 + trace 文件存在），afterAll 不变量：7 文件 / 9 轮 / 39 条转移，noop 16 + allowed 23，0 blocked，0 unknown | `4-live.txt` |

## 真实模型少量 smoke（只跑一次）

DeepSeek `deepseek-flash`（`.env` 里的 `OPENAI_BASE_URL` / `MODEL`），2026-09-15 07:52 UTC。

- 文本协议 4 场景 + 原生 1 场景全部通过；trace 在 `evals/live-trace/2026-09-15-07-52/` 与 `…-07-52-native/`。
- 原生场景 `native.jsonl`：2 条 llm effect 均 `mode: "native"`；第一步 `outputPreview` = `[tool_call calculator {"expression": "99*99"}]`（模型走了 `tool_calls`），tool effect `calculator {"expression":"99*99"} ok`，答案「99 × 99 = 9801」。
- 文本协议 trace 的 14 条 llm effect 均 `mode: "text"`。
- 新 trace 入库后 `test/unit/live-evidence.test.ts` 离线检查仍绿（`npm test` 136/136 复跑）。
- 这是一次 smoke，不写可靠率；#4 那种「原生模式下模型把调用写成文本」是否还会偶发，一次样本证明不了，只能说本次没出现且 prompt 层的冲突已消除。

## 验收标准对照

| AC | 状态 | 证据 |
|---|---|---|
| 原生 prompt 不含 `<tool_call>` / `<final>`；文本模式仍含 | 已验证（进程内） | 片 1 测试 + 片 3 真实客户端测试（`bodies[0].messages[0]`） |
| 下一条请求 tool 消息 role=tool 且 tool_call_id 对应 assistant.tool_calls[].id（FakeLLM 原生分支断言） | 已验证（进程内） | 片 2 测试（FakeLLM）+ 片 3（真正 POST 的 body） |
| 带工具的追问原生模式单测通过（历史回放不 400） | 已验证（进程内，本地端点） | 片 3 第二轮 `bodies[2]` 回放 `call_abc` 配对；片 4 FakeLLM 版 |
| `test:live` 原生场景过，trace llm effect `mode: native` | 真实模型少量 smoke，1 次 | `4-live.txt`、`evals/live-trace/2026-09-15-07-52-native/native.jsonl` |
| 既有 128 条不改；AI-LOG 记 #4 根源 | 已验证 | `git diff a531d0e -- test/unit` 为空；`AI-LOG.md` §6 |

## 诚实边界

- **混合历史**（同一会话先文本模式再切原生）不在本票：映射层对 id 对不上的 tool 消息降级为 user 只是兜底，没有测试。
- **测试文件位置**：新测试在 `test/native/`，不在 `test/unit/`——`docs.test.ts` 用 `docs/TEST_REPORT.md` §0 表对账 `test/unit` 条数，本票不改 TEST_REPORT / AGENTS / README。下次改 TEST_REPORT 时应并表并搬回。
- **未跑 CLI 真机**：`npm run chat -- --native-tools` 没有手工冒烟，只有 live 单场景。
- **变异**：本票没有对新增不变量做变异，红证据全部来自 TDD 循环里的自然红。
- **not_run / skipped**：无——四步门禁都实跑。
