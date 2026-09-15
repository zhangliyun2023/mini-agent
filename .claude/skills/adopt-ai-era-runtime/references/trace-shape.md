# 转移记录的形状（JSONL，一次 interpret 一行）

```jsonc
{
  "ts": "2026-09-14T13:00:00.000Z",
  "trace_id": "u1/s1/3",          // 一轮；run() 入口生成
  "feature": "turn",
  "step": 2,
  "from": "deciding",
  "to": "executing_tools",
  "event": "PARSED_TOOL_CALLS",
  "status": "allowed",            // allowed | blocked | noop | unknown
  "reason": null,                 // reject_code 或 UNMODELED
  "transition": "t-decide-tools", // 表里的行 id；unknown 为 null
  "effects": [                    // 这条转移触发的外部调用，每个带 request_id
    { "kind": "llm", "request_id": "r-8f2c", "model": "qwen3-max", "ms": 1420, "prompt_tokens": 912, "completion_tokens": 44, "preview": "<think>…" },
    { "kind": "tool", "request_id": "r-9a10", "name": "calculator", "args": { "expression": "2+3" }, "ok": true, "ms": 1, "preview": "5" }
  ]
}
```

规则：

- 终态转移（到 done / max_steps / error）就是「stop」记录，不另记。
- `unknown` 行必须落盘且 `status:"unknown"`，永远不是「没关系」。
- 白名单落盘：密钥不进；用户内容只进 `preview`（截断）；工具 `args` 按工具声明是否可记。
- 能回答的问题：哪个事件把哪个状态变成了哪个状态？这次外部调用属于哪一轮？返回值、盘上历史、trace 是否一致？
