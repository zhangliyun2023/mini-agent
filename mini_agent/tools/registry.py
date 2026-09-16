"""工具注册表：每个工具 = 名称 + 描述 + 参数 JSON Schema + handler。
LLM 只看得到前三样（拼进 system prompt），runtime 负责校验参数再调 handler。

ToolContext（dict）：{sessionState, userId, sessionId, turn?}
    sessionState  当前 session 的可变状态袋，有状态工具（todo）把数据放这里，天然按 session 隔离
    turn          当前轮次（runtime 传入；remember 用它记 source，#19 Q3）。直接 invoke 时可不给
ToolResult（dict）：{ok, content, durationMs}
"""
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

JsonSchema = Dict[str, Any]
Handler = Callable[[Dict[str, Any], Dict[str, Any]], str]


@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: JsonSchema
    handler: Handler
    # 结果精简：工具原始输出可能很长，塞回 context 前先过这一道。不提供则按默认截断。
    compact: Optional[Callable[[str], str]] = None
    # 进 trace 前对 args 脱敏（白名单落盘）：用户内容类参数只留长度 / 摘要。不提供则 args 原样进 trace。只影响 trace，不影响 handler 收到的参数。
    redact: Optional[Callable[[Dict[str, Any]], Dict[str, Any]]] = None

    def spec(self) -> dict:
        return {"name": self.name, "description": self.description, "parameters": self.parameters}


DEFAULT_MAX_CHARS = 1500


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: Dict[str, ToolDefinition] = {}

    def register(self, d: ToolDefinition) -> "ToolRegistry":
        if d.name in self._tools:
            raise ValueError(f"工具重名：{d.name}")
        self._tools[d.name] = d
        return self

    def has(self, name: str) -> bool:
        return name in self._tools

    def redact(self, name: str, args: Dict[str, Any]) -> Dict[str, Any]:
        """trace 用：按工具声明脱敏后的 args；未注册或未声明 redact 则原样"""
        d = self._tools.get(name)
        return d.redact(args) if d and d.redact else args

    def specs(self) -> List[dict]:
        return [d.spec() for d in self._tools.values()]

    def invoke(self, name: str, args: Dict[str, Any], ctx: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """校验参数 → 执行 → 精简。任何失败都变成 ok:false 的结果，不向上抛。"""
        started = time.monotonic()

        def done(ok: bool, content: str) -> Dict[str, Any]:
            return {"ok": ok, "content": content, "durationMs": int((time.monotonic() - started) * 1000)}

        d = self._tools.get(name)
        if d is None:
            return done(False, f'工具 "{name}" 未注册。可用工具：{", ".join(self._tools.keys())}')
        problem = validate_args(d.parameters, args)
        if problem:
            return done(False, f"参数错误：{problem}")
        ctx = ctx or {}
        full_ctx = {
            "sessionState": ctx.get("sessionState") if ctx.get("sessionState") is not None else {},
            "userId": ctx.get("userId") or "anon",
            "sessionId": ctx.get("sessionId") or "default",
            "turn": ctx.get("turn"),
        }
        try:
            raw = d.handler(args, full_ctx)
            return done(True, d.compact(raw) if d.compact else truncate(raw, DEFAULT_MAX_CHARS))
        except Exception as e:  # noqa: BLE001 —— 工具的任何异常都以结果形式回喂
            return done(False, f"工具执行失败：{e}")


def _js_typeof(v: Any) -> str:
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    if isinstance(v, str):
        return "string"
    if isinstance(v, list):
        return "array"
    return "object"


def validate_args(schema: JsonSchema, args: Dict[str, Any]) -> Optional[str]:
    """极简 JSON Schema 校验：只管 required 与顶层类型，够这题用；返回第一条问题描述。"""
    for key in schema.get("required", []):
        if args.get(key) is None:
            return f'缺少必填参数 "{key}"'
    props = schema.get("properties", {})
    for key, val in args.items():
        prop = props.get(key)
        if prop is None:
            return f'未知参数 "{key}"，允许的参数：{", ".join(props.keys())}'
        actual = _js_typeof(val)
        expected = "number" if prop["type"] == "integer" else prop["type"]
        if actual != expected:
            return f'参数 "{key}" 应为 {prop["type"]}，实际是 {actual}'
        if prop.get("enum") and str(val) not in prop["enum"]:
            return f'参数 "{key}" 只能是 {" / ".join(prop["enum"])}'
    return None


def truncate(s: str, max_chars: int) -> str:
    return s if len(s) <= max_chars else s[:max_chars] + f"\n…（已截断，原文 {len(s)} 字符）"
