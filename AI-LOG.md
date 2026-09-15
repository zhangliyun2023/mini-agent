# AI-LOG — AI 协作记录

如实记录：用了什么提示、AI 做了什么、真实模型暴露了什么问题、怎么处置、哪些没有验证。

## 1. 协作方式

- 规格先行：`docs/SPEC.md` 与 `docs/product/SPEC-state-machines.md` 由作者写定并确认，AI 按规格实现；规格改动时代码随之改。
- 测试先行：每个 seam 先写红测试再实现；真实模型暴露的偏差先补红测试再改解析器 / prompt。
- 断言只打用户可见契约（答案、结束原因、模型实际收到的 context、盘上产物、trace 序列），不断内部函数。

## 2. 首版（2026-09-14）：真实模型暴露的三个偏差与处置

模型 qwen3-max（DashScope，文本协议模式）。每条都先写红测试（`test/unit/parser.test.ts`「真实模型跑出来的偏差」一节），再改。

| 偏差 | 现象 | 处置 |
|---|---|---|
| 标签别名 | 模型把 `<tool_call>` 写成 Anthropic 风格的 `<invoke>` 或 `<function_call>` | 解析器接受别名并记 warning 进 trace；system prompt 加一条「标签名必须是 tool_call」 |
| 口头「记下了」 | 用户说「记住…」时模型只在 final 里说「已记下」，不调 remember | system prompt 加规则「没有调用就不算记住，不要口头说已记下」+ 一个 one-shot 示例 |
| 外层包裹 | 工具调用外面多套一层 `<tool_code>` | 解析器用全局匹配抓内层 `<tool_call>`，外层忽略 |
| 第四种标签变体（2026-09-15 live 暴露，issue #4） | 原生 function calling 模式下模型没走 `tool_calls`，直接输出 `<function=calculator><parameter=expression>99*99</parameter></function>` | **未修**：解析器不认、当成 final，live「原生 function calling」场景偶发失败。处置留在 issue #4；本轮（#5）不动解析器，报告里按「已知问题」写 |

2026-09-15 live 重跑又暴露两条（issue #3、#4），同样先红测再改：

| 偏差 | 现象 | 处置 |
|---|---|---|
| 搜索措辞抖动（#3） | 模型搜 `上海今天天气`（无空格），语料标题是「上海今日天气」，mock 搜索按空格分词后整串子串匹配 → 没找到 → 模型答「无法获取天气」 | `search.ts` 去停用词后中文按二元组切分、非中文按整词，任一片段命中计分；红测走 `registry.invoke` |
| 第四种标签变体（#4） | `--native-tools` 模式下模型没走 `tool_calls`，直接输出 `<function=calculator><parameter=expression>99*99</parameter></function>`，解析器不认 → 当成裸文本 final → 答案里没有 9801 | 解析器加这一变体：`<function=NAME>` 内的 `<parameter=K>V</parameter>` 收成 arguments（数字/布尔还原类型），记 warning；残缺的 `<function=` / `<parameter=` 判为解析错误回喂而不是 final；system prompt 规则里点名这种写法不要用 |

## 3. 状态机线（2026-09-15，本次）

### 提示

- 入口提示：「看看 issue」。issue #1 是切片清单 S0–S6，正文指向 `docs/SPEC.md` 与 `docs/product/SPEC-state-machines.md`；issue 评论是一份只读审计，给出并入切片的六条行动（README + AI-LOG、文件持久化测试、trace 加 traceId、registry 未知参数 / 枚举越界并让 tools 测试走 `registry.invoke`、显式转移表 + 出口不变量、删掉指向不存在文件的 `serve` 脚本）。
- 依据文档：`docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md`。

### 做了什么

按 S0 → S6 顺序，每片先跑红再补绿：

- S0 `src/machine/interpreter.ts` + `test/unit/machine.test.ts`：参照里的 JS 解释器不在本仓，按 D2 描述的语义（定义期校验、guard 顺序、enumerate、reachable、toContract）用 TS 重写，多加了两点：显式 `kind:'unknown'` 行（供 ③ 表诚实建模）与「无守卫行后面还有行 → 定义期报错」。
- S1/S5 三张表 + `scripts/contracts.ts`（`contracts:gen` / `contracts:check`）+ `test/unit/contracts.test.ts`。
- S2 `src/runtime/agent.ts` 改为 `transition()` 闸；`src/runtime/trace.ts` 改为转移记录。既有 36 条里 3 处 trace 断言按 D4 改写（compact 改看副作用、trace 序列改对答案卷），其余不动。
- S2.5 `test/unit/tools.test.ts` 全部改走 `registry.invoke`，补未知参数、枚举外、默认截断、自定义 compact、重名；删 `serve` 脚本。
- S3 `src/machine/generator.ts` + `test/unit/generator.test.ts`：生成器需要「runtime 在哪个状态发哪些事件」这份知识，表里没有，于是在 `contracts/turn.machine.ts` 里加了 `turnRunnerProtocol`，runtime 与生成器共用；这样生成器还能报出「runner 发得出、表没列」的 gaps。
- S4 `src/machine/invariants.ts` + `test/unit/invariants.test.ts`：四条一红一绿；④ 真落盘。
- S6 本文、`AGENTS.md`、`README.md`、`docs/TEST_REPORT.md`、`docs/NEXT_STEPS.md`、`test/unit/docs.test.ts`。

### 过程中的判断点（规格没写死、AI 自己定的，供作者复核）

1. **compact 挂哪条转移**：压缩发生在第一次模型调用之前，事件表里没有「轮开始」事件（§3 固定 6 个事件）。选择：挂在本轮第一条转移（LLM_OK / LLM_FAILED）的 effects 首位。备选是加 TURN_STARTED 事件，需改 §3。
2. **unknown 的默认处理**：`unknownTransition` 选项，vitest 环境下默认 `throw`（D8「测试模式 = 失败」），否则 `error`（D8「CLI = 记 trace + error 终态」）。unknown 记录的 `to` 写 `error`（runtime 实际去了哪）而 `status` 写 `unknown`。
3. **闸怎么落地**：模型调用与工具执行是「产生事件」的观察，不能在事件之前被解释；真正被闸住的是「事件之后的副作用」——回喂消息、进入工具执行、写历史、存盘。工具只在 `executing_tools` 状态跑，而进入它的唯一通道是 allowed 的 PARSED_TOOL_CALLS，这就是不变量 ① 的实现方式。
4. **重试不建模**：保持 §3 的 facts 只有 `{step, maxSteps}`，重试留在 `callLLM` 内部，trace 上记 `attempts`。列进 NEXT_STEPS。
5. **缺的手写测试**：表里 `deciding --PARSED_ERROR--> max_steps` 没有既有测试覆盖，按「缺项红一次再补」新加了「模型连续输出无法解析的内容直到步数上限」。

### 没有验证的

- 真实模型 5 条 live：本次环境无 key，未跑。`evals/live-trace/` 里的记录是改造前的旧格式。
- 参照 JS 解释器的逐行语义对照：看不到原件，只能对着 D2 的文字描述。

### 工具

本次改动由作者通过 Claude Code 完成，提交带 Co-Authored-By 尾注；判断点与未验证项如上，不把推断写成实跑。
