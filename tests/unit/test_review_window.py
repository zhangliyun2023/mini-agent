"""#19 ②：「昨天」= 任务时区的昨日 00:00 到今日 00:00，按计划日期算，不是「过去 24 小时」。断言只打在返回的 start / end 的 ISO 值上。"""
import pytest

from mini_agent.review.window import yesterday_window
from mini_agent.util import iso, parse_ts


def iso_pair(w):
    return [iso(w["start"]), iso(w["end"])]


def test_utc():
    assert iso_pair(yesterday_window("2026-09-15", "UTC")) == ["2026-09-14T00:00:00.000Z", "2026-09-15T00:00:00.000Z"]


def test_shanghai_eight_hours_earlier():
    assert iso_pair(yesterday_window("2026-09-15", "Asia/Shanghai")) == ["2026-09-13T16:00:00.000Z", "2026-09-14T16:00:00.000Z"]


def test_shanghai_vs_utc_lengths():
    sh = yesterday_window("2026-09-15", "Asia/Shanghai")
    utc = yesterday_window("2026-09-15", "UTC")
    assert (utc["start"] - sh["start"]).total_seconds() == 8 * 3600
    assert (sh["end"] - sh["start"]).total_seconds() == 24 * 3600
    assert (utc["end"] - utc["start"]).total_seconds() == 24 * 3600


def test_shanghai_boundaries():
    w = yesterday_window("2026-09-15", "Asia/Shanghai")
    start, end = int(w["start"].timestamp() * 1000), int(w["end"].timestamp() * 1000)

    def in_win(s):
        t = parse_ts(s)
        return start <= t < end

    assert in_win("2026-09-15T00:30:00+08:00") is False
    assert in_win("2026-09-14T23:30:00+08:00") is True
    assert in_win("2026-09-14T00:30:00+08:00") is True
    assert in_win("2026-09-13T23:59:59+08:00") is False


def test_cross_month():
    assert iso_pair(yesterday_window("2026-03-01", "UTC")) == ["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]
    assert iso_pair(yesterday_window("2026-03-01", "Asia/Shanghai")) == ["2026-02-27T16:00:00.000Z", "2026-02-28T16:00:00.000Z"]


def test_cross_year():
    assert iso_pair(yesterday_window("2027-01-01", "UTC")) == ["2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]
    assert iso_pair(yesterday_window("2027-01-01", "Asia/Shanghai")) == ["2026-12-30T16:00:00.000Z", "2026-12-31T16:00:00.000Z"]


def test_dst_switch_day_is_23_hours():
    # 2026-03-08 02:00 EST → 03:00 EDT；昨天 = 03-08 00:00 EST (05:00Z)，今天 = 03-09 00:00 EDT (04:00Z)
    assert iso_pair(yesterday_window("2026-03-09", "America/New_York")) == ["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]


def test_bad_inputs_raise():
    with pytest.raises(ValueError):
        yesterday_window("2026/09/15", "UTC")
    with pytest.raises(ValueError):
        yesterday_window("2026-02-30", "UTC")
    with pytest.raises(ValueError):
        yesterday_window("2026-09-15", "Mars/Olympus")
