"""#19 ②：「昨天」= 任务时区的昨日 00:00 到今日 00:00，按计划日期算，不按执行时刻。只用标准库 zoneinfo。"""
import re
from datetime import date, datetime, timedelta, timezone
from typing import Dict

from zoneinfo import ZoneInfo

DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _zone(tz: str) -> ZoneInfo:
    try:
        return ZoneInfo(tz)
    except Exception as e:  # noqa: BLE001 —— ZoneInfoKeyError / ValueError 都算不存在的时区
        raise ValueError(f"不存在的时区：{tz}") from e


def zoned_midnight(d: date, tz: str) -> datetime:
    """tz 里某天当地 00:00 对应的 UTC 瞬间（夏令时切换日按当地墙钟算）"""
    return datetime(d.year, d.month, d.day, tzinfo=_zone(tz)).astimezone(timezone.utc)


def yesterday_window(date_str: str, tz: str) -> Dict[str, datetime]:
    """计划日期 date（今天）在 tz 里的「昨天」：{start: 前一天 00:00, end: 当天 00:00}（UTC datetime）。
    坏日期字符串、不存在的日期、不存在的时区都抛 ValueError。"""
    m = DATE_RE.match(date_str)
    if not m:
        raise ValueError(f"计划日期必须是 YYYY-MM-DD：{date_str}")
    try:
        today = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        raise ValueError(f"不存在的日期：{date_str}")
    _zone(tz)
    return {"start": zoned_midnight(today - timedelta(days=1), tz), "end": zoned_midnight(today, tz)}


def today_in(tz: str, now: datetime = None) -> str:  # type: ignore[assignment]
    """任务时区的今天 YYYY-MM-DD"""
    now = now or datetime.now(timezone.utc)
    return now.astimezone(_zone(tz)).strftime("%Y-%m-%d")
