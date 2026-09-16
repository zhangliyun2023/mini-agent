import re

import pytest

from mini_agent.tools.calculator import calculator_tool
from mini_agent.tools.registry import ToolDefinition, ToolRegistry
from mini_agent.tools.search import search_tool
from mini_agent.tools.todo import create_todo_tool


def test_specs_after_register():
    specs = ToolRegistry().register(calculator_tool).specs()
    assert len(specs) == 1
    assert specs[0]["name"] == "calculator"
    assert isinstance(specs[0]["description"], str)
    assert specs[0]["parameters"]["type"] == "object" and specs[0]["parameters"]["required"] == ["expression"]


def test_unregistered_tool_returns_error():
    r = ToolRegistry().invoke("nope", {}, {})
    assert r["ok"] is False
    assert "未注册" in r["content"]


def test_schema_violations_rejected():
    reg = ToolRegistry().register(calculator_tool)
    r1 = reg.invoke("calculator", {}, {})
    assert r1["ok"] is False and "expression" in r1["content"]
    r2 = reg.invoke("calculator", {"expression": 123}, {})
    assert r2["ok"] is False and "string" in r2["content"]


def test_unknown_param_rejected_listing_allowed():
    r = ToolRegistry().register(create_todo_tool()).invoke("todo", {"action": "list", "foo": 1}, {})
    assert r["ok"] is False
    assert '未知参数 "foo"' in r["content"]
    assert "action, item, index" in r["content"]


def test_enum_violation_rejected():
    r = ToolRegistry().register(create_todo_tool()).invoke("todo", {"action": "fly"}, {})
    assert r["ok"] is False
    assert "只能是 add / list / done / remove" in r["content"]


def test_default_truncation():
    reg = ToolRegistry().register(ToolDefinition("long", "returns a long string", {"type": "object", "properties": {}}, lambda a, c: "x" * 5000))
    r = reg.invoke("long", {}, {})
    assert r["ok"] is True
    assert len(r["content"]) < 1600
    assert "已截断，原文 5000 字符" in r["content"]


def test_custom_compact_used():
    r = ToolRegistry().register(search_tool).invoke("search", {"query": "上海"}, {})
    assert r["ok"] is True
    assert "已截断" not in r["content"]


def test_duplicate_register_raises():
    with pytest.raises(ValueError, match="重名"):
        ToolRegistry().register(calculator_tool).register(calculator_tool)


def test_handler_exception_captured():
    def boom(a, c):
        raise RuntimeError("炸了")

    r = ToolRegistry().register(ToolDefinition("boom", "always throws", {"type": "object", "properties": {}}, boom)).invoke("boom", {}, {})
    assert r["ok"] is False
    assert "炸了" in r["content"]


# 四个工具的可见行为都走 registry.invoke——和 runtime 同一条路（校验 → 执行 → 精简），不绕过注册表直调 handler
def reg():
    return ToolRegistry().register(calculator_tool).register(search_tool).register(create_todo_tool())


def test_calculator_arithmetic():
    r = reg().invoke("calculator", {"expression": "(2+3)*4/8"}, {})
    assert r["ok"] is True and r["content"] == "2.5"


def test_calculator_rejects_code():
    r = reg().invoke("calculator", {"expression": "__import__('os').system('ls')"}, {})
    assert r["ok"] is False
    assert "只支持数字" in r["content"]


def test_search_top3():
    r = reg().invoke("search", {"query": "上海 天气"}, {})
    assert r["ok"] is True
    assert "上海" in r["content"]
    assert len([l for l in r["content"].split("\n") if l.startswith("- ")]) <= 3


def test_search_no_hit():
    assert "没有找到" in reg().invoke("search", {"query": "zzzz不存在"}, {})["content"]


def test_search_chinese_without_spaces_hits():
    # 2026-09-15 live 暴露（#3）：模型搜「上海今天天气」（无空格），语料是「上海今日天气」，整串子串匹配命中不了
    r = reg().invoke("search", {"query": "上海今天天气"}, {})
    assert r["ok"] is True
    assert "没有找到" not in r["content"]
    assert "上海今日天气" in r["content"].split("\n")[0]
    assert re.search("多云|晴", r["content"])


def test_search_only_stop_words_no_hit():
    assert "没有找到" in reg().invoke("search", {"query": "今天的"}, {})["content"]


def test_todo_add_list_done_same_session():
    ctx = {"sessionState": {}, "userId": "u", "sessionId": "s"}
    t = reg()
    t.invoke("todo", {"action": "add", "item": "买牛奶"}, ctx)
    t.invoke("todo", {"action": "add", "item": "写周报"}, ctx)
    t.invoke("todo", {"action": "done", "index": 1}, ctx)
    lst = t.invoke("todo", {"action": "list"}, ctx)
    assert "[x] 买牛奶" in lst["content"]
    assert "[ ] 写周报" in lst["content"]


def test_todo_bad_index():
    r = reg().invoke("todo", {"action": "done", "index": 3}, {"sessionState": {}})
    assert r["ok"] is False
    assert "序号 3 不存在，当前共 0 条" in r["content"]


def test_todo_isolated_between_sessions():
    t = reg()
    a, b = {"sessionState": {}}, {"sessionState": {}}
    t.invoke("todo", {"action": "add", "item": "只在A"}, a)
    assert "只在A" not in t.invoke("todo", {"action": "list"}, b)["content"]
