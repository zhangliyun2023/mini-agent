# AI-LOG — AI 协作记录

如实记录：用了什么提示、AI 做了什么、真实模型暴露了什么问题、怎么处置、哪些没有验证。

## 0. 人拍的板在哪（先看这一段）

这个仓库的代码大部分由 AI 在规格下写出，判断不是。要看人做了什么决定，去四处：`docs/SPEC.md`“实现决策”表（语言、协议、工具选型、session 两层、context 放什么）；`docs/product/SPEC-state-machines.md` D1–D11（闸 / 表 / 不变量 / 打点 / 不做什么）；GitHub issue #5 的拍板表①–⑤（终态无出边、步数上限在工具后、answer 全文进 trace 的取舍）；本文 §2 六种真实模型偏差的处置与 §3“agent 自己拍的判断点”——后者单独列出正是为了让人复核，其中两条后来被人改了口径（见 §5）。评审如果只想验一件事：把 §3 的判断点和 issue #5 的拍板对着看，能看出哪些是 AI 提议、哪些是人否决或改写的。

## 1. 协作方式

- 规格先行：`docs/SPEC.md` 与 `docs/product/SPEC-state-machines.md` 由作者写定并确认，AI 按规格实现；规格改动时代码随之改。
- 测试先行：每个 seam 先写红测试再实现；真实模型暴露的偏差先补红测试再改解析器 / prompt。
- 断言只打用户可见契约（答案、结束原因、模型实际收到的 context、盘上产物、trace 序列），不断内部函数。

## 2. 首版（2026-09-14）：真实模型暴露的三个偏差与处置

模型 qwen3-max（DashScope，文本协议模式）。每条都先写红测试（`test/unit/parser.test.ts`“真实模型跑出来的偏差”一节），再改。

| 偏差 | 现象 | 处置 |
|---|---|---|
| 标签别名 | 模型把 `<tool_call>` 写成 Anthropic 风格的 `<invoke>` 或 `<function_call>` | 解析器接受别名并记 warning 进 trace；system prompt 加一条“标签名必须是 tool_call” |
| 口头“记下了” | 用户说“记住…”时模型只在 final 里说“已记下”，不调 remember | system prompt 加规则“没有调用就不算记住，不要口头说已记下”+ 一个 one-shot 示例 |
| 外层包裹 | 工具调用外面多套一层 `<tool_code>` | 解析器用全局匹配抓内层 `<tool_call>`，外层忽略 |
| 第四种标签变体（2026-09-15 live 暴露，issue #4） | 原生 function calling 模式下模型没走 `tool_calls`，直接输出 `<function=calculator><parameter=expression>99*99</parameter></function>` | **未修**：解析器不认、当成 final，live“原生 function calling”场景偶发失败。处置留在 issue #4；本轮（#5）不动解析器，报告里按“已知问题”写 |

2026-09-15 live 重跑又暴露两条（issue #3、#4），同样先红测再改：

| 偏差 | 现象 | 处置 |
|---|---|---|
| 搜索措辞抖动（#3） | 模型搜 `上海今天天气`（无空格），语料标题是“上海今日天气”，mock 搜索按空格分词后整串子串匹配 → 没找到 → 模型答“无法获取天气” | `search.ts` 去停用词后中文按二元组切分、非中文按整词，任一片段命中计分；红测走 `registry.invoke` |
| 第四种标签变体（#4） | `--native-tools` 模式下模型没走 `tool_calls`，直接输出 `<function=calculator><parameter=expression>99*99</parameter></function>`，解析器不认 → 当成裸文本 final → 答案里没有 9801 | 解析器加这一变体：`<function=NAME>` 内的 `<parameter=K>V</parameter>` 收成 arguments（数字/布尔还原类型），记 warning；残缺的 `<function=` / `<parameter=` 判为解析错误回喂而不是 final；system prompt 规则里点名这种写法不要用 |

### 2026-09-15 CLI 实测追加：第五、六种偏差（用户 B 场景）

