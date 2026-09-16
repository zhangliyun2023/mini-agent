# 已有仓库的切片表（两分支通用）

按表逐片，每片先红后绿、一片一提交。

| 切片 | 用 | 绿 = |
|---|---|---|
| S0 解释器 | `machine-contract`；Web 用脚手架的 `contracts/machine.mjs`，runtime 移植 [`machine.example.ts`](machine.example.ts) | 单测：未列组合 unknown、guard 顺序取首条、定义期校验抛错、enumerate 全表、reachable 无不可达、toContract 同表同输出 |
| S1 第一张表 | `machine-contract`：挑最小的机器（登录页 / 一轮）；契约 JSON 由表生成；建表 checklist 过一遍（runtime 加 [`runtime-mapping.md`](runtime-mapping.md) 的补充） | `contracts:check` 0 漂移；每条 P0 行有 `covered_by` |
| S2 闸 + 打点 | `trace-transitions`：主链副作用先 `interpret` 后执行；trace_id + request_id 贯穿；一次转移一行；镜像组件（runtime：终态字段绑定） | 进程内：三处同 id；真实装配：界面 == 接口 == 库（runtime：返回值 == 盘上 == trace） |
| S2.5 承重面补洞 | 审计指出的“绕过真实路径”的测试改走真实入口 | 每条先红后绿 |
| S3 生成器 + 答案卷 | `model-e2e`：BFS 出场景，生成集合 == 手写覆盖集合；`answer-key`：`contracts/journeys.json` + 判分 | 第一次跑就红出手写套件的遗漏——那是它工作的证据；判分 passed / failed / not_observed 三态 |
| S3.5 随机探索 | `model-e2e`“模型层随机探索”：只用 interpret 和表，几秒 | 零 guard 洞；发现的洞先补表 |
| S4 P0 不变量 + 变异 | `tdd`：每条不变量一条 Given/When/Then；三处对齐用文件实现真落盘；承重的一两条做变异（unknown 谎报成 modeled → 必须红） | 各先红后绿；变异红写进报告 |
| S5 其余影子 | 每台机器先影子，只建表 + 生成契约；没实现的行为标 `kind:'unknown'` | 契约生成；reachable 豁免 unknown 状态 |
| S6 组件层（仅 Web） | Storybook + 同一张表；`test-storybook` 进门禁 | 变异一处（去掉某个 disabled）→ story 红 |
| S7 写死 | `ai-era-setup` 第 6 步 | 守文档测试绿 |

时间边界：约定时点没绿 → 砍 S3/S5/S6 的生成器与文档，只留 S0–S2（表 + 闸），报告里写明。

## 第二层（产品里有 AI 产出）

标准 §16：模型输出带结构化可执行的检查步骤；候选在真实沙箱逐条执行并展示 ✓ / ✗ / □；未过退回修一次再记 `CHECKS_FAILED`；沙箱自身故障记 `skipped`，与 `CHECKS_FAILED` 分开；`CANDIDATE_BROKEN` 与 `CHECKS_FAILED` 分开；坏候选以非 ready 状态展示。
