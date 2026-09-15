# mini-agent

从零实现的最小可用 Agent Runtime：loop / 工具注册 / 输出解析 / session / context 压缩 / trace。TypeScript，运行时依赖只有 OpenAI SDK（当 HTTP 客户端）。轮循环由状态表驱动，详见 `AGENTS.md`。

## 运行

```bash
npm ci
cp .env.example .env        # 填任意 OpenAI-compatible 的 key；默认端点 DashScope，模型 qwen3-max
npm run chat -- --user A --session w1
```

- 同一 `--user` 开两个不同 `--session` 就是两个窗口，待办与历史互不可见；同一 `--session` 再进即接着聊。
- `--native-tools` 切到厂商原生 function calling；`--quiet` 关掉 trace 回显。
- 会话落在 `data/sessions/`，长期记忆在 `data/memory/`，trace 在 `trace/<session>.jsonl`（均不入库）。
- CLI 里 `/sessions` 列出本用户会话，`/exit` 退出。

## 验证

```bash
npm test                 # 全部单测，不需要 key（条数见 docs/evidence/<label>/2-unit.txt）
npm run check            # typecheck + 契约漂移检查 + 单测
npm run test:live        # 真实模型 5 个 smoke，需要 key
bash scripts/gate.sh v0.2   # 一键门禁，证据落 docs/evidence/v0.2/（无 key 时 live 写 skipped）
```

## 指路

- 入口（七章节）：`AGENTS.md`
- 架构与机器清单：`docs/ARCHITECTURE.md`
- 规格与用户故事：`docs/SPEC.md`
- 状态机线的决定：`docs/product/SPEC-state-machines.md`
- 测试报告（三层分开写）：`docs/TEST_REPORT.md`
- 下一步：`docs/NEXT_STEPS.md`
- AI 协作记录：`AI-LOG.md`
