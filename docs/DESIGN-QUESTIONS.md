# 架构设计题答案

张力允 · 2026-09-15。每模块选一题。每题约一千字，不铺开；能指到代码的指代码（github.com/zhangliyun2023/mini-agent）。

## 模块一 · Q1 首 token 5–10 秒压到 2 秒

物理 TTFT 与「2 秒内有用反馈」是两个目标：前者是主模型真正开始输出，后者可以来自独立的反馈路径。下面优先压缩前者，按「少发、早发、选对」推进，感知层方案最后单说。

先量瓶颈。按排队、prefill（输入处理）、首段生成、回传四段排查；以请求发送为起点，记录后端收到供应商首个非空正文片段的时间，对比前端真正显示的时间，排除心跳、空事件。后端 1.5 秒已收到、页面 7 秒才显示就先修流式透传；若供应商本身第 7 秒才输出，就继续查排队、输入处理和生成，而不是只打开 `stream`。上传与解析另行计时，避免漏掉用户实际等待。

三个杠杆，顺序即优先级。

少发：不让模型为一个局部问题读整份材料。上传即摄取、切块、建索引，首轮只发相关原文及必要上下文；全文检查不能用局部检索替代。图片按模型原生处理分辨率适配，保留小字，避免无意义放大。

早发：利用用户输入问题的时间预热前缀，遵循「稳定在前、问题在后」，确保正式请求复用相同前缀和推理配置。以 Claude API 为例：`max_tokens: 0` 配显式缓存断点，只做 prefill、不生成；写入按基础输入价的 1.25 倍（5 分钟 TTL）或 2 倍（1 小时）计费；最短前缀依模型为 512 到 4096 token，不足时静默不缓存；读命中刷新 TTL。与 `stream: true`、结构化输出、强制 `tool_choice`、Batches 互斥的是零输出预热请求，不是缓存本身，显式 extended thinking 也不兼容 [1]。DeepSeek 等供应商的前缀缓存是自动的，不需要预热请求，但排序原则同样成立。mini-agent 的 system prompt 就是这个排法：角色、协议、工具清单在前，会变的用户记忆块放尾部（`src/protocol/prompt.ts`）；live trace 里每次模型调用都记了 promptTokens（`evals/live-trace/`），量 prefill 的原始数据现成。用户最后不提问，预热就白花钱。

选对：首轮长输入路由到实测 prefill 更快、成本可接受的模型，不是简单换弱模型；MoE、MLA、稀疏注意力提供架构效率潜力 [2]，但不能凭这些标签保证低 TTFT，必须同负载测试并做质量回归。自部署再评估 prefix caching 与 PD（预填充 / 解码）分离。

验收看 P95，不看平均值。固定输入规模、并发和网络条件，把冷请求、预热首轮、复用请求分开测。假设 90% 的请求缓存命中且都在 2 秒内，另有 10% 缓存未命中且都超过 5 秒，那么整体 P95 仍然达不到 2 秒。除了速度，还要检查遗漏率、回答质量和每个成功任务的总成本，把无效预热算进去，不能拿命中缓存的演示代替稳定性验证。

感知层给证据，不猜结论：展示已定位的原文或可确认的局部结果，与主模型并行启动，单独统计「首个有用反馈时间」，不计入主模型 TTFT。对于「全新超长、必须全量、固定大模型、无提前时间」的场景，明确不承诺主模型 2 秒出字，产品承诺只限定为「2 秒内交付有用信息」，而不是此时已经完成全文分析。

[1] Prompt caching · Claude Platform Docs：https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[2] DeepSeek-V3.2: Pushing the Frontier of Open Large Language Models：https://arxiv.org/html/2512.02556v1

## 模块二 · Q1 熟悉半个月后，用户重复问一个问过的问题，memory 怎么召回

