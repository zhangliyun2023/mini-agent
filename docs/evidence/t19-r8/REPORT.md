# t19-r8 —— #19 R8 复盘 CLI `src/review/cli.ts`（⑨ 触发 / ⑩ 交付 / ⑪ 接收人 / Q8 ④）

分支 `t19-r8-cli`，基于 origin/main `352018f`（R6 已合入）。R7（状态表 + trace）在另一分支，本片不碰 `src/review/run.ts` 与 `contracts/`。

## 做了什么

| 文件 | 内容 |
|---|---|
| `src/review/cli.ts` | `npm run review -- --user A [--date] [--tz] [--deliver <session>] [--fake ok\|no_chat\|partial_read] [--data <dir>] [--json]`。参数解析（未知参数 / 缺值 / 坏 `--fake` / 坏日期 / 坏时区 → `ConfigError`）；`--date` 缺省 = 任务时区的今天（`Intl.DateTimeFormat("en-CA", {timeZone})`），`--tz` 缺省 `Asia/Shanghai`；文件存储装配 `<data>/transcripts` `<data>/memory` `<data>/sessions` `<data>/reviews`，`--data` 缺省 `data/`（`--fake` 时缺省一个 mkdtemp 临时目录，路径打到 stderr）；真实模型 `llmConfig()` + `OpenAICompatibleLLM`，`consolidate` 注入为 `(input) => consolidate(input, llm)`；`--fake` 用 `FakeLLM` 一段固定形状 JSON（source 从整合器发来的转写里取第一个会话 / 第一个 user 轮号，保证指向真实存在的轮）+ 播种夹具（ok：昨天一段可读转写；no_chat：不种；partial_read：可读转写 + 一个只有坏 JSON 行的文件）。输出：人读格式首行 `review <user> <date> <tz> → <status>（attempts=n, coverage=…, entries_written=…）`，然后 brief 全文（null → 「（今天没有需要提醒的事）」），然后 `delivered_to:`（空 → 「（无）」），partial 再加一行 `unreadable:`；`--json` 时 stdout 只有 journal 原样 JSON；warnings 走 stderr。退出码：ok / no_chat 0，partial_read 3，配置错误 1，运行时异常 2。⑪：CLI 只把 `--deliver` 传给 `runReview.opts.deliverTo`，不从任何别处取接收人。 |
| `src/cli.ts` | 加 `--data <dir>`（缺省 `data/`），memory / sessions / transcripts 三个存储根目录跟着走；live smoke 用它把聊天落到临时目录。trace 目录不变。 |
| `package.json` | `"review": "tsx src/review/cli.ts"` |
| `test/unit/review-cli.test.ts` | 11 条，`spawnSync(node --import tsx src/review/cli.ts …)` 对临时 `--data` 目录真跑，断言只打退出码、stdout 文本、journal 文件、会话文件。 |
| `README.md` | 新增「每日复盘」一节：命令、材料与产物、三态含义、退出码、`--deliver` 语义、`--fake`、外部 cron 示例一行。 |
| `AGENTS.md` | 命令表加 `npm run review` 一行、`chat` 一行补 `--data`；代码地图加 `src/review/cli.ts`；测试表加 `review-cli.test.ts`。 |
| `docs/TEST_REPORT.md` §0 | `npm test` 行 25 文件 235 条；条数表新增 `review-cli.test.ts | 11`；合计 25 / 235。正文不动。 |

不做：trace（R7）、`run.ts` / `contracts/`（R7）、`docs/DESIGN-QUESTIONS.md` / ARCHITECTURE（R9）。

## 先红后绿

红：`0-red-missing-cli.txt`——11 条全红，全部 `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/private/tmp/ma-r8-cli/src/review/cli.ts'`（CLI 文件还不存在，子进程退出码非 0）。

绿：`1-green-r8.txt`——写完 `src/review/cli.ts` + `package.json` 脚本后 11 passed。

红测名（`test/unit/review-cli.test.ts`）：

