"""记忆条目集合的 upsert 规则（#19 ④ / Q3）。纯函数：输入旧集合与一条新条目，返回新集合，不改入参。
    同 key 且 value 相同 → 刷新那条的 date / source（kind / confidence / status 不动）
    同 key 不同 value   → 追加一条 status: "conflict"、conflictWith: 旧 value 的新条目；旧条目保留 active，不覆盖
    不同 key            → 原样追加
集合顺序 = 写入顺序（渲染截断时「最老」按这个顺序算，与 #12 的对象插入序同义）。

MemoryEntry（dict）：{key, value, kind: stated|inferred, confidence, source: {sessionId, turn}, date, status: active|conflict, conflictWith?}
"""
from typing import Dict, List, Sequence

MemoryEntry = Dict


def upsert_entry(entries: Sequence[MemoryEntry], incoming: MemoryEntry) -> Dict:
    """返回 {entries, stored, outcome: refreshed|conflict|appended}；stored 是写进集合后的那条"""
    for i, e in enumerate(entries):
        if e["key"] == incoming["key"] and e["value"] == incoming["value"]:
            stored = {**e, "date": incoming["date"], "source": dict(incoming["source"])}
            return {"entries": [stored if j == i else x for j, x in enumerate(entries)], "stored": stored, "outcome": "refreshed"}
    active = next((e for e in entries if e["key"] == incoming["key"] and e["status"] == "active"), None)
    if active is not None:
        stored = {**incoming, "source": dict(incoming["source"]), "status": "conflict", "conflictWith": active["value"]}
        return {"entries": [*entries, stored], "stored": stored, "outcome": "conflict"}
    stored = {**incoming, "source": dict(incoming["source"])}
    return {"entries": [*entries, stored], "stored": stored, "outcome": "appended"}


def kv_view(entries: Sequence[MemoryEntry]) -> Dict[str, str]:
    """KV 视图：只取 active 且 stated 的条目，key → value（兼容 #12 之前的 load() 调用方）"""
    out: Dict[str, str] = {}
    for e in entries:
        if e["status"] == "active" and e["kind"] == "stated":
            out[e["key"]] = e["value"]
    return out
