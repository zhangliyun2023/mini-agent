"""用户级长期记忆：跨 session 共享的条目集合（#19 ④：stated / inferred、confidence、source、conflict 不覆盖）。
写入：模型显式调 remember 工具（stated / 1 / 当前轮）；复盘生成器写 inferred（R4）。召回：每轮组 context 时整块放进 system prompt 尾部。
这题不做向量检索——条目少，全量注入比检索更稳，也让「召回时机/放置方式」一句话说清。
"""
import copy
import os
from datetime import datetime, timezone
from typing import Dict, List, Optional, Sequence, Union

from ..util import encode_component, read_json, write_json
from .entries import MemoryEntry, kv_view, upsert_entry

# 旧格式（纯 KV 对象）读入时的来源：不知道是哪一轮说的
LEGACY_SOURCE = {"sessionId": "legacy", "turn": 0}
# set() 直接写入时的来源（测试 / 脚本），不是某一轮对话
DIRECT_SOURCE = {"sessionId": "direct", "turn": 0}


def today_iso(now: Optional[datetime] = None) -> str:
    now = now or datetime.now(timezone.utc)
    return now.astimezone(timezone.utc).strftime("%Y-%m-%d")


class UserMemoryStore:
    """抽象基类：子类只实现 _read / _write"""

    def _read(self, user_id: str) -> List[MemoryEntry]:
        raise NotImplementedError

    def _write(self, user_id: str, entries: List[MemoryEntry]) -> None:
        raise NotImplementedError

    def entries(self, user_id: str) -> List[MemoryEntry]:
        """全部条目（含 conflict），写入顺序"""
        return [copy.deepcopy(e) for e in self._read(user_id)]

    def upsert(self, user_id: str, entry: MemoryEntry) -> MemoryEntry:
        """按 entries.py 的规则写一条；返回写进集合后的那条（status 告诉调用方是否成了 conflict）"""
        r = upsert_entry(self._read(user_id), entry)
        self._write(user_id, r["entries"])
        return r["stored"]

    def load(self, user_id: str) -> Dict[str, str]:
        """KV 视图：active 且 stated 的 key → value（兼容 #12 之前的调用方）"""
        return kv_view(self._read(user_id))

    def set(self, user_id: str, key: str, value: str, source: Optional[dict] = None) -> MemoryEntry:
        """便捷写法：stated / confidence 1 / 直接写入（没有会话来源）；同样走 upsert 规则，同 key 不同值不覆盖"""
        return self.upsert(user_id, {"key": key, "value": value, "kind": "stated", "confidence": 1, "source": dict(source or DIRECT_SOURCE), "date": today_iso(), "status": "active"})


class MemoryUserMemoryStore(UserMemoryStore):
    def __init__(self) -> None:
        self._map: Dict[str, List[MemoryEntry]] = {}

    def _read(self, user_id: str) -> List[MemoryEntry]:
        return self._map.get(user_id, [])

    def _write(self, user_id: str, entries: List[MemoryEntry]) -> None:
        self._map[user_id] = entries


class FileUserMemoryStore(UserMemoryStore):
    """盘上格式：`{ "entries": MemoryEntry[] }`。读到旧格式（纯 KV 对象）时视为 stated / confidence 1 / source legacy，date 取文件 mtime；下次写入即转成新格式。"""

    def __init__(self, root: str):
        self.root = root

    def _path(self, u: str) -> str:
        os.makedirs(self.root, exist_ok=True)
        return os.path.join(self.root, f"{encode_component(u)}.memory.json")

    def _read(self, user_id: str) -> List[MemoryEntry]:
        p = self._path(user_id)
        if not os.path.exists(p):
            return []
        parsed = read_json(p)
        if isinstance(parsed, dict) and isinstance(parsed.get("entries"), list):
            return parsed["entries"]
        date = today_iso(datetime.fromtimestamp(os.stat(p).st_mtime, tz=timezone.utc))
        return [{"key": k, "value": str(v), "kind": "stated", "confidence": 1, "source": dict(LEGACY_SOURCE), "date": date, "status": "active"} for k, v in (parsed or {}).items()]

    def _write(self, user_id: str, entries: List[MemoryEntry]) -> None:
        write_json(self._path(user_id), {"entries": entries})


MEMORY_OPEN = "<memory>\n"
MEMORY_CLOSE = "\n</memory>"


def render_entry_line(e: MemoryEntry) -> str:
    """一条条目在记忆块里的样子：stated 原样；inferred 标「（推断）」；conflict 渲染成「待确认」，两个值都给模型看，等用户下次出现时确认"""
    if e["status"] == "conflict":
        return f"- {e['key']}（待确认：昨天说 {e['value']}，之前记 {e.get('conflictWith', '?')}）"
    if e["kind"] == "inferred":
        return f"- {e['key']}: {e['value']}（推断）"
    return f"- {e['key']}: {e['value']}"


def _to_entries(mem: Union[Sequence[MemoryEntry], Dict[str, str]]) -> List[MemoryEntry]:
    if isinstance(mem, dict):
        return [{"key": k, "value": v, "kind": "stated", "confidence": 1, "source": dict(DIRECT_SOURCE), "date": "", "status": "active"} for k, v in mem.items()]
    return list(mem)


def drop_order(entries: Sequence[MemoryEntry]) -> List[int]:
    """预算不够时的丢弃顺序（#19 Q6）：先丢 conflict，再丢 inferred（confidence 低的先），stated 之间最老的先丢；同级按写入顺序最老先。
    返回条目下标序列，前面的先丢。全 stated 时就是「最老先丢」= #12 的行为。"""

    def rank(e: MemoryEntry) -> int:
        return 0 if e["status"] == "conflict" else 1 if e["kind"] == "inferred" else 2

    return sorted(range(len(entries)), key=lambda i: (rank(entries[i]), entries[i]["confidence"] if rank(entries[i]) == 1 else 0, i))


def render_memory(mem: Union[Sequence[MemoryEntry], Dict[str, str]], limit: Optional[int] = None) -> Dict:
    """渲染记忆块。limit 是整块（含 <memory> 标签）的字符上限：超限时按 drop_order 逐条丢到装得下为止，保留的条目仍按写入顺序排。
    也接受 #12 的 KV 对象（视为 stated，此时退化为「最老先丢」）。不做时间衰减、不做检索（见 docs/NEXT_STEPS.md）。
    返回 {block, truncated?: {total, kept}}"""
    entries = _to_entries(mem)
    if not entries:
        return {"block": ""}
    lines = [render_entry_line(e) for e in entries]

    def block_of(kept: set) -> str:
        idx = sorted(kept)
        return f"{MEMORY_OPEN}{chr(10).join(lines[i] for i in idx)}{MEMORY_CLOSE}" if idx else ""

    kept = set(range(len(entries)))
    if limit is not None:
        for i in drop_order(entries):
            if len(block_of(kept)) <= limit:
                break
            kept.discard(i)
    block = block_of(kept)
    if len(kept) == len(entries):
        return {"block": block}
    return {"block": block, "truncated": {"total": len(entries), "kept": len(kept)}}