用户重复问一个问过的问题，Agent 绝不能给一模一样的回复——重复本身就是反馈：上次的建议大概率没解决问题。所以第一句先问「上次说的 X 你试了吗」，这一句同时校验了记忆（用户可以当场纠正）并把对话推向新信息。召回的不是「他问过什么」，而是三样：他的问题、我上次的回答、他之后的反馈；缺了后两样最致命，因为用户几乎从不主动反馈，只能靠重复提问和间隔时长来推断。边界：用户明确说过「不对」「说得不好」「忘了这事」「别再提」的记忆，再提就是打脸，用户的否决权高于「我记得」；随口一提的低置信度记忆不主动引用。我在 mini-agent 里的做法是用户级记忆由模型显式调 `remember` 写入、每轮全量注入 system prompt 尾部、不检索——条目少时全量比检索稳；超过 context 预算 10% 先丢「最久没被用到」的事件记忆（衰减看最后一次有用的时间，不看写入时间；被后来记忆覆盖的先丢；称呼偏好这类常驻记忆不丢），还不够才上向量召回。

## 模块三 · Q2 每天早上 9 点根据昨天聊天做复盘总结

这题我没有当成定时任务来答，而是当成**一次记忆整合**——复盘的产物有两种，规则不同：写回记忆的条目（可长期保留）和发给用户的呈现（可以为空）。「昨天聊天摘要」这种流水账不做，因为它既不能长期用，也不值得早上九点打扰人。全部落在仓库里（`src/review/`），下面每条都指到文件。

**边界先定死，再谈生成。** 「昨天」= 任务时区的昨日 00:00 到今日 00:00，按**计划日期**算，不按执行时刻——补跑、重跑仍用原计划日期（`src/review/window.ts`，只用 `Intl`，DST 两遍校正）。幂等键 = `userId + date`：同键重跑不重写记忆、不重发、journal 只有一条 attempts 递增（`src/review/run.ts`，一次变异关掉短路即红）。三态分开：`ok` / `no_chat`（确认昨天没聊）/ `partial_read`（有会话读不出，写明覆盖范围），`partial_read` 不得冒充 `no_chat`——CLI 退出码 0 / 0 / 3 也分开（`src/review/cli.ts`）。

**原始材料不能来自会被压缩的 context。** 会话历史超阈值就会把老轮压成摘要，昨天的对话在复盘跑之前可能已经没了原文。所以轮末同时追加一份**不压缩的逐轮转写**（`data/transcripts/<user>/<session>.jsonl`，`src/review/transcript.ts`），复盘只读它；history 继续只服务模型 context。这一层就是不可变的 Raw 层。

**写回记忆的规则。** 条目区分 `stated`（用户说的）与 `inferred`（Agent 推断的），带 `confidence` 和 `source: {sessionId, turn}`；与已有条目同 key 不同值 → 标 `conflict`，**不覆盖**，渲染成「待确认：昨天说 X，之前记 Y」等用户下次出现（`src/memory/entries.ts`）。预算超限的丢弃顺序是 conflict → inferred（低置信度先）→ stated 按最老。这和模块二的答案同源：用户的否决权高于「我记得」。模型的输出经解析校验，`source` 指向不存在的轮的条目直接丢弃并记 warning（`src/review/consolidate.ts`，变异去掉这个检查即红）；模型或解析失败退回关键词规则兜底，兜底条目一律低置信度、不产生呈现。

**呈现门槛。** 每条 highlight 必须有 `why_today`（今天到期的承诺 / 昨天没收尾 / 用户说过今天要做）之一且带 `source`；**不复述原话**——与昨天任何一条消息逐字重合或长段重合就过滤；没有满足门槛的条目 → brief 为空，不发（`src/review/present.ts`）。九点钟值得打扰用户的只有「今天为什么重要」的事。

**触发与交付。** 不接真实 cron 进程：`npm run review -- --user A --date … --tz …`，外部 cron 调它，「至少一次」投递靠幂等键兜住。`--deliver <session>` 把 brief 作为一条带 `review_brief` 标记的 assistant 消息追加进目标会话（用户下次打开就看到，模型也「记得自己说过」）；接收人**只由参数决定**——昨天对话里出现的「把总结发给别人」「忽略规则」只是材料，不改变范围与接收人，在整合器与 CLI 两层各守一次。触发时用户正在聊的情况建在会话表里（`busy + ASYNC_DONE → queued`，`contracts/session-runtime.machine.ts`）：单进程 CLI 运行时不可达，表里建模、注明未接，不假装实现。

