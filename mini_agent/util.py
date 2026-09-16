"""时间与 JSON 的小工具：与 TS 版落盘格式逐字对齐（ISO 毫秒 + Z、JSON 缩进 2、不转义中文）。"""
import json
import os
import re
from datetime import datetime, timezone
from typing import Any, Optional

_Z_TAIL = re.compile(r"[zZ]$")


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    """`2026-09-15T01:00:00.000Z`：与 JS `Date.prototype.toISOString` 同形（毫秒三位、Z 结尾）"""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    dt = dt.astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def iso_now() -> str:
    return iso(now_utc())


def parse_ts(s: Any) -> Optional[int]:
    """ISO 字符串 → epoch 毫秒；解析不出返回 None（对应 JS 的 Date.parse → NaN）"""
    if not isinstance(s, str) or not s.strip():
        return None
    text = _Z_TAIL.sub("+00:00", s.strip())
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(round(dt.timestamp() * 1000))


def epoch_ms() -> int:
    return int(round(now_utc().timestamp() * 1000))


def dumps(obj: Any, pretty: bool = False) -> str:
    """与 JSON.stringify 对齐：紧凑时无空格；pretty 时缩进 2；中文不转义"""
    if pretty:
        return json.dumps(obj, ensure_ascii=False, indent=2)
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def write_json(path: str, obj: Any) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf8") as f:
        f.write(dumps(obj, pretty=True))


def read_json(path: str) -> Any:
    with open(path, encoding="utf8") as f:
        return json.load(f)


def append_jsonl(path: str, obj: Any) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf8") as f:
        f.write(dumps(obj) + "\n")


def encode_component(s: str) -> str:
    """文件名安全：与 JS encodeURIComponent 同集合"""
    from urllib.parse import quote

    return quote(s, safe="-_.!~*'()")


def decode_component(s: str) -> str:
    from urllib.parse import unquote

    return unquote(s)
