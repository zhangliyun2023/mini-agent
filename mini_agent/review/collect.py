"""#19 ⑥：按用户列会话，只收 ts 落在 [start, end) 内的转写行，按会话分组；三态覆盖分开。

CollectResult（dict）：{sessions: [{sessionId, lines}], coverage: full|partial|none, unreadable: [session_id]}
    full = 有区间内的行且全部读得出；partial = 有会话读不出（文件缺失 / 读不出 / 行没有可解析的 ts）；none = 一条都没有且没有读失败
    unreadable 非空时 coverage 至少 partial，不得冒充 none
"""
from typing import Any, Dict

from ..util import parse_ts


def collect_yesterday(reader: Any, user_id: str, window: Dict) -> Dict[str, Any]:
    start = int(window["start"].timestamp() * 1000)
    end = int(window["end"].timestamp() * 1000)
    sessions = []
    unreadable = []
    for session_id in reader.list(user_id):
        lines = reader.read(user_id, session_id)
        if lines is None:
            unreadable.append(session_id)
            continue
        stamps = [parse_ts(l.get("ts")) for l in lines]
        if any(t is None for t in stamps):
            # 有行读不出时间 → 无法判定它属不属于昨天，整个会话按读不出算（⑥：partial_read 写明覆盖范围）
            unreadable.append(session_id)
            continue
        picked = [l for l, t in zip(lines, stamps) if start <= t < end]  # type: ignore[operator]
        if picked:
            sessions.append({"sessionId": session_id, "lines": picked})
    coverage = "partial" if unreadable else "full" if sessions else "none"
    return {"sessions": sessions, "coverage": coverage, "unreadable": unreadable}
