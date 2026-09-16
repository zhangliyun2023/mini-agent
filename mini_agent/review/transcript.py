"""转写（Raw 层，#19 Q2）：轮末把本轮消息原样追加，不压缩、不摘要。
复盘只读转写，不读 session.history（history 会被压缩）。
一行一条消息；user 的 ts = 轮开始，其余 = 轮结束。assistant 内容与写进 history 的同一批（已剥 think，保留 <final> 标签）。

TranscriptLine（dict）：{ts, userId, sessionId, turn, traceId, role, content, name?}
"""
import copy
import json
import os
from typing import Dict, List

from ..util import append_jsonl, decode_component, encode_component


class MemoryTranscriptStore:
    """内存版：测试与单进程服务用"""

    def __init__(self) -> None:
        self._map: Dict[str, List[dict]] = {}

    @staticmethod
    def _key(u: str, s: str) -> str:
        return f"{u} {s}"

    def append(self, lines: List[dict]) -> None:
        for l in lines:
            self._map.setdefault(self._key(l["userId"], l["sessionId"]), []).append(copy.deepcopy(l))

    def read(self, user_id: str, session_id: str) -> List[dict]:
        return [copy.deepcopy(l) for l in self._map.get(self._key(user_id, session_id), [])]

    def list(self, user_id: str) -> List[str]:
        prefix = f"{user_id} "
        return [k[len(prefix):] for k in self._map if k.startswith(prefix)]


class FileTranscriptStore:
    """文件版：`<root>/<user>/<session>.jsonl`，append-only；坏行抛错（run.py 的 transcript_reader 接成 None）"""

    def __init__(self, root: str):
        self.root = root

    def _path(self, u: str, s: str) -> str:
        return os.path.join(self.root, encode_component(u), encode_component(s) + ".jsonl")

    def append(self, lines: List[dict]) -> None:
        for l in lines:
            append_jsonl(self._path(l["userId"], l["sessionId"]), l)

    def read(self, user_id: str, session_id: str) -> List[dict]:
        p = self._path(user_id, session_id)
        if not os.path.exists(p):
            return []
        with open(p, encoding="utf8") as f:
            return [json.loads(l) for l in f if l.strip()]

    def list(self, user_id: str) -> List[str]:
        d = os.path.join(self.root, encode_component(user_id))
        if not os.path.isdir(d):
            return []
        return [decode_component(f[: -len(".jsonl")]) for f in sorted(os.listdir(d)) if f.endswith(".jsonl")]
