"""#19 ⑥：三态分开——full / partial / none；partial_read 不得冒充 no_chat。夹具实现 TranscriptReader（只依赖最小接口）。"""
from mini_agent.review.collect import collect_yesterday
from mini_agent.review.window import yesterday_window


class Fixture:
    def __init__(self, data):
        self.data = data

    def list(self, u):
        return list(self.data.get(u, {}).keys())

    def read(self, u, s):
        return self.data[u][s] if u in self.data and s in self.data[u] else None


_seq = [0]


def line(session_id, ts, role="user", content=None):
    _seq[0] += 1
    return {"ts": ts, "userId": "u1", "sessionId": session_id, "turn": 1, "traceId": f"t-{_seq[0]}", "role": role, "content": content or f"m{_seq[0]}"}


# 计划日期 2026-09-15、Asia/Shanghai：昨天 = 09-14 00:00+08 .. 09-15 00:00+08
W = yesterday_window("2026-09-15", "Asia/Shanghai")


def test_only_lines_in_window_full():
    keep1 = line("s1", "2026-09-14T09:00:00+08:00", "user", "早上好")
    keep2 = line("s1", "2026-09-14T09:00:05+08:00", "assistant", "早")
    drop = line("s1", "2026-09-13T22:00:00+08:00", "user", "前天的")
    r = collect_yesterday(Fixture({"u1": {"s1": [drop, keep1, keep2]}}), "u1", W)
    assert r["coverage"] == "full" and r["unreadable"] == []
    assert r["sessions"] == [{"sessionId": "s1", "lines": [keep1, keep2]}]


def test_only_sessions_with_lines_in_window():
    y = line("s-y", "2026-09-14T15:00:00+08:00")
    old = line("s-old", "2026-09-10T15:00:00+08:00")
    r = collect_yesterday(Fixture({"u1": {"s-old": [old], "s-y": [y]}}), "u1", W)
    assert [s["sessionId"] for s in r["sessions"]] == ["s-y"] and r["coverage"] == "full"


def test_boundaries():
    today0030 = line("s1", "2026-09-15T00:30:00+08:00", "user", "今天的")
    y0030 = line("s1", "2026-09-14T00:30:00+08:00", "user", "昨天凌晨")
    y2330 = line("s1", "2026-09-14T23:30:00+08:00", "user", "昨天深夜")
    end_exact = line("s1", "2026-09-15T00:00:00+08:00", "user", "恰好 end")
    r = collect_yesterday(Fixture({"u1": {"s1": [y0030, y2330, end_exact, today0030]}}), "u1", W)
    assert [l["content"] for l in r["sessions"][0]["lines"]] == ["昨天凌晨", "昨天深夜"]


def test_unreadable_session_partial():
    ok = line("s-ok", "2026-09-14T10:00:00+08:00")
    r = collect_yesterday(Fixture({"u1": {"s-ok": [ok], "s-broken": None}}), "u1", W)
    assert r["coverage"] == "partial" and r["unreadable"] == ["s-broken"]
    assert r["sessions"] == [{"sessionId": "s-ok", "lines": [ok]}]


def test_unreadable_only_still_partial():
    r = collect_yesterday(Fixture({"u1": {"s-broken": None}}), "u1", W)
    assert r == {"sessions": [], "coverage": "partial", "unreadable": ["s-broken"]}


def test_bad_ts_partial():
    bad = {**line("s-nots", "2026-09-14T10:00:00+08:00"), "ts": ""}
    garbage = {**line("s-garbage", "2026-09-14T10:00:00+08:00"), "ts": "昨天下午"}
    good = line("s-good", "2026-09-14T10:00:00+08:00")
    r = collect_yesterday(Fixture({"u1": {"s-nots": [bad], "s-garbage": [garbage], "s-good": [good]}}), "u1", W)
    assert r["coverage"] == "partial"
    assert sorted(r["unreadable"]) == ["s-garbage", "s-nots"]
    assert [s["sessionId"] for s in r["sessions"]] == ["s-good"]


def test_none_when_nothing():
    assert collect_yesterday(Fixture({}), "u1", W) == {"sessions": [], "coverage": "none", "unreadable": []}
    old = line("s1", "2026-09-01T10:00:00+08:00")
    assert collect_yesterday(Fixture({"u1": {"s1": [old]}}), "u1", W) == {"sessions": [], "coverage": "none", "unreadable": []}


def test_only_this_user():
    other = line("s-other", "2026-09-14T10:00:00+08:00")
    assert collect_yesterday(Fixture({"u2": {"s-other": [other]}}), "u1", W) == {"sessions": [], "coverage": "none", "unreadable": []}
