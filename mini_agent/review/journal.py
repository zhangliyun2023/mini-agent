"""#19 ③ / ⑩：复盘日志（journal）按幂等键 userId + date 存一条；文件版落 `data/reviews/<user>/<date>.json`。
重跑同键只递增 attempts（见 run.py），所以 save 是整条覆盖，不追加。"""
import copy
import os
from typing import Dict, Optional

from ..util import encode_component, read_json, write_json


class MemoryReviewJournalStore:
    """内存版：测试与单进程服务用"""

    def __init__(self) -> None:
        self._map: Dict[str, dict] = {}

    def get(self, user_id: str, date: str) -> Optional[dict]:
        j = self._map.get(f"{user_id}::{date}")
        return copy.deepcopy(j) if j else None

    def save(self, journal: dict) -> None:
        self._map[f"{journal['userId']}::{journal['date']}"] = copy.deepcopy(journal)


class FileReviewJournalStore:
    """文件版：`<root>/<user>/<date>.json`，一键一文件"""

    def __init__(self, root: str):
        self.root = root

    def _path(self, u: str, d: str) -> str:
        return os.path.join(self.root, encode_component(u), f"{encode_component(d)}.json")

    def get(self, user_id: str, date: str) -> Optional[dict]:
        p = self._path(user_id, date)
        return read_json(p) if os.path.exists(p) else None

    def save(self, journal: dict) -> None:
        write_json(self._path(journal["userId"], journal["date"]), journal)