用户没说“记住”，只是自我介绍“在杭州做产品经理的老李，学 Rust，周末想找地方看书”。模型的意愿是对的（think 里写了“称呼、城市、兴趣都该 remember”，发了三个调用），但：

| 偏差 | 现象 | 处置 |
|---|---|---|
| 闭合标签写成开标签 | 第二个调用以 `<tool_call>` 结尾而不是 `</tool_call>`，按闭合标签切的解析器把“记城市 + 搜索”吞成一块坏 JSON，只记了 1/3，搜索没跑 | 解析器改为只认开标签、JSON 靠配平大括号截取；多余的开标签记 warning。复跑：三个调用全部执行 |
| `<final>` 重复开标签 / 无闭合 | `<final><final>…</final>`，答案里漏出标签 | 捕到闭合或文末为止，再剥掉重复标签 |
| 工具没跑照样作答 | 解析错误回喂后，模型没有重发搜索，直接编了三家杭州书店 | prompt 加规则“回喂后重发全部调用；工具没成功就不要给依赖工具结果的答案”。复跑：模型改口“搜索没返回具体结果，根据常见推荐…”——诚实了，但仍给了建议，属模型层，只 smoke 不写可靠率 |

两个偏差都复现了两次（同一模型、同一句话），不是偶发。红测在 `parser.test.ts`“用户 B 场景”一节。

## 3. 状态机线（2026-09-15，本次）

### 提示

- 入口提示：“看看 issue”。issue #1 是切片清单 S0–S6，正文指向 `docs/SPEC.md` 与 `docs/product/SPEC-state-machines.md`；issue 评论是一份只读审计，给出并入切片的六条行动（README + AI-LOG、文件持久化测试、trace 加 traceId、registry 未知参数 / 枚举越界并让 tools 测试走 `registry.invoke`、显式转移表 + 出口不变量、删掉指向不存在文件的 `serve` 脚本）。
- 依据文档：`docs/standards/2026-09-01-ai时代软件状态机测试与可观测性.md`。

### 做了什么

按 S0 → S6 顺序，每片先跑红再补绿：

- S0 `src/machine/interpreter.ts` + `test/unit/machine.test.ts`：参照里的 JS 解释器不在本仓，按 D2 描述的语义（定义期校验、guard 顺序、enumerate、reachable、toContract）用 TS 重写，多加了两点：显式 `kind:'unknown'` 行（供 ③ 表诚实建模）与“无守卫行后面还有行 → 定义期报错”。
- S1/S5 三张表 + `scripts/contracts.ts`（`contracts:gen` / `contracts:check`）+ `test/unit/contracts.test.ts`。
- S2 `src/runtime/agent.ts` 改为 `transition()` 闸；`src/runtime/trace.ts` 改为转移记录。既有 36 条里 3 处 trace 断言按 D4 改写（compact 改看副作用、trace 序列改对答案卷），其余不动。
- S2.5 `test/unit/tools.test.ts` 全部改走 `registry.invoke`，补未知参数、枚举外、默认截断、自定义 compact、重名；删 `serve` 脚本。
- S3 `src/machine/generator.ts` + `test/unit/generator.test.ts`：生成器需要“runtime 在哪个状态发哪些事件”这份知识，表里没有，于是在 `contracts/turn.machine.ts` 里加了 `turnRunnerProtocol`，runtime 与生成器共用；这样生成器还能报出“runner 发得出、表没列”的 gaps。
- S4 `src/machine/invariants.ts` + `test/unit/invariants.test.ts`：四条一红一绿；④ 真落盘。
- S6 本文、`AGENTS.md`、`README.md`、`docs/TEST_REPORT.md`、`docs/NEXT_STEPS.md`、`test/unit/docs.test.ts`。

### 过程中的判断点（规格没写死、AI 自己定的，供作者复核）