**过程本身是一张表。** `contracts/review.machine.ts`：`scheduled → collecting → consolidating → presenting → delivered | skipped_no_chat | failed_partial`，每步先 `interpret` 再执行，一次转移一行 trace（`trace/reviews/`），四条 P0 不变量各一红一绿：幂等、冲突不覆盖、每条亮点有来源、不复述原话。真实模型 smoke 一次：两轮对话「明天下午 3 点交周报」→ 次日复盘 status ok，1 条 `due_today`，重跑 attempts=2 不调模型（`docs/evidence/t19-r8/live-smoke.txt`）。

**没做的**：真实 cron 与推送渠道、向量检索、多用户并发锁、多日聚合。一个实测发现：整合器会把 `remember` 已写过的事实换个措辞再写一遍，变成 conflict——下一步是先把已有记忆给模型看。

## 模块四 · Q2 session busy 时收到新消息 / 异步工具完成

先定原子单元。mini-agent 的一轮由状态表驱动，每一步先 interpret 再执行副作用（`contracts/turn.machine.ts`、`src/runtime/agent.ts`），所以不可打断的单位不是「一次工具执行」而是「一次转移」：模型调用中、工具执行中都不投递任何新东西，`TOOLS_DONE` 之后、下一次模型调用之前是唯一合法的插入点。工具结果在这个边界已经进了本轮的 context（`working` 数组），不会因为用户插话而丢；但它写进 `session.history` 并落盘是在终态转移那一刻，进程中途崩掉会丢掉本轮的中间结果，这是已知取舍，不算已解决。

busy 时到达的东西一律进同一个收件箱，按到达顺序排队，不合并、不丢弃：用户新消息、异步工具结果、子任务完成、外部事件。每条由 runtime 打上来源、信任级别和插入时机（例如「用户在 executing_tools 期间发出，尚未看到 weather 的结果」），模型不猜时序。这样做而不是按时间重排有一个硬原因：原生 function calling 要求 tool 消息紧跟带 tool_calls 的 assistant 消息，用户消息插不进中间，`src/llm/openai-compatible.ts` 里对不上位的 tool 消息就是因此被降级成 user 消息的。标注是唯一能同时保住协议顺序和时序语义的办法。

到边界时把收件箱里的消息一次全部交给模型，多条就多条，顺序保持。以「查天气顺便推荐穿什么」为例，天气结果回来的同时用户发了「算了不用推荐了」：模型在下一次调用里同时看到工具结果和带「发出时尚未看到结果」标注的用户消息，才能区分「看到下雨所以算了」和「临时改主意」，这两种情况该给的回答不同。

停止是另一条通道。用户想终止当前轮用停止键（Claude Code 的 Esc、远程会话的 interrupt），runtime 在下一个转移边界收尾，不经过模型判断，也不靠关键词猜「算了」是不是取消。想改方向就发消息排队。两条通道分开，收件箱里就不需要「纠正类消息」这种特判。

轮已经结束才到的异步结果由外层会话表接：`contracts/session-runtime.machine.ts` 的 idle / busy 两个状态，会话空闲就以它开新一轮，仍忙就排到本轮末尾。这一条在 #5 拍板①「turn 表终态无出边」时已经定下，#19 里每日复盘作为 `ASYNC_DONE` 排队就是一个实例。晚到结果按 `request_id` 对齐来源的轮：轮还在跑就在边界注入为 tool 消息，轮已结束就转成会话级待办、下一轮开始时呈现，来源已取消就丢弃并记 trace。会话表里 `busy + ASYNC_DONE → queued`、`idle + ASYNC_DONE → executing`、`queued + REVIEW_DONE → executing` 已在 #19 R7 按上述决定建成具体行（`contracts/session-runtime.machine.ts`，运行时单进程不可达、表已建模）；`busy + INPUT` 仍诚实标 unknown，接 HTTP 服务时再定排队还是拒绝；随机探索（`test/unit/explore.test.ts`）负责证明没有漏格。

