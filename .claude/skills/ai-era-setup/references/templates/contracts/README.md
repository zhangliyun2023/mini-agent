# contracts/ — 状态表是唯一事实源

- `<feature>.machine.mjs`：一张表（states × events → allowed / rejected / noop；未列组合 = unknown）。**改行为先改表。**
- `<feature>.contract.json`、`<feature>.scenarios.json`：生成物。`npm run contracts:sync` 生成，`npm run contracts:check` 漂移即红，不手改。
- `machine.mjs`：唯一解释器（`interpret / enumerate / reachable / toContract`）。别的语言的项目把这四个接口移植过去，语义不变。
- `journeys.json`：答案卷。`node scripts/machine-check.mjs --rows <观察到的转移.jsonl>` 判分；观察行来自浏览器运行时（`machine-client.mjs` 的上报）或你自己的事件表。
- `tests/machines/`：解释器单测 + 契约 oracle（同步、可达性、P0 覆盖锚点、enforced 证据、答案卷首尾相接）。

三种接法：闸（副作用经 dispatch，blocked 就 0 请求）/ 影子（只观察）/ 旅程（跨页一台机器）。词汇与规则见技能 `machine-contract`、`trace-transitions`、`model-e2e`、`answer-key`、`honest-evidence`；入口 `/ai-era-setup`；什么时候用哪个 skill 见 AGENTS.md 第 9 节。