1. **compact 挂哪条转移**：压缩发生在第一次模型调用之前，事件表里没有“轮开始”事件（§3 固定 6 个事件）。选择：挂在本轮第一条转移（LLM_OK / LLM_FAILED）的 effects 首位。备选是加 TURN_STARTED 事件，需改 §3。
2. **unknown 的默认处理**：`unknownTransition` 选项，vitest 环境下默认 `throw`（D8“测试模式 = 失败”），否则 `error`（D8“CLI = 记 trace + error 终态”）。unknown 记录的 `to` 写 `error`（runtime 实际去了哪）而 `status` 写 `unknown`。
3. **闸怎么落地**：模型调用与工具执行是“产生事件”的观察，不能在事件之前被解释；真正被闸住的是“事件之后的副作用”——回喂消息、进入工具执行、写历史、存盘。工具只在 `executing_tools` 状态跑，而进入它的唯一通道是 allowed 的 PARSED_TOOL_CALLS，这就是不变量 ① 的实现方式。
4. **重试不建模**：保持 §3 的 facts 只有 `{step, maxSteps}`，重试留在 `callLLM` 内部，trace 上记 `attempts`。列进 NEXT_STEPS。
5. **缺的手写测试**：表里 `deciding --PARSED_ERROR--> max_steps` 没有既有测试覆盖，按“缺项红一次再补”新加了“模型连续输出无法解析的内容直到步数上限”。

### 没有验证的

- 真实模型 5 条 live：实现会话无 key 未跑；之后各批实跑结果、trace 位置与旧格式记录的删除以 `docs/TEST_REPORT.md` §3 为准（本段不再另写结论）。
- 参照 JS 解释器的逐行语义对照：看不到原件，只能对着 D2 的文字描述。

## 4. 移植 epic 分支三提交（issue #8，2026-09-15）

epic 分支 `claude/epic-cerf-44n1c4` 上审计后补的三个提交与 #6 冲突，不能 cherry-pick；按其 diff 当设计来源，在 main 的形状上重做，每片先红后绿、一片一个提交（红的输出在提交正文与 `docs/TEST_REPORT.md` §8）：

1. 第五条 P0 不变量 `effectsDeclared`：记录上的 `effects[].kind` ⊆ 记录 `transition` 行 id 命中行声明的 `effects`，compact 只在轮首；按行 id 找行（不按 from/event/to），对 noop / blocked 记录同样成立；一红一绿 + 反向红（删表上声明 → 真实记录不合账）；生成器 10 条路径过五条。
2. `src/machine/evidence.ts`：读 JSONL 按 trace_id 分轮过 ① ② ③ ⑤ + unknown 点名（④ 要返回值与盘上历史，只凭 trace 判不了）；离线过仓库里的 live 记录，live 收尾 afterAll 也过。#6 之前的旧格式记录（05-24 / 05-25）过不了检查（行 id 不存在），删除。
3. 条数单一事实源：只写在 TEST_REPORT §0 一张表，`docs.test.ts` 用源码 `it(` 静态计数（`it.each` 行 `// ×N`）逐文件对账；AGENTS / README 不写总数；本文 §3 与 SPEC-state-machines §9 过期的 live 结论改为引用。

判断点：“全 allowed”的断言一律写成“无 unknown”并断“有 noop”——LLM_OK 在 #6 之后是 noop 行，真实 trace 里必有 noop，“全 allowed”在新形状下永远是假的。

### 工具

本次改动由作者通过 Claude Code 完成，提交带 Co-Authored-By 尾注；判断点与未验证项如上，不把推断写成实跑。

## 5. 方法论回流（Wiki 层，2026-09-15）

这个仓库不只是被方法论指导，也反过来改了方法论。做法参考 WikiSkill（arXiv 2608.27454）的三层：**Raw**（不可变轨迹：trace JSONL、`docs/evidence/`、TEST_REPORT 各轮“红过什么”、本文 §3 的判断点、issue #1 / #5 / #8 的拍板）→ **Wiki**（跨轮累积的失败模式、成功策略、提案历史含被拒项、验证结果：`.claude/skills/ai-era-setup/WIKI.md`）→ **Skill**（当前生效的规则：`.claude/skills/ai-era-setup/SKILL.md`，2.0.0 起五个入口合一、四个日常动词族化，版本见 frontmatter）。

