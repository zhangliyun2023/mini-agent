"""解析模型输出。协议是三段标签：
    <think>…</think>               思考过程（可选）
    <tool_call>{json}</tool_call>  工具调用（可多个）
    <final>…</final>               最终答案
模型并不总守协议，所以这里的原则是：能救的救，救不了的记进 errors 回喂给模型，绝不抛异常。

ParsedOutput（dict）：{think?: str, toolCalls: [{name, arguments}], final?: str, errors: [str], warnings: [str]}
    errors   解析阶段发现的问题，runtime 会把它们作为 tool 消息喂回模型让其纠正
    warnings 救回来了但不合协议的地方，只进 trace，不回喂
"""
import json
import re
from typing import Any, Dict, List, Optional, Tuple

THINK_RE = re.compile(r"<think>(.*?)</think>", re.S)
# 实测 qwen3-max 会把标签写成 Anthropic 风格的 <invoke>，或 <function_call>；这些别名一并接住
# 只认开标签，JSON 靠配平大括号截取——2026-09-15 实测模型会把闭合标签写成 <tool_call>，按闭合标签切会把两个调用吞成一块
TOOL_OPEN_RE = re.compile(r"<(tool_call|invoke|function_call)>")
# 2026-09-15 live 暴露的第四种变体（#4，原生模式下模型没走 tool_calls 直接吐文本）：
#   <function=NAME><parameter=K>V</parameter>…</function>
FUNCTION_BLOCK_RE = re.compile(r"<function=([\w.-]+)>(.*?)</function>", re.S)
PARAMETER_RE = re.compile(r"<parameter=([\w.-]+)>(.*?)</parameter>", re.S)
# 裸文本里出现 {"name":…,"arguments":…}：模型想调工具但忘了打标签，不能当最终答案
BARE_CALL_RE = re.compile(r'\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:')
# 残缺的 <function=…> / <parameter=…> 同理：像在调工具，不能当最终答案
BARE_FUNCTION_RE = re.compile(r"<(function|parameter)=[\w.-]+>")
# 实测会出现 <final><final>… 与没有闭合的 <final>…：捕到闭合或文末为止，再剥掉重复的开标签
FINAL_RE = re.compile(r"<final>(.*?)(?:</final>|$)", re.S)
_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")


def _strip_final_tags(v: str) -> str:
    return re.sub(r"(</final>\s*)+$", "", re.sub(r"^(\s*<final>)+", "", v)).strip()


def extract_json_object(text: str, start: int = 0) -> Optional[Tuple[str, int]]:
    """从 start 起找第一个 { 并截取配平的 JSON 对象（考虑字符串与转义）；None 表示没配平"""
    open_at = text.find("{", start)
    if open_at < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(open_at, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[open_at : i + 1], i + 1
    return None


def _coerce_param(raw: str) -> Any:
    """<parameter> 里的值都是文本；数字与布尔按原生 function calling 的习惯还原成对应类型"""
    v = raw.strip()
    if _NUMBER_RE.match(v):
        return float(v) if "." in v else int(v)
    if v in ("true", "false"):
        return v == "true"
    return v


def parse_assistant_output(text: str) -> Dict[str, Any]:
    errors: List[str] = []
    warnings: List[str] = []
    m_think = THINK_RE.search(text)
    think = m_think.group(1).strip() if m_think else None

    # 两种写法都可能出现，按在原文里的位置排序，保证多次调用的顺序
    found: List[Tuple[int, Optional[dict], Optional[str]]] = []
    for m in TOOL_OPEN_RE.finditer(text):
        if m.group(1) != "tool_call":
            warnings.append(f"模型用了 <{m.group(1)}> 标签，已按 <tool_call> 处理")
        after = m.end()
        nxt = TOOL_OPEN_RE.search(text, after)
        segment = text[after : nxt.start()] if nxt else text[after:]
        stripped = segment.strip()
        if stripped == "" or stripped.startswith("</"):
            # 开标签后面紧跟另一个开标签或只有闭合标签：多半是把 </tool_call> 写成了 <tool_call>，不是一次调用
            warnings.append("出现了多余的 <tool_call> 标签（疑似闭合标签写错），已忽略")
            continue
        ext = extract_json_object(segment, 0)
        brace = segment.find("{")
        if ext is None or segment[: brace if brace >= 0 else 0].strip() != "":
            found.append((m.start(), None, f"tool_call 不是合法 JSON：大括号不配平或标签内不是 JSON；原文：{stripped[:200]}"))
            continue
        raw = ext[0]
        try:
            obj = json.loads(raw)
        except ValueError as e:
            found.append((m.start(), None, f"tool_call 不是合法 JSON：{e}；原文：{raw[:200]}"))
            continue
        if not isinstance(obj, dict) or not isinstance(obj.get("name"), str):
            found.append((m.start(), None, f"tool_call 缺少 name 字段：{raw[:200]}"))
            continue
        args = obj.get("arguments")
        found.append((m.start(), {"name": obj["name"], "arguments": args if isinstance(args, dict) else {}}, None))
    for m in FUNCTION_BLOCK_RE.finditer(text):
        warnings.append(f"模型用了 <function={m.group(1)}> 标签，已按 <tool_call> 处理")
        args = {p.group(1): _coerce_param(p.group(2)) for p in PARAMETER_RE.finditer(m.group(2))}
        found.append((m.start(), {"name": m.group(1), "arguments": args}, None))
    found.sort(key=lambda f: f[0])
    tool_calls = [f[1] for f in found if f[1] is not None]
    errors.extend(f[2] for f in found if f[2] is not None)

    m_final = FINAL_RE.search(text)
    final_match = _strip_final_tags(m_final.group(1)) if m_final else None
    final: Optional[str] = None
    if tool_calls:
        if final_match is not None:
            errors.append("同时输出了 tool_call 和 final，已忽略 final：请先等工具结果再给最终答案")
    elif final_match is not None:
        final = final_match
    elif not errors:
        bare = THINK_RE.sub("", text, count=1).strip()
        if BARE_CALL_RE.search(bare) or BARE_FUNCTION_RE.search(bare):
            errors.append("看起来你想调用工具，但没有用 <tool_call>…</tool_call> 包起来，请用标签重新输出")
        elif bare:
            # 完全没有标签：把去掉 think 后的裸文本当最终答案
            final = bare

    out: Dict[str, Any] = {"toolCalls": tool_calls, "errors": errors, "warnings": warnings}
    if think is not None:
        out["think"] = think
    if final is not None:
        out["final"] = final
    return out
