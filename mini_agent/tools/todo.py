"""有状态工具：数据存在 ctx["sessionState"]["todos"]，所以窗口 1 的清单窗口 2 看不到。
用来验证「带着工具的追问」（"把第 2 条标完成"）。"""
from typing import List

from .registry import ToolDefinition


def _items(state: dict) -> List[dict]:
    if not isinstance(state.get("todos"), list):
        state["todos"] = []
    return state["todos"]


def _render(items: List[dict]) -> str:
    if not items:
        return "待办清单为空。"
    return "\n".join(f"{i + 1}. [{'x' if t['done'] else ' '}] {t['text']}" for i, t in enumerate(items))


def _handler(args: dict, ctx: dict) -> str:
    items = _items(ctx["sessionState"])
    action = args["action"]
    if action == "add":
        item = args.get("item")
        if not item:
            raise ValueError("add 需要 item")
        items.append({"text": item, "done": False})
        return f"已添加：{item}\n{_render(items)}"
    if action == "list":
        return _render(items)
    if action in ("done", "remove"):
        index = args.get("index")
        try:
            i = int(index) - 1
        except (TypeError, ValueError):
            i = -1
        if not (0 <= i < len(items)):
            raise ValueError(f"序号 {index} 不存在，当前共 {len(items)} 条")
        if action == "done":
            items[i]["done"] = True
        else:
            items.pop(i)
        return _render(items)
    raise ValueError(f"未知 action：{action}")


def create_todo_tool() -> ToolDefinition:
    return ToolDefinition(
        name="todo",
        description="管理当前会话的待办清单：add 新增、list 列出、done 标记完成、remove 删除。清单只在本会话内有效。",
        parameters={
            "type": "object",
            "properties": {
                "action": {"type": "string", "description": "操作", "enum": ["add", "list", "done", "remove"]},
                "item": {"type": "string", "description": "add 时的待办内容"},
                "index": {"type": "number", "description": "done / remove 时的序号，从 1 开始"},
            },
            "required": ["action"],
        },
        handler=_handler,
    )