规则：**做票的 agent 不读 Wiki**，只拿 issue + SKILL.md + AGENTS.md——否则它直接照抄，轨迹就没有信息量；Wiki 由维护者在 PR 审阅之后写，再决定哪些提案进 skill。本仓三个 PR（#2 / #6 / #9）都是这么跑的。

从本仓长出来、已写回 skill 的四条：

| 来源 | 写回了什么 |
|---|---|
| PR #2 的 agent 没看到参考实现，自己重写了解释器，禁止了终态出边 | skill 的 checklist“终态吸收态”改为“终态无出边，轮后事件由外层机器接”；参考表 `turn.machine.example.ts` 的步数上限从解析后挪到工具后（与实现一致） |
| 对照报告把“和参考长得不一样”当缺陷 | S0 行写明“参考实现语义是契约、字段形状不是” |
| PR #6 变异验证：unknown 谎报 allowed 只在契约层红、探索层不红 | 变异验证必须同时看契约层与探索层 |
| PR #9 离线 oracle 一接上就点名了 14 个旧格式 trace 文件 | 证据文件也要有版本，格式一变旧证据就是假阳性 |

未经验证的部分如实写：skill 的探针（`evals/PROBES.md`）只定义没跑，所以这些回流是“维护者判断”，不是“探针通过”。

## 6. 原生 function calling 完整化（issue #10，2026-09-15）

### #4 的根源

#4 的现象是 `--native-tools` 下模型没走 `tool_calls`，直接吐 `<function=calculator><parameter=expression>99*99</parameter></function>` 文本。当时的处置是解析器加第四种别名——治了症状。根源在 runtime 给模型的两条指令互相打架：

- system prompt 不分模式，原生模式下照样教“每次回复必须严格使用 `<think>` / `<tool_call>` / `<final>` 标签格式”并把工具 Schema 列在 prompt 里；
- 同一请求的 `tools` 字段又告诉模型“用 function calling”。

模型在两套工具协议之间二选一，偶发选了文本那套（Qwen 系的文本工具调用格式恰好就是 `<function=…><parameter=…>`）。此外 `toWireMessages` 把两种模式的工具结果都降级成 `[工具 … 的结果]` 前缀的 user 消息，历史里从来没有真的 `assistant.tool_calls` / `tool` 消息，模型也就看不到“上一步是走 function calling 做的”这个示范。

### 这次改法（每片先红后绿，红的输出在提交正文与 `docs/evidence/t10/REPORT.md`）

1. `LLMClient` 加 `toolMode`（`OpenAICompatibleLLM` 传 `nativeTools` 即 native；`FakeLLM` 加 `{ native: true }`）。`buildSystemPrompt` 按模式出两份：原生模式只有角色 + 行为规则（calculator / remember / 追问 / 不编造）+ 记忆块，不含任何标签与 Schema，工具只经 API `tools` 字段给。文本模式 prompt 一字未动。
2. `ChatMessage` 加可选 `toolCalls`（id / name / 原始 arguments 串）；runtime 在原生模式下把厂商的 `tool_calls` 直接转成统一的 `ParsedOutput`（坏 JSON 的 arguments 与文本协议一样记 errors 回喂），本轮 assistant 消息带 `toolCalls`，工具结果的 `toolCallId` 用厂商 id，最终答案不套 `<final>`。trace 的 llm effect 加 `mode`。
3. `toWireMessages` 原生模式原样回放 `assistant.tool_calls` + `role=tool/tool_call_id`；对不上 id 的 tool 消息（解析错误回喂、文本模式遗留历史）仍降级为 user 免 400。文本模式仍全部降级。
4. 压缩：摘要转写补上 `toolCalls`，规则兜底按 `toolCalls` 识别工具调用消息。

解析器的 `<function=…>` 别名保留：原生模式下模型若仍把调用写成文本，`nativeToolCalls` 为空时依旧走同一个解析器，#4 的兜底没有拆。

