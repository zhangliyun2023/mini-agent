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

### 2026-09-15 CLI 实测追加：第五、六种偏差（用户 B 场景）

用户没说「记住」，只是自我介绍「在杭州做产品经理的老李，学 Rust，周末想找地方看书」。模型的意愿是对的（think 里写了「称呼、城市、兴趣都该 remember」，发了三个调用），但：

| 偏差 | 现象 | 处置 |
|---|---|---|
| 闭合标签写成开标签 | 第二个调用以 `<tool_call>` 结尾而不是 `</tool_call>`，按闭合标签切的解析器把「记城市 + 搜索」吞成一块坏 JSON，只记了 1/3，搜索没跑 | 解析器改为只认开标签、JSON 靠配平大括号截取；多余的开标签记 warning。复跑：三个调用全部执行 |
| `<final>` 重复开标签 / 无闭合 | `<final><final>…</final>`，答案里漏出标签 | 捕到闭合或文末为止，再剥掉重复标签 |
| 工具没跑照样作答 | 解析错误回喂后，模型没有重发搜索，直接编了三家杭州书店 | prompt 加规则「回喂后重发全部调用；工具没成功就不要给依赖工具结果的答案」。复跑：模型改口「搜索没返回具体结果，根据常见推荐…」——诚实了，但仍给了建议，属模型层，只 smoke 不写可靠率 |

两个偏差都复现了两次（同一模型、同一句话），不是偶发。红测在 `parser.test.ts`「用户 B 场景」一节。

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

- 真实模型 5 条 live：实现会话无 key 未跑；之后各批实跑结果、trace 位置与旧格式记录的删除以 `docs/TEST_REPORT.md` §3 为准（本段不再另写结论）。
- 参照 JS 解释器的逐行语义对照：看不到原件，只能对着 D2 的文字描述。

## 4. 移植 epic 分支三提交（issue #8，2026-09-15）

epic 分支 `claude/epic-cerf-44n1c4` 上审计后补的三个提交与 #6 冲突，不能 cherry-pick；按其 diff 当设计来源，在 main 的形状上重做，每片先红后绿、一片一个提交（红的输出在提交正文与 `docs/TEST_REPORT.md` §8）：

1. 第五条 P0 不变量 `effectsDeclared`：记录上的 `effects[].kind` ⊆ 记录 `transition` 行 id 命中行声明的 `effects`，compact 只在轮首；按行 id 找行（不按 from/event/to），对 noop / blocked 记录同样成立；一红一绿 + 反向红（删表上声明 → 真实记录不合账）；生成器 10 条路径过五条。
2. `src/machine/evidence.ts`：读 JSONL 按 trace_id 分轮过 ① ② ③ ⑤ + unknown 点名（④ 要返回值与盘上历史，只凭 trace 判不了）；离线过仓库里的 live 记录，live 收尾 afterAll 也过。#6 之前的旧格式记录（05-24 / 05-25）过不了检查（行 id 不存在），删除。
3. 条数单一事实源：只写在 TEST_REPORT §0 一张表，`docs.test.ts` 用源码 `it(` 静态计数（`it.each` 行 `// ×N`）逐文件对账；AGENTS / README 不写总数；本文 §3 与 SPEC-state-machines §9 过期的 live 结论改为引用。

判断点：「全 allowed」的断言一律写成「无 unknown」并断「有 noop」——LLM_OK 在 #6 之后是 noop 行，真实 trace 里必有 noop，「全 allowed」在新形状下永远是假的。

### 工具

本次改动由作者通过 Claude Code 完成，提交带 Co-Authored-By 尾注；判断点与未验证项如上，不把推断写成实跑。

## 5. 方法论回流（Wiki 层，2026-09-15）

这个仓库不只是被方法论指导，也反过来改了方法论。做法参考 WikiSkill（arXiv 2608.27454）的三层：**Raw**（不可变轨迹：trace JSONL、`docs/evidence/`、TEST_REPORT 各轮「红过什么」、本文 §3 的判断点、issue #1 / #5 / #8 的拍板）→ **Wiki**（跨轮累积的失败模式、成功策略、提案历史含被拒项、验证结果：`.claude/skills/adopt-ai-era-runtime/WIKI.md`）→ **Skill**（当前生效的规则：`.claude/skills/adopt-ai-era-runtime/SKILL.md`，版本见 frontmatter）。

规则：**做票的 agent 不读 Wiki**，只拿 issue + SKILL.md + AGENTS.md——否则它直接照抄，轨迹就没有信息量；Wiki 由维护者在 PR 审阅之后写，再决定哪些提案进 skill。本仓三个 PR（#2 / #6 / #9）都是这么跑的。

从本仓长出来、已写回 skill 的四条：

| 来源 | 写回了什么 |
|---|---|
| PR #2 的 agent 没看到参考实现，自己重写了解释器，禁止了终态出边 | skill 的 checklist「终态吸收态」改为「终态无出边，轮后事件由外层机器接」；参考表 `turn.machine.example.ts` 的步数上限从解析后挪到工具后（与实现一致） |
| 对照报告把「和参考长得不一样」当缺陷 | S0 行写明「参考实现语义是契约、字段形状不是」 |
| PR #6 变异验证：unknown 谎报 allowed 只在契约层红、探索层不红 | 变异验证必须同时看契约层与探索层 |
| PR #9 离线 oracle 一接上就点名了 14 个旧格式 trace 文件 | 证据文件也要有版本，格式一变旧证据就是假阳性 |

未经验证的部分如实写：skill 的探针（`evals/PROBES.md`）只定义没跑，所以这些回流是「维护者判断」，不是「探针通过」。
