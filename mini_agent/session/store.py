"""Session = 一个窗口。同一用户的两个窗口是两个 session，各自有历史、状态袋、轮次计数。

Session（dict）：{userId, sessionId, history: [ChatMessage], summary?: str, state: dict, turns: int, createdAt, updatedAt}
    history  已完成轮次的对话历史（已剥掉历史 think，工具结果已精简）
    summary  压缩产生的摘要，放在 history 之前
    state    有状态工具（todo 等）的数据袋
"""
import os
from typing import Dict, List, Protocol

from ..util import decode_component, encode_component, iso_now, read_json, write_json

Session = Dict


def fresh(user_id: str, session_id: str) -> Session:
    now = iso_now()
    return {"userId": user_id, "sessionId": session_id, "history": [], "state": {}, "turns": 0, "createdAt": now, "updatedAt": now}


class SessionStore(Protocol):
    def get(self, user_id: str, session_id: str) -> Session: ...
    def save(self, session: Session) -> None: ...
    def list(self, user_id: str) -> List[str]: ...


class MemorySessionStore:
    """内存版：测试与单进程服务用"""

    def __init__(self) -> None:
        self._map: Dict[str, Session] = {}

    @staticmethod
    def _key(u: str, s: str) -> str:
        return f"{u}::{s}"

    def get(self, user_id: str, session_id: str) -> Session:
        k = self._key(user_id, session_id)
        if k not in self._map:
            self._map[k] = fresh(user_id, session_id)
        return self._map[k]

    def save(self, session: Session) -> None:
        session["updatedAt"] = iso_now()
        self._map[self._key(session["userId"], session["sessionId"])] = session

    def list(self, user_id: str) -> List[str]:
        return [s["sessionId"] for s in self._map.values() if s["userId"] == user_id]


class FileSessionStore:
    """文件版：每个 session 一个 JSON，CLI 多开终端时靠它接着聊"""

    def __init__(self, root: str):
        self.root = root

    def _path(self, u: str, s: str) -> str:
        d = os.path.join(self.root, encode_component(u))
        os.makedirs(d, exist_ok=True)
        return os.path.join(d, f"{encode_component(s)}.json")

    def get(self, user_id: str, session_id: str) -> Session:
        p = self._path(user_id, session_id)
        return read_json(p) if os.path.exists(p) else fresh(user_id, session_id)

    def save(self, session: Session) -> None:
        session["updatedAt"] = iso_now()
        write_json(self._path(session["userId"], session["sessionId"]), session)

    def list(self, user_id: str) -> List[str]:
        d = os.path.join(self.root, encode_component(user_id))
        if not os.path.isdir(d):
            return []
        return [decode_component(f[: -len(".json")]) for f in sorted(os.listdir(d)) if f.endswith(".json")]
