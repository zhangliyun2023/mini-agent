# WIKI —— 维护者的累积知识

这是给**改 SKILL.md 的维护者**读的累积知识：每一条都是一次真实轨迹（Raw：仓库里的 TEST_REPORT / NEXT_STEPS / AI-LOG / PR 审阅 / issue）沉淀下来的判断，带出处与状态。**执行 agent（做票的）不读这份文件**——它只拿 SKILL.md 与仓库 `AGENTS.md`；派工 prompt 只内联 SKILL.md 相关段，不内联本文件（原因见 `skills/ai-era-maintain/SKILL.md`）。**被拒的提案也留在这里**，标“已拒：原因”，免得下一轮再提一遍。

三层的分工（WikiSkill，arXiv 2608.27454）：Raw 轨迹在各仓库；Wiki（本文件）是跨仓库累积的知识；Skill（`skills/*/SKILL.md`）是当前生效的规则。Wiki → Skill 的通道只有一条：提案 → `evals/PROBES.md` 探针 → 升版，见 `skills/ai-era-maintain/SKILL.md`。

条目格式：`- **一句话** — 出处（仓库 · 提交/PR/issue · 日期）· 状态（已进 skill x.y.z / 待拍板 / 已拒：原因）`。

## A. 失败模式

- **guard 洞集中在六类：请求中重复点击、失败后改输入再提交、键盘重试、外部状态中途变化、事件早到/乱序、RESIZE 全状态** — Web 参照仓 · #17 随机探索 + NEXT_STEPS“板之后”· 2026-09-13 · 已进 1.1.0 `machine-contract` 建表 checklist
- **测试模式全量上报把遥测算进用户写预算，真实 POST 被 429** — Web 参照仓 · TEST_REPORT v0.6 · 2026-09-12 · 已进 `trace-transitions`
- **断言“任意红 toast 可见”收紧成精确文案后发现猜错分支** — Web 参照仓 · PLAYBOOK 反例 · 2026-09-13 · 已进 `honest-evidence`“红必须真红过”
- **“已知基线失败”清单转述自上一轮，4 条是子代理自己引入的** — Web 参照仓 · PLAYBOOK 反例 · 2026-09-13 · 已进 `honest-evidence`“基线只能自己刚跑过”
- **沙箱自身故障被记成模型的 CHECKS_FAILED，铁律写了但没有 oracle 守** — Web 参照仓 · PR #32 审阅 · 2026-09-14 · 已进 1.1.0 `honest-evidence`“独立审阅也是 oracle”
- **做票 agent 基于旧提交开分支，看不到 main 上后加的参考实现，自己重写了解释器** — runtime 参照仓 · PR #2 AI-LOG“看不到原件”· 2026-09-15 · 待处理：派工时写明基线提交（已进 1.2.0 `ai-era`“维护”节的派工要求；`adopt-ai-era` 3.5 未改）
- **真实模型第四种工具调用标签变体 `<function=name><parameter=k>v</parameter></function>`**（此前已有 `<invoke>`、裸 JSON、`<tool_code>` 外包）— runtime 参照仓 · issue #4 · 2026-09-15 · 待修（仓库内；skill 不改）
- **mock 搜索按整串子串匹配，模型措辞“今天”vs 语料“今日”就命中不了** — runtime 参照仓 · issue #3 · 2026-09-15 · 待修（仓库内；skill 不改）
- **工具坑：Storybook 端口被占静默换端口；worktree 的 `.git` 是文件需固定 `TEST_ROOT`；`kill $SB` 留下 dev server** — Web 参照仓 · NEXT_STEPS · 2026-09-14 · 已进 1.1.0 `adopt-ai-era` 3.5
- **探索器抓不到“unknown 行谎报成 allowed”**：allowed 自环不违反通用不变量，只有契约层（盘上 JSON == toContract、declared_unknown 断言）红——变异验证必须同时看契约层与探索层 — runtime 参照仓 · PR #6 B3 · 2026-09-15 · 待进 model-e2e“变异”段
- **“条数单一事实源”闸把并行 agent 逼去绕闸**：四个并行票里三个把新测试放到 `test/unit` 之外的目录躲开条数对账（因为派工禁碰 TEST_REPORT），第四个索性改了条数表——同一个闸、两种绕法。修法：守文档测试按 `test/**` 全量计数，且派工时明说“条数表允许改、报告正文不许改” — runtime 参照仓 · #10–#13 · 2026-09-15 · 待进 agents-md / adopt-ai-era 3.5
- **门禁命令接管道会吞退出码**：`vitest … | grep | head` 的退出码是 head 的，红了照样往下 commit/push；一次真发生（runtime 参照仓 AGENTS 九章节那次，两条红被提交后才发现）。修法：门禁命令单独跑、存 `$?` 再判，或用 gate.sh — runtime 参照仓 · 2026-09-15 · 待进 implement / to-tickets 的提交纪律

