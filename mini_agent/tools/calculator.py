"""不用 eval：先按白名单字符过滤，再用 ast 只放行 数字 / 四则 / % / ** / 括号 / 一元正负 求值。
白名单先于求值，"__import__('os')" 这种进不来。"""
import ast
import math
import operator
import re
from typing import Any

from .registry import ToolDefinition

SAFE_RE = re.compile(r"^[\d\s+\-*/().%]+$")
_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Mod: operator.mod, ast.Pow: operator.pow}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def _eval(node: ast.AST) -> Any:
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN:
        return _BIN[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_eval(node.operand))
    raise ValueError("不支持的语法")


def evaluate(expression: str) -> float:
    expr = expression.strip()
    if not expr or not SAFE_RE.match(expr):
        raise ValueError(f"只支持数字与 + - * / % ( ) 的算式，收到：{expression}")
    try:
        value = _eval(ast.parse(expr, mode="eval"))
    except (ValueError, SyntaxError, ZeroDivisionError, OverflowError, TypeError):
        raise ValueError(f"算式无法求值：{expression}")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or (isinstance(value, float) and not math.isfinite(value)):
        raise ValueError(f"算式无法求值：{expression}")
    return value


def format_number(value: Any) -> str:
    """与 JS String(number) 对齐：整数值不带 .0"""
    if isinstance(value, float) and value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    return repr(value) if isinstance(value, float) else str(value)


calculator_tool = ToolDefinition(
    name="calculator",
    description="计算一个算术表达式，支持 + - * / % ** 和括号。需要精确数值时必须用它，不要心算。",
    parameters={"type": "object", "properties": {"expression": {"type": "string", "description": "算式，例如 (2+3)*4"}}, "required": ["expression"]},
    handler=lambda args, ctx: format_number(evaluate(args["expression"])),
)
