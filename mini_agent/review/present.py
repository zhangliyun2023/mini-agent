"""#19 ⑤ 呈现门槛（R5）：纯函数，不碰存储、不碰模型。
输入是整合结果 + 昨天的转写行；输出是可直接发给用户的 brief（或 None）+ 被拦下的条目 + 警告。

PresentResult（dict）：{brief: Brief, dropped: [{highlight, reason}], warnings: [str]}
"""
import re
from typing import Any, Dict, List, Optional

from .types import WHY_TODAY

PREFIX = {"due_today": "今天到期：", "unfinished": "昨天没收尾：", "planned_today": "你说过今天要："}
# 亮点是某行内容的连续子串且长度 ≥ 此值（去空白后按码点计）→ 视为复述原话
VERBATIM_MIN_CHARS = 20
_WS = re.compile(r"\s+")


def squash(s: str) -> str:
    return _WS.sub("", s)


def _gate_reason(h: dict) -> Optional[str]:
    why = h.get("why_today")
    if why is None or why == "":
        return "missing_why_today"
    if why not in WHY_TODAY:
        return f"invalid_why_today:{why}"
    s = h.get("source")
    if not isinstance(s, dict) or not isinstance(s.get("sessionId"), str) or isinstance(s.get("turn"), bool) or not isinstance(s.get("turn"), int):
        return "missing_source"
    return None


def verbatim_hit(text: str, lines: List[dict]) -> Optional[dict]:
    """亮点与昨天哪一行逐字重合：去空白后相等，或是该行 ≥ VERBATIM_MIN_CHARS 字的连续子串。没有则 None。"""
    t = squash(text)
    if t == "":
        return None
    long_enough = len(t) >= VERBATIM_MIN_CHARS
    for l in lines:
        c = squash(l.get("content") or "")
        if c == t or (long_enough and t in c):
            return l
    return None


def present(consolidation: Dict[str, Any], yesterday_lines: List[dict]) -> Dict[str, Any]:
    dropped: List[dict] = []
    warnings: List[str] = list(consolidation.get("warnings", []))
    kept: List[dict] = []
    for h in consolidation.get("highlights") or []:
        reason = _gate_reason(h)
        if reason:
            dropped.append({"highlight": h, "reason": reason})
            continue
        hit = verbatim_hit(h.get("text") or "", yesterday_lines)
        if hit:
            dropped.append({"highlight": h, "reason": "verbatim"})
            warnings.append(f"亮点「{h['text']}」与昨天 {hit['sessionId']} 第 {hit['turn']} 轮 {hit['role']} 的原话逐字重合，已过滤")
            continue
        kept.append(h)
    if not kept:
        return {"brief": None, "dropped": dropped, "warnings": warnings}
    text = "\n".join(f"{PREFIX[h['why_today']]}{h['text']}" for h in kept)
    return {"brief": {"highlights": kept, "text": text}, "dropped": dropped, "warnings": warnings}