- **同一族里两份 skill 对“回退验红”说反话**：`honest-evidence` 说做了 TDD 不再回退验红，`electron-real-machine-verify` 说撤回修复验红是回报最高的纪律；agent 同时加载时只能随机取一个 — ai-era-skills · writing-for-agents 审阅 · 2026-09-15 · 已进 2.0.0 之上未升版：只留 honest-evidence 一处
- **WIKI 层轶事渗进 SKILL.md**（“10 个洞”“PR #32”“实测踩过”等）：出处不改变 agent 行为，只付 token；且违反本文件自己定的“执行者不读 WIKI” — ai-era-skills · writing-for-agents 审阅 · 2026-09-15 · 已进 2.0.0 之上未升版：轶事只留本文件
- **`not_run` 与 `skipped` 曾混写**：Firefox 下载被拦是 not_run（没尝试），WebKit 本机判定跳过是 skipped（尝试了被判跳过） — Web 参照仓 · #25 · 2026-09-13 · 已进 `honest-evidence` 口径表（原在正文括号里，本轮搬来）
- **探针夹具的泄漏比探针本身难做对**：删文件不够，git 历史、SPEC 里的结论段、`docs/standards` 副本都会把答案带进去；agent 会自己坦白读到了什么（三次里两次），所以“读到什么”必须是探针报告的固定一栏 — runtime 参照仓探针 · 2026-09-15 · 已进 PROBES.md
- **子代理调不到手动技能**：`disable-model-invocation: true` 的技能对子代理不存在，P3 三次都自己按问题库过题；拷问必须由主会话做 — 2026-09-15 · 已进 ai-era-setup 第 3 步
- **混合输出（一个 tool_call 好、一个坏）现行为是执行好的那些并回喂错误**：探针 P3-c 读 runtime 参照仓代码指出它与“解析失败不跑工具”的直觉冲突；是否改成“errors 非空就整体回喂”待拍板 — runtime 参照仓 · 2026-09-15 · 待拍板（已记进该仓 NEXT_STEPS）


## B. 成功策略

- **主 seam 一个：`agent.run` + 记录收到消息的脚本化假模型，“模型实际收到的 context”可断言** — runtime 参照仓 · 审计报告 · 2026-09-14 · 已进 `adopt-ai-era-runtime`
- **表说“允许什么”，runner 协议说“runtime 在哪个状态发什么事件”，生成器与 runtime 共用，还能报 gaps** — runtime 参照仓 · PR #2 AI-LOG 判断点 · 2026-09-15 · 待评估是否进 `model-e2e`
- **残缺表测试：从表里抠掉一行，验证闸拦得住（0 副作用、trace 一条 unknown、error 终态、历史仍恰一条 final）** — runtime 参照仓 · PR #2 · 2026-09-15 · 已合并 · 待进 `model-e2e` 当标准做法
- **模型层随机探索几秒红出 10 个 guard 洞，先于真实浏览器探索** — Web 参照仓 · #17 · 2026-09-13 · 已进 1.1.0 `model-e2e`
- **16 票按文件不相交分组、四波 worktree 并行、每票独立报告文件** — Web 参照仓 · NEXT_STEPS · 2026-09-14 · 已进 1.1.0 `adopt-ai-era` 3.5
- **先当一次新用户 + 旅程预算 json，让 E2E 对账真实访客操作数** — Web 参照仓 · 铁律 11 · 2026-09-14 · 已进 1.1.0 `adopt-ai-era` 2.5 / `machine-contract`“旅程预算”
- **并行四票 rebase 冲突只在两处**（`agent.ts` 组 context 三行、`trace.ts` 的 Effect 联合类型），都是“每票各加一种 effect / 一个字段”的同型冲突；合并时按“都保留”解即可。手工解合并有一次把类定义截断（typecheck 抓到）——rebase 后必须重跑 typecheck 再推 — runtime 参照仓 · #15–#18 · 2026-09-15 · 待进 adopt-ai-era 3.5


## C. 提案历史

