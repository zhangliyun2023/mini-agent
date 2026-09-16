"""#19 R7：复盘表四条 P0 不变量的独立 oracle（contracts/review_machine.py invariants）。
输入只有「用户可见的证据」：盘上 journal、记忆文件里的条目、昨天的转写行、journal 里的 brief；不碰 run_review 内部。
每个函数返回违反项列表，空 = 通过。测试里每条一红一绿：真实运行过 oracle，篡改后的证据被 oracle 点名。
"""
from typing import Any, Dict, List

from .present import VERBATIM_MIN_CHARS, squash


def idempotent(e: Dict[str, Any]) -> List[str]:
    """① 幂等：同键 journal 恰一份、attempts == 跑的次数、记忆条目数与第一次之后相同
    e = {userId, date, runs, journals, memoryAfterFirst, memoryAfterLast}"""
    v: List[str] = []
    same = [j for j in e["journals"] if j["userId"] == e["userId"] and j["date"] == e["date"]]
    if len(same) != 1:
        v.append(f"同键 {e['userId']}/{e['date']} 的 journal 应恰 1 份，实际 {len(same)} 份")
    for j in same:
        if j["attempts"] != e["runs"]:
            v.append(f"journal.attempts 应为 {e['runs']}，实际 {j['attempts']}")
    first, last = e["memoryAfterFirst"], e["memoryAfterLast"]
    if len(first) != len(last):
        v.append(f"记忆条目数变了：{len(first)} → {len(last)}")
    else:
        keys = {f"{m['key']} {m['value']} {m['status']}" for m in first}
        for m in last:
            if f"{m['key']} {m['value']} {m['status']}" not in keys:
                v.append(f"记忆条目 ({m['key']}, {m['value']}, {m['status']}) 是第一次之后新出现的")
    return v


def no_overwrite_on_conflict(e: Dict[str, Any]) -> List[str]:
    """② 同 key 异值不覆盖：复盘前 active 的每条 (key, value) 复盘后仍 active；同 key 的新值只能以 conflict 存在且 conflictWith 指向旧值
    e = {before, after}"""
    v: List[str] = []
    for old in [m for m in e["before"] if m["status"] == "active"]:
        kept = next((m for m in e["after"] if m["key"] == old["key"] and m["value"] == old["value"]), None)
        if kept is None:
            v.append(f"key {old['key']} 的旧值「{old['value']}」复盘后不见了（被覆盖）")
        elif kept["status"] != "active":
            v.append(f"key {old['key']} 的旧值「{old['value']}」复盘后不再 active（{kept['status']}）")
        for m in e["after"]:
            if m["key"] != old["key"] or m["value"] == old["value"]:
                continue
            if m["status"] != "conflict":
                v.append(f"key {old['key']} 的新值「{m['value']}」以 {m['status']} 写入，覆盖了旧值「{old['value']}」")
            elif m.get("conflictWith") != old["value"]:
                v.append(f"key {old['key']} 的新值「{m['value']}」标了 conflict 但 conflictWith 不是旧值「{old['value']}」")
    return v


def every_highlight_has_source(e: Dict[str, Any]) -> List[str]:
    """③ 每条亮点的 source 都指向昨天转写里真实存在的 (sessionId, turn)；e = {brief, lines}"""
    v: List[str] = []
    if not e["brief"]:
        return v
    known = {f"{l['sessionId']}#{l['turn']}" for l in e["lines"]}
    for i, h in enumerate(e["brief"]["highlights"]):
        s = h.get("source")
        if not isinstance(s, dict) or not isinstance(s.get("sessionId"), str) or isinstance(s.get("turn"), bool) or not isinstance(s.get("turn"), int):
            v.append(f"亮点 #{i + 1}「{h.get('text')}」没有 source")
            continue
        if f"{s['sessionId']}#{s['turn']}" not in known:
            v.append(f"亮点 #{i + 1}「{h.get('text')}」的来源 {s['sessionId']} 第 {s['turn']} 轮在昨天的转写里不存在")
    return v


def brief_not_verbatim(e: Dict[str, Any]) -> List[str]:
    """④ brief 不复述原话：任何亮点文本都不与昨天某行去空白后相等，也不是该行 ≥ VERBATIM_MIN_CHARS 字的连续子串；e = {brief, lines}"""
    v: List[str] = []
    if not e["brief"]:
        return v
    for i, h in enumerate(e["brief"]["highlights"]):
        t = squash(h.get("text") or "")
        if t == "":
            continue
        long_enough = len(t) >= VERBATIM_MIN_CHARS
        for l in e["lines"]:
            c = squash(l.get("content") or "")
            if c == t or (long_enough and t in c):
                v.append(f"亮点 #{i + 1}「{h.get('text')}」与昨天 {l['sessionId']} 第 {l['turn']} 轮 {l['role']} 的原话逐字重合")
                break
    return v


def check_review_invariants(e: Dict[str, Any]) -> List[Dict[str, Any]]:
    """四条一起过：e = {idempotent, memory, brief, lines}；返回每条的 id 与违反项（空 = 通过），与 turn 的 check_turn_invariants 同形"""
    return [
        {"id": "idempotent", "violations": idempotent(e["idempotent"])},
        {"id": "no_overwrite_on_conflict", "violations": no_overwrite_on_conflict(e["memory"])},
        {"id": "every_highlight_has_source", "violations": every_highlight_has_source({"brief": e["brief"], "lines": e["lines"]})},
        {"id": "brief_not_verbatim", "violations": brief_not_verbatim({"brief": e["brief"], "lines": e["lines"]})},
    ]