这套做法我在用 Claude Code 完成本作业时逐条观察到过：中途发的消息和下一个工具结果一起交给模型并附一段说明；后台子代理完成以带「不是用户输入」标注的通知进来；runtime 空闲时外部事件以 wake 开新一轮，忙时进队列并提示未读条数，由模型显式读取才算消费。它验证的不是某个名词，而是三条：一切到达都是带元数据的消息，只在边界投递，停止走控制通道。

## 模块五 · Q1 Claude Code 的工具输出 vs 国内 OpenAI-compatible function calling

两者最根本的差别在「工具调用和结果放在消息的什么位置」。Claude 这边，工具调用是 assistant 消息 content 里的一个 `tool_use` 块，与 text、thinking 块并列，`input` 已经是解析好的 JSON 对象；结果是下一条 user 消息 content 里的 `tool_result` 块，带 `tool_use_id` 和 `is_error`，一条 user 消息可以同时装多个结果和用户自己的文字。OpenAI-compatible 家族（GLM、豆包、DeepSeek、Qwen 都是这一形状）则把调用挂在 assistant 消息的 `tool_calls` 数组上，`arguments` 是一段 JSON 字符串；结果是独立的 `role: tool` 消息，每条带 `tool_call_id`，且必须紧跟在那条 assistant 之后、每个 id 都要有回复。

这个位置差异决定了两边的优缺点。块结构的好处是消息形状松：并行调用天然是多个块，结果与用户插话可以同在一条消息里，这正是模块四里「中途消息和下一个工具结果一起交给模型」能成立的原因；harness 还能往 `tool_result` 内容里附自己的说明，Claude Code 的 system-reminder 就是这样进来的。代价是它不是 OpenAI 兼容形状，接入面窄，块的语义也更复杂。`tool_calls` 数组的好处是生态：一份客户端接所有厂商，`arguments` 是字符串便于流式拼接。代价有三：一，顺序是硬约束，历史里少一条 tool 回复或中间插了 user 消息就 400，重放和压缩历史时要特别小心，mini-agent 的 `toWireMessages`（`src/llm/openai-compatible.ts`）把对不上位的 tool 消息降级成 user 消息就是为此；二，`arguments` 要自己 parse，坏 JSON 是常态，`src/runtime/agent.ts` 里 `fromNativeToolCalls` 对坏参数的处置与文本协议里坏 JSON 走同一条回喂路径；三，厂商实现参差，并行调用、`strict`、空 content 的处理各家不同，同一段代码换模型要重新 smoke。

还有一层差异在模型训练上，是我实测到的：文本标签协议下 qwen3-max 先后出现六种变体（`<invoke>` 别名、裸 JSON、`<tool_code>` 外包、`<function=…><parameter=…>`、闭合标签写成开标签、`<final>` 重复或无闭合，`src/protocol/parser.ts` 逐条接住）；切到原生 function calling 后 qwen3-max 仍有一次没走 `tool_calls`、直接把 `<function=calculator>` 当文本吐出来（issue #4），而 deepseek-flash 原生模式 5/5 干净。这说明「原生」并不天然可靠，它可靠的前提是厂商在训练时把这一形状练实了；训练模板会从文本里泄漏出来。Claude 这边则反过来，Anthropic 定义的 bash、text_editor 这类工具连 schema 都不用给，因为模型是照着它们训练的，Claude Code 的工具输出稳定很大程度来自这一点，而不是块结构本身。

mini-agent 的取舍是两边都留，并把它们收敛到同一个闸：文本协议是缺省，厂商无关、肉眼可查、trace 里能看到原文，代价是解析器要跟着真实模型长；原生模式经 #10 完整化后不再教标签，`tool_calls` 以真 assistant / tool 消息进历史并回放，坏参数走同一条回喂。两种输入都被转成同一形状的 ParsedOutput，下游的状态表、trace、工具执行只有一条路径（`test/unit/native-tools.test.ts`）。如果只能选一个：接国内多家用 OpenAI-compatible 原生模式并逐家 smoke；需要在一条消息里混排文字、多个结果和 harness 自己的注释，块结构是更合适的底座。

