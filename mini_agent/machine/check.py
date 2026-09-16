"""对答案（B1）：期望的行 id 序列（contracts/journeys.json）vs 观察到的转移（trace JSONL rows）。
人、AI、测试用同一个函数；判分只吃 rows，不吃 sink / db。
三态：passed（某一轮逐条相同）/ failed（给出最接近的一轮）/ not_observed（这张表 / 这个 trace_id 根本没记录）。

TransitionRow（dict）至少含：trace_id, feature, transition（命中的行 id；unknown 为 None）, status, ts
Journey（dict）：{feature, expect: [行 id], alternatives?: [[行 id]], title?}
"""
from typing import Any, Dict, List, Optional

from .interpreter import Machine


def check_journey(rows: List[dict], journey: dict, trace_id: Optional[str] = None) -> Dict[str, Any]:
    by_trace: Dict[str, List[str]] = {}
    for r in rows:
        if r.get("feature") != journey["feature"] or (trace_id and r.get("trace_id") != trace_id):
            continue
        seq = by_trace.setdefault(r["trace_id"], [])
        # unknown 转移没有行 id，序列里不出现；它们由 unknown_rows 单独列出，不会被「对上了」掩盖
        if r.get("transition"):
            seq.append(r["transition"])
    if not by_trace:
        return {"status": "not_observed"}
    candidates = [journey["expect"], *journey.get("alternatives", [])]
    closest: Optional[dict] = None
    for tid, actual in by_trace.items():
        if any(c == actual for c in candidates):
            return {"status": "passed", "trace_id": tid}
        if closest is None or abs(len(actual) - len(journey["expect"])) < abs(len(closest["actual"]) - len(journey["expect"])):
            closest = {"trace_id": tid, "actual": actual}
    return {"status": "failed", "closest": closest}


def unknown_rows(rows: List[dict]) -> List[dict]:
    """unknown 转移永远单独列出，不是「没关系」"""
    return [r for r in rows if r.get("status") == "unknown"]


def validate_journey(journey: dict, m: Machine) -> List[str]:
    """旅程与表拴在一起：每个 id 存在、从 initial 出发、首尾相接、落在终态（无终态的表只查前三条）。返回问题列表，空 = 通过。"""
    problems: List[str] = []
    by_id = {r.id: r for r in m.rows}

    def check(label: str, ids: List[str]) -> None:
        if not ids:
            problems.append(f"{label} 为空")
            return
        rows = [by_id.get(i) for i in ids]
        for i, r in enumerate(rows):
            if r is None:
                problems.append(f'{label} 第 {i + 1} 条 "{ids[i]}" 不在 {m.feature} 表里')
        if any(r is None for r in rows):
            return
        seq = [r for r in rows if r is not None]
        if seq[0].from_ != m.initial:
            problems.append(f'{label} 首条 "{seq[0].id}" 不从 initial({m.initial}) 出发')
        for i in range(1, len(seq)):
            if seq[i - 1].to != seq[i].from_:
                problems.append(f'{label} 第 {i} 与 {i + 1} 条首尾接不上："{seq[i - 1].id}" 到 {seq[i - 1].to}，"{seq[i].id}" 却从 {seq[i].from_} 出发')
        last = seq[-1]
        if m.terminal and not m.is_terminal(last.to):
            problems.append(f'{label} 末条 "{last.id}" 落在 {last.to}，不是终态')

    check("expect", journey["expect"])
    for i, alt in enumerate(journey.get("alternatives", [])):
        check(f"alternatives[{i}]", alt)
    return problems
