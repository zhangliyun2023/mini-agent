"""脚本化 LLM：按顺序吐预设文本，同时记录每次收到的 messages，测试用它断言「context 里放了什么」。

脚本项：
    str                          → 回复文本
    dict {toolCalls:[…], content?} → 原生模式的 tool_calls（arguments 可给对象或原始 JSON 串；id 不给则自动编 call_N）
    callable(messages) → 上述任一 → 按收到的消息动态决定；callable 里 raise 就是模拟模型接口失败
    Exception 实例                → 直接抛出
native=True 时模拟原生 function calling 客户端：tool_mode = "native"，返回 nativeToolCalls（不再是标签文本）。
"""
import copy
import json
from typing import Any, Callable, List, Optional, Union

from .types import NATIVE, TEXT, ChatMessage, LLMResponse

ScriptItem = Union[str, dict, BaseException, Callable[[List[ChatMessage]], Any]]


class FakeLLM:
    model = "fake"

    def __init__(self, script: List[ScriptItem], native: bool = False):
        self.queue: List[ScriptItem] = list(script)
        self.tool_mode = NATIVE if native else TEXT
        self.calls: List[List[ChatMessage]] = []
        self._next_id = 0

    def chat(self, messages: List[ChatMessage], tools: Optional[List[dict]] = None) -> LLMResponse:
        self.calls.append([copy.deepcopy(m) for m in messages])
        if not self.queue:
            raise RuntimeError("FakeLLM 脚本用完了，还在被调用")
        item = self.queue.pop(0)
        if isinstance(item, BaseException):
            raise item
        reply = item(messages) if callable(item) else item
        if isinstance(reply, BaseException):
            raise reply

        def usage(text: str) -> dict:
            return {"promptTokens": len(json.dumps(messages, ensure_ascii=False)) / 4, "completionTokens": len(text) / 4}

        if isinstance(reply, str):
            return {"text": reply, "usage": usage(reply)}
        if self.tool_mode != NATIVE:
            raise RuntimeError("FakeLLM 文本模式的脚本项只能是字符串；要用 {toolCalls} 请传 native=True")
        native_calls = []
        for c in reply["toolCalls"]:
            cid = c.get("id")
            if cid is None:
                self._next_id += 1
                cid = f"call_{self._next_id}"
            args = c["arguments"]
            native_calls.append({"id": cid, "name": c["name"], "arguments": args if isinstance(args, str) else json.dumps(args, ensure_ascii=False, separators=(",", ":"))})
        text = reply.get("content") or ""
        return {"text": text, "usage": usage(text), "nativeToolCalls": native_calls}
