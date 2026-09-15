# 架构设计题答案

张力允 · 2026-09-15。每模块选一题。每题一段，不铺开；能指到代码的指代码（github.com/zhangliyun2023/mini-agent）。

## 模块一 · Q1 首 token 5–10 秒压到 2 秒

【待写】

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

【待写】

## 模块五 · Q1 Claude Code 的工具输出 vs 国内 OpenAI-compatible function calling

【待写】