### 真实模型

DeepSeek `deepseek-flash`，只跑一次（`docs/evidence/t10/4-live.txt`）：5/5 场景过，原生场景的 trace（`evals/live-trace/2026-09-15-07-52-native/native.jsonl`）两条 llm effect 都是 `mode: "native"`，第一步 `outputPreview` 是 `[tool_call calculator {"expression": "99*99"}]`（模型走了 `tool_calls`，不是文本）。仍是少量 smoke，不写可靠率。

### 没做

- 混合历史（同一会话先文本模式后原生模式）：不在本票，映射层对 id 对不上的 tool 消息降级为 user 是兜底，没有测试证明它在混合历史下的行为。
- `test/native/native-tools.test.ts` 放在 `test/native/` 而非 `test/unit/`：`docs.test.ts` 的 §0 条数表以 `docs/TEST_REPORT.md` 为单一事实源，本票不改该文件；下一次改 TEST_REPORT 时应把这 8 条并入表并搬回 `test/unit/`。

## 7. 每日复盘 = 记忆整合（issue #19，2026-09-15）

架构题模块三 Q2 没有只写答案，直接落地，答案指到文件。issue 由作者写定 ①–⑪ 拍板；开工前用设计树拷问一轮，找出三处内部矛盾（⑦“排队”与“独立进程”打架；预算丢弃顺序与 #12 不一致；复盘读会被压缩的 history），作者拍板 Q1–Q9（材料来自不压缩的转写、记忆统一为条目、⑦ 只建表、复盘 trace 单独目录、丢弃顺序 conflict → inferred → stated 最老、兜底关键词去“要”、交付追加 `review_brief`、词汇表新增八个词）。

执行：共享类型先定在 issue 评论里，九片分四波、每波并行各占一个 worktree（R1 转写 / R3 条目 / R2 取数 / R5 呈现 → R4 整合 / R6 编排 → R7 表 / R8 CLI → R9 文档）。每片先红后绿、对最承重的不变量各做一次变异；审阅者逐个 rebase、解冲突、把测试并入 `test/unit`、同步条数表后合并。冲突集中在两处：`AGENTS.md` / `TEST_REPORT.md` 的表行（每片各加一行）和 `src/review/types.ts`（四片各建一份相同内容，以先入为准）。

真实模型 smoke 两次（R4 一次、R8 一次，deepseek-flash）：两轮对话“明天下午 3 点交周报”→ 次日复盘 `ok`，3 条 stated + 1 条 `due_today`，重跑 attempts=2 不调模型。发现一条真问题：整合器把 `remember` 已记的事实换措辞再写，成了 conflict（NEXT_STEPS 第一条）。

agent 自己拍的、供作者复核的判断点：R2 把“有行 ts 读不出”也算 partial（比 issue ⑥ 多一格）；R6 把任何已存在的 journal 都当已定不补跑；R7 的守卫是 `coverageNone / nothingReadable / coveragePartial` + 兜底而不是三个互斥守卫（否则探索器报洞）；R7 交付发生在 `DELIVERED` 被解释之前（与工具在 `TOOLS_DONE` 之前执行同法）；R8 `--fake` 默认用临时目录。

## 8. 架构题模块一：我改了 AI 的哪些说法（2026-09-15）

题目注意事项说“用大模型帮助思考，不是帮你完成”。这题的过程正好能说明区别。答案在 `docs/DESIGN-QUESTIONS.md` 模块一。