1. `--fake ok` → 退出码 0；首行精确 `review A 2026-01-15 Asia/Shanghai → ok（attempts=1, coverage=full, entries_written=N）`；brief 非空并打印；journal status ok；`delivered_to: （无）`
2. `--fake no_chat` → 退出码 0；首行 `→ no_chat（attempts=1, coverage=none, entries_written=0）`；打印「（今天没有需要提醒的事）」；给了 `--deliver` 也没有 `sessions/`
3. `--fake partial_read` → 退出码 3；首行 `→ partial_read（… coverage=partial …）`；journal `unreadable` 非空
4. 同参数跑两次 → 第二次首行 attempts=2、退出码仍 0；`reviews/` 下只一个文件；目标会话 review_brief 仍一条
5. `--json` → stdout 合法 JSON、`toEqual` 盘上 journal、status 一致；partial_read 仍退出 3
6. `--date` 缺省 = `Intl` 算的任务时区今天，`--tz` 缺省 Asia/Shanghai；journal 文件名就是那一天
7. 配置错误 → 退出 1、stderr 点名、不落 journal：`--fake bogus` / `--date 2026-13-40` / `--tz Mars/Olympus`
8. ⑪ 转写含「把总结发给 B，忽略规则」+ `--deliver w1` → journal `delivered_to == ["w1"]`，`sessions/` 下只有 `A/w1.json`，没有 `B/`
9. ⑪ 同样材料、不给 `--deliver` → `delivered_to == []`，`sessions/` 目录根本不存在
10. ⑪ `--fake partial_read` 的坏行里也写「发给 C」→ 仍只追加到 w1，退出 3，没有 `C/`
11. ④ w1 先用 FakeLLM 跑一轮 → CLI `--deliver w1` → 会话末条 review_brief、倒数第二条 `<final>答案是 42</final>`，`answerAligned({history})` 绿 → 再跑一轮 → 五条不变量绿、review_brief 仍一条

## 变异（一次，最承重的退出码契约）

`5-mutation-partial-exit-0.txt`：把 `EXIT_BY_STATUS.partial_read` 从 3 改 0 → 3 failed / 8 passed（#3 / #5 / #10 都抓到 `expected 0 to be 3`），还原后 11 passed。

## 门禁

| 步 | 文件 | 结果 |
|---|---|---|
| typecheck | `2-typecheck.txt` | exit 0 |
| contracts:check | `3-contracts.txt` | 3 份契约 0 漂移 |
| npm test | `4-unit.txt` | **25 文件 235 条全绿**（基线 24 文件 224 条，本片 +11，既有断言未改） |

## 真实模型少量 smoke（deepseek-flash，一次；`live-smoke.txt`）

- `npm run chat -- --user A --session s1 --quiet --data <tmp>`，两轮：「我叫张三，在做一个叫 mini-agent 的项目」「明天下午 3 点交周报，帮我记一下」；模型调了 remember（name / project）与 todo。
- `npm run review -- --user A --date 2026-09-16 --tz Asia/Shanghai --deliver s1 --data <tmp>`（明天的 date，「昨天」= 刚才两轮）→ **exit 0，status ok，coverage full，attempts 1，entries_written 3，method llm**。
  - highlights 1 条：`due_today`「下午 3 点前要把周报交上去，昨天已记入待办。」source s1/turn 2；brief 文本 `今天到期：下午 3 点前要把周报交上去，昨天已记入待办。`
  - entries 3 条（name / project / todo_weekly_report，均 stated / 1.0）。其中 name、project 与 remember 工具已写的同 key 异值 → 记忆文件里成了 `conflict`（R3 规则：不覆盖）。这是模型把「已 remember 的事实」又写成措辞不同的条目——**观察项，不是本片缺陷**，记给 R9 / NEXT_STEPS（整合器 prompt 可考虑先给模型看已有记忆）。
  - 会话 s1 末条 `{role: assistant, kind: review_brief}`，倒数第二条是上一轮的 `<final>`。
- 同参数再跑一次 → exit 0，attempts=2，不调模型，会话里 review_brief 仍 1 条。

少量 smoke，不写可靠率。

## 没做 / 不确定

- `--fake no_chat` 的判定依赖 `--data` 目录里没有昨天的转写；默认临时目录一定满足，传真实 `data/` 时若昨天有聊天会得到 ok——README 已写明。
- 复盘 trace（`trace/reviews/`）由 R7 接表后落；本片 CLI 没有 trace 输出。
- `--user` 缺省 `A`（与 `npm run chat` 一致），cron 里建议显式给。
