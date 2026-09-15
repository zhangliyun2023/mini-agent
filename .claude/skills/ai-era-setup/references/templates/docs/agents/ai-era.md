# AI 时代体系：这个仓库的接入点

由 `/ai-era-setup` 生成。规则原文见技能 `machine-contract` / `trace-transitions` / `model-e2e` / `answer-key` / `honest-evidence`；入口 `/ai-era-setup`；什么时候用哪个 skill 见 AGENTS.md 第 9 节。

## 铁律（改行为前必读）

1. **`contracts/<feature>.machine.mjs` 是唯一事实源**：改任何用户可见行为先改表 → `npm run contracts:sync` → 再动代码。`*.contract.json` / `*.scenarios.json` 是生成物，不手改；`npm run contracts:check` 漂移即红。
2. **闸 / 影子 / 旅程**三种接法不混：闸的副作用必须经 `dispatch`，blocked 就 0 请求；影子只观察；旅程跨页一台机器（状态与 trace_id 持久化）。新页面先影子再升闸。
3. **未列出的 (状态, 事件) = unknown，永远可观测**：测试模式 unknown = 失败；生产只记录不拦。处理是补表，不是删断言。
4. **一次意图一个 `trace_id`，一次请求一个 `request_id`**，两个 id 落到每一行；新意图 = 离开初始状态 或 行上 `effects.intent`。
5. **对答案只看两样**：`contracts/journeys.json`（期望序列）+ 页面上的镜像组件 `[data-machine-state] [data-machine=<feature>]`。只有镜像组件与机器的绑定需要看源码核对。
6. **先红后绿；断言落在用户可见契约**（文案、焦点、请求次数、Cookie、URL、DOMRect、computed style、接口返回、DB 行、后台日志）。
7. **报告口径**：已验证（真实装配）/ 已验证（进程内）/ demo / harness 自测 / skipped·not_observed·unknown——后三者都不是通过。

## 门禁

```bash
npm run test:machines        # 解释器 + 契约 oracle + 答案卷首尾相接
npm run contracts:check      # 表 ↔ 生成物 无漂移
node scripts/machine-check.mjs --rows <observed.jsonl>   # 对答案（或 --db <sqlite>）
```

把它们接进你现有的 lint / test / e2e 门禁链，顺序固定。

## 地图

| 要做的事 | 看 |
|---|---|
| 状态表、解释器、答案卷、生成物 | `contracts/`（`contracts/README.md`） |
| 浏览器运行时（dispatch → 上报）、镜像组件、输入来源 | `src/machines/`（或 setup 时选的目录） |
| 同步 / 生成 / 判分 | `scripts/contracts-sync.mjs`、`scripts/machine-scenarios.mjs`、`scripts/machine-check.mjs` |
| 测试 | `tests/machines/` |

## example

`contracts/example.machine.mjs` 是示例表（表单提交的生命周期），只为证明整条链跑通；第一张真实表建好后删掉它和 `journeys.json` 里的 example 旅程。
