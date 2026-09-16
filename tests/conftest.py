"""公用夹具：仓库根为 cwd（与 TS 版 vitest 同口径），几个小工具。"""
import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
os.chdir(ROOT)


def tc(name: str, args: dict) -> str:
    """文本协议的一次工具调用"""
    return f"<tool_call>{json.dumps({'name': name, 'arguments': args}, ensure_ascii=False)}</tool_call>"


def last_tool(messages: list) -> str:
    for m in reversed(messages):
        if m["role"] == "tool":
            return m["content"]
    return ""


@pytest.fixture
def tmp(tmp_path):
    return str(tmp_path)