- **1.1.0 七条改动全部接受，未经探针验证，只凭复盘判断** — ai-era-skills · 提交 30dde23 · 2026-09-14 · 状态：已进 1.1.0，验证欠账（探针定义在 1.2.0 `evals/PROBES.md`，仍未跑）
- **runtime 参照仓 PR #2 agent 自拍的 5 个判断点**：compact 挂在轮首第一条转移的 effects；unknown 在 vitest 下默认抛出、否则 error 终态；闸落在“事件之后的副作用”而非事件本身；重试不建模只记 attempts；缺的手写测试由生成器红出来再补 — runtime 参照仓 · PR #2 AI-LOG · 2026-09-15 · 状态：已合并，待维护者复核是否进 skill
- **对照报告提出的 6 处语义分歧**：终态吸收态 vs 禁止出边；步数上限在解析后 vs 工具后；rejected/noop 词汇 vs 全 allowed 自环；行显式 id vs 派生 id；表外名字抛错 vs 返回 unknown；状态对象 vs 字符串数组 — runtime 参照仓 · 对照报告 · 2026-09-15 · 状态：待拍板（维护者当日讨论中；拍板前 `machine-contract` 不改）
- **对照报告列出的 4 项未做产物**：request_id；白名单落盘 vs answer 全文；journeys.json + 三态判分；随机探索 / 变异 / gate.sh / ARCHITECTURE 机器清单 / not_run 词汇 — runtime 参照仓 · 对照报告 · 2026-09-15 · 状态：待拍板（仓库内欠账，是否要求 `adopt-ai-era-runtime` 切片清单强制含这几项，一并拍）

- **2.0.0 重排：四动词是日常、心得是默认、AGENTS.md 是分发器**——`ai-era` / `setup-ai-era` / `adopt-ai-era` / `adopt-ai-era-runtime` / `agents-md` 合成 `ai-era-setup`（Web / runtime 是分支不是技能），四个动词族化，新增 `ai-era-maintain`，AGENTS.md 加第 9 节“什么时候用哪个 skill”表与版本行 — ai-era-skills · 2026-09-15 · 状态：作者 2026-09-15 提出并进 2.0.0；**未经探针**
- **按 `writing-for-agents` 九条整治自研 skill 的写法**（单一事实源、披露、去轶事、去本机路径、正向表述、指针去重）— ai-era-skills · 2026-09-15 · 状态：已改进 SKILL.md，**未升版**（第 1 条是执行规则改动，按 `ai-era-maintain` §4 须过探针；其余是写法）；探针待跑

## D. 验证结果

- **1.1.0：无探针。** Web 参照仓 三天数字（205 单测、E2E 25 步、Storybook 18、14 张表）是 1.0.0 时期的结果，不能算 1.1.0 的验证 — ai-era-skills · 2026-09-14 · 诚实写明：1.1.0 的七条改动没有任何一条被独立验证过
- **adopt-ai-era-runtime 1.1.0：runtime 参照仓 PR #2 是它第一次被消费**，但 agent 是从 issue 切片清单进的第 2 步，没从第 1 步（审计 → 拷问）完整走过 — runtime 参照仓 · PR #2 · 2026-09-15 · 第 1 步的走法待 P3 探针
- **1.2.0：只加维护基础设施（本文件、`evals/PROBES.md`、`ai-era` 维护节），未改任何执行规则，因此不需要探针；三个探针定义了但未跑** — ai-era-skills · 2026-09-15
- adopt-ai-era-runtime 1.2.0 + issue #5 拍板：runtime 参照仓 PR #6 十片全绿（113 单测、契约 0 漂移、live 5/5 一次）；随机探索三张表零违反、抠行探针 ddmin 缩到 1 步；变异只在契约层红 — 2026-09-15 · 第一次完整消费 A1–C2 切片，未跑探针
- runtime 参照仓 PR #9（移植 epic 分支三提交）：第五条不变量 effectsDeclared 让“表 · 代码 · trace”三者的第三条边可执行；离线 oracle 一跑就点名了 14 个旧格式文件——证据文件也要有版本 — runtime 参照仓 · #8 · 2026-09-15 · 125 单测、live 5/5 afterAll 0 违反
- runtime 参照仓 v0.4：四票并行约 10 分钟各自完成、审阅 + rebase + 合并约 40 分钟；171 单测、live 5/5、judge.py 54 轮全 passed — 2026-09-15

- **2.0.0：无探针。** 结构重排 + 四动词加族内约定段，属执行规则改动，但探针仍只定义未跑；1.1.0 → 2.0.0 之间的每一次升版都未经探针 — ai-era-skills · 2026-09-15
- **2.0.0 探针实跑（2026-09-15，claude-opus / Claude Code 子代理）**：P1 埋洞 2/2 通过（7 与 7–8 次工具调用，两处埋洞都以失败测试 + ddmin 最小序列红出并指到行；附带抓到参照解释器未暴露 `guards`、终态无 noop 行、covered_by 缺行）；P2 口径 3/3 通过（含合流改写口径词后一次；前两次因 §13 原文不在 skill 里把八条全填未知 → 内联后第三次逐条给出等级与理由）；P3 换算 3/3 通过判据（判 runtime 分支、审计逐条 file:line、Q1–Q11 + 第二轮全有决定、切片带红测名、未跑脚手架、未写镜像组件），但夹具两次有泄漏——a 用 `git show HEAD:` 读到被删的决定文档、c 读到 SPEC 里五句结论——b 干净。三个探针均满足“同一版本至少 2 次”。结论：2.0.0 → 2.0.1 是第一次**经探针**的升版
