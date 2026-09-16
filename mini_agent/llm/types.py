"""LLM 抽象：runtime 只依赖这个接口，真实 API 与测试用的脚本化 LLM 都实现它。

ChatMessage（dict）：
    role: "system" | "user" | "assistant" | "tool"
    content: str
    toolCallId?: str      role=tool 时对应的调用 id；原生模式下就是厂商的 tool_call id
    name?: str            role=tool 时的工具名
    toolCalls?: [ToolCallRef]  role=assistant 且原生模式时：模型这一步发出的工具调用（文本模式不设）
    kind?: "review_brief" 复盘交付追加的标记消息（#19 ⑩ / Q8）；发给厂商时不上线

ToolCallRef（dict）：{id, name, arguments}，arguments 是厂商给的原始 JSON 字符串，回放时原样发回

LLMResponse（dict）：
    text: str                          模型原始文本输出（自定义协议由 parser 解析）
    usage?: {promptTokens, completionTokens}
    nativeToolCalls?: [ToolCallRef]    原生 function calling 模式下直接给出的工具调用
"""
from typing import Any, Dict, List, Optional, Protocol, runtime_checkable

ChatMessage = Dict[str, Any]
ToolCallRef = Dict[str, Any]
LLMResponse = Dict[str, Any]

TEXT = "text"
NATIVE = "native"


@runtime_checkable
class LLMClient(Protocol):
    model: str

    def chat(self, messages: List[ChatMessage], tools: Optional[List[dict]] = None) -> LLMResponse: ...


def tool_mode_of(llm: Any) -> str:
    """缺省 text。runtime 据此决定 system prompt 教不教标签协议、历史用什么形状"""
    return NATIVE if getattr(llm, "tool_mode", None) == NATIVE else TEXT
