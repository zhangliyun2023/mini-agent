"""任意 OpenAI-compatible 端点（DashScope / DeepSeek / 智谱 / 豆包 …）。

默认「文本协议」模式：模型按 <think>/<tool_call>/<final> 输出，runtime 自己解析。
「原生 function calling」模式（传 native_tools）：工具经 API 的 tools 字段给，模型返回的 tool_calls 原样交给 runtime
（runtime 把它们转成与文本协议同一形状的 ParsedOutput），历史里的 assistant.tool_calls / tool.tool_call_id 回放时原样发回。
"""
from typing import Any, Dict, List, Optional

from .types import NATIVE, TEXT, ChatMessage, LLMResponse


class OpenAICompatibleLLM:
    def __init__(self, api_key: str, base_url: str, model: str, native_tools: Optional[List[dict]] = None, temperature: float = 0.2, timeout_s: float = 60.0):
        from openai import OpenAI  # 延迟导入：不装 openai 也能跑单测的其余部分

        self.model = model
        self.native_tools = native_tools
        self.tool_mode = NATIVE if native_tools is not None else TEXT
        self.temperature = temperature
        self._client = OpenAI(api_key=api_key, base_url=base_url, timeout=timeout_s, max_retries=0)

    def chat(self, messages: List[ChatMessage], tools: Optional[List[dict]] = None) -> LLMResponse:
        kwargs: Dict[str, Any] = {"model": self.model, "temperature": self.temperature, "messages": to_wire_messages(messages, self.tool_mode)}
        if self.native_tools is not None:
            kwargs["tools"] = [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}} for t in self.native_tools]
        res = self._client.chat.completions.create(**kwargs)
        msg = res.choices[0].message
        fn_calls = [c for c in (msg.tool_calls or []) if getattr(c, "type", "function") == "function"]
        out: LLMResponse = {
            "text": msg.content or "",
            "nativeToolCalls": [{"id": c.id, "name": c.function.name, "arguments": c.function.arguments} for c in fn_calls],
        }
        if res.usage is not None:
            out["usage"] = {"promptTokens": res.usage.prompt_tokens, "completionTokens": res.usage.completion_tokens}
        return out


def to_wire_messages(messages: List[ChatMessage], mode: str) -> List[dict]:
    """发给厂商前的消息映射。OpenAI 协议要求 role=tool 的消息必须紧跟一条带 tool_calls 的 assistant 消息，且 tool_call_id 对得上。

    - 文本协议模式：历史是我们自己的标签文本，没有厂商的 tool_call id，工具结果统一降级为带前缀的 user 消息。
    - 原生模式（#10）：assistant 消息上的 toolCalls 原样发成 tool_calls，紧跟其后、id 对得上的 tool 消息发成 role=tool + tool_call_id；
      对不上的 tool 消息（解析错误回喂、文本模式遗留的历史）仍降级为 user，避免厂商 400。
    这是模块五第 1 题「两种工具输出方式差异」在代码里的具体落点。
    """
    out: List[dict] = []
    open_ids: set = set()
    for m in messages:
        if m["role"] == "tool":
            if mode == NATIVE and m.get("toolCallId") in open_ids:
                out.append({"role": "tool", "tool_call_id": m["toolCallId"], "content": m["content"]})
            else:
                out.append({"role": "user", "content": f"[工具 {m.get('name')} 的结果]\n{m['content']}"})
            continue
        open_ids = {c["id"] for c in (m.get("toolCalls") or [])} if (m["role"] == "assistant" and mode == NATIVE) else set()
        if m["role"] == "assistant" and mode == NATIVE and m.get("toolCalls"):
            out.append({
                "role": "assistant",
                "content": m["content"] or None,
                "tool_calls": [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["arguments"]}} for c in m["toolCalls"]],
            })
            continue
        out.append({"role": m["role"], "content": m["content"]})
    return out