- 第一稿是我写的，有两处错：把 vLLM 的 chunked prefill 理解成“看完半篇先回答”（它是与其他请求 decode 交错的调度策略，对单请求 TTFT 基本无益）；把“前端先出动效”当成最快落地方案，还引了一个没有出处的满意度数据。AI 指出了这三点。
- AI 说 `max_tokens: 0` 预热缓存“不确定，要查”。我去查了 Claude 文档：预热是真的，但与 `stream`、结构化输出、强制 `tool_choice`、Batches 互斥的是零输出预热请求本身，不是缓存，显式 extended thinking 也不兼容。这一条比 AI 最初的表述精确，是我纠正了它。
- “先量瓶颈”提到杠杆之前、“排除心跳和空事件”、“上传与解析另行计时”三处不在 AI 给的骨架里，是我自己加的；“选对”不等于换弱模型、必须做质量回归，也是我坚持的表述。
- 从两千五百字砍到约一千字：删掉 Nginx 细节、`detail: low` 论证、快慢双路的大部分、两张表和六条引用。保留的每句都能指到文档或代码。AI 建议的三条可删句我最后保留了，理由是评审读到的是密度不是水分。

配图 `docs/evidence/` 之外另有一张用 Archify 画的泳道图，是 AI 按定稿骨架生成、经 Archify 自己的校验与浏览器检查通过的，只作讲解用，不是答案的一部分。

## 9. 架构题模块四：判断是我的，文字是 AI 起草的（2026-09-15）

这题和模块一相反：文字由 AI 按我定下的判断起草，我审阅后放入 `docs/DESIGN-QUESTIONS.md`。记下判断的归属：

- 我否决了 AI 的一条建议：AI 提出 busy 期间多条用户消息“合并为一条”，我认为应按到达顺序逐条排队、各带插入时机，合并会揉掉用户的多个意图。定稿按我的。
- 我提出以 Claude Code 为参照：它把中途消息、子代理完成、外部事件统一当作带元数据的消息在边界投递，停止走 Esc / interrupt 的控制通道。这些是我在用它完成本作业时观察到的，不是引用。
- AI 补的两处硬事实我核过：原子单元是“一次转移”而不是“一次工具执行”；工具结果进内存 context 立即、落盘在轮末，二者要分开说。
- AI 另提醒不要写“interrupt annotation 是业界正式名称”“标准答案”这类词，我同意，改为“插入时机元数据”。

## 10. 架构题模块五：素材来自代码与 live 记录，文字由 AI 成文（2026-09-15）

这题的判断材料几乎全部已在仓库里：文本协议的六种实测变体（`src/protocol/parser.ts`、本文 §2）、原生模式完整化（#10、`src/llm/openai-compatible.ts`）、qwen3-max 原生模式吐文本的 live 记录（#4）、deepseek-flash 原生 5/5。AI 做的是把这些事实和 Claude 侧 `tool_use` / `tool_result` 块结构的文档事实并列成文；“原生是否可靠取决于厂商训练把这一形状练实了没有，训练模板会从文本里泄漏”这个结论由 #4 与 #10 的对照直接推出。我审阅后放入 `docs/DESIGN-QUESTIONS.md`。

## 11. 架构题配图：AI 用 archify 画，我定内容取舍（2026-09-16）

五张图（`docs/diagrams/`）的内容全部来自 `docs/DESIGN-QUESTIONS.md` 五个答案，不新增判断。AI 负责把答案转成 archify 的 Typed JSON，并按其 SKILL.md 的 validate → deliver → visual-check 三道跑到零诊断；过程中改的是布局（换道、改路由、缩 viewBox、删长句），不是结论。两处由我拍板的取舍：模块三不把 `conflict` 画成状态机节点（它是记忆条目状态，不是 `review.machine.ts` 的状态）；archify 只当作画图工具，不装进仓库的 skill 或依赖，只放图和 JSON。

## 12. 架构题三、四、五按模块二的行文重写（2026-09-16）

我看过五篇后觉得模块三（另一个 agent 成文）和四、五（AI 起草）像 PR 描述：加粗领句、箭头、文件名太密、“代价有三：一、二、三”这类句式。我让 AI 照模块二（其次模块一）的写法重写这三篇：开头先给判断，再说为什么，边界单独说，最后说我在 mini-agent 里怎么做和没做什么；不加粗、不用箭头、少列文件、用第一人称。判断和事实一条没改，改的只是说法。文字仍是 AI 改写的，这一点照旧记在这里。
