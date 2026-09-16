"""#19 ⑤ 呈现门槛：纯函数，不碰存储、不碰模型。断言只打用户可见契约：brief.text 精确文本 / brief 为 None / dropped 与 warnings 的内容。"""
from mini_agent.review.present import present

src = {"sessionId": "w1", "turn": 3}


def line(turn, role, content):
    return {"ts": f"2026-09-14T1{turn}:00:00.000Z", "userId": "A", "sessionId": "w1", "turn": turn, "traceId": f"t{turn}", "role": role, "content": content}


yesterday = [
    line(1, "user", "今天天气不错，聊聊天"),
    line(1, "assistant", "好呀，想聊什么"),
    line(2, "user", "帮我记一下：周一要把发票交给财务，不然报销要拖到下个月了"),
    line(2, "assistant", "记住了：周一交发票给财务"),
    line(3, "user", "PR #19 今晚合不完，明天继续"),
    line(3, "assistant", "好的，明天继续"),
]


def cons(highlights, warnings=None):
    return {"entries": [], "highlights": highlights, "method": "llm", "warnings": warnings or []}


def test_due_today_prefix():
    r = present(cons([{"text": "把发票交给财务", "why_today": "due_today", "source": src}]), yesterday)
    assert r["brief"] == {"highlights": [{"text": "把发票交给财务", "why_today": "due_today", "source": src}], "text": "今天到期：把发票交给财务"}
    assert r["dropped"] == [] and r["warnings"] == []


def test_three_prefixes_keep_order():
    r = present(cons([
        {"text": "PR #19 收尾合并", "why_today": "unfinished", "source": src},
        {"text": "把发票交给财务", "why_today": "due_today", "source": {"sessionId": "w1", "turn": 2}},
        {"text": "去健身房", "why_today": "planned_today", "source": src},
    ]), yesterday)
    assert r["brief"]["text"] == "昨天没收尾：PR #19 收尾合并\n今天到期：把发票交给财务\n你说过今天要：去健身房"
    assert [h["why_today"] for h in r["brief"]["highlights"]] == ["unfinished", "due_today", "planned_today"]


def test_no_highlights_brief_none():
    assert present(cons([]), yesterday) == {"brief": None, "dropped": [], "warnings": []}


def test_missing_or_invalid_why_today_dropped():
    bad = [{"text": "聊了天气", "source": src}, {"text": "聊了天气", "why_today": "chitchat", "source": src}]
    r = present(cons(bad), yesterday)
    assert r["brief"] is None
    assert [d["reason"] for d in r["dropped"]] == ["missing_why_today", "invalid_why_today:chitchat"]
    assert [d["highlight"] for d in r["dropped"]] == bad


def test_missing_source_dropped_others_kept():
    no_source = {"text": "去健身房", "why_today": "planned_today"}
    bad_source = {"text": "去健身房", "why_today": "planned_today", "source": {"sessionId": "w1"}}
    r = present(cons([no_source, bad_source, {"text": "把发票交给财务", "why_today": "due_today", "source": src}]), yesterday)
    assert r["dropped"] == [{"highlight": no_source, "reason": "missing_source"}, {"highlight": bad_source, "reason": "missing_source"}]
    assert r["brief"]["text"] == "今天到期：把发票交给财务"


def test_verbatim_whole_line_filtered():
    copied = {"text": "记住了：周一交发票 给财务 ", "why_today": "due_today", "source": {"sessionId": "w1", "turn": 2}}
    r = present(cons([copied, {"text": "把发票交给财务", "why_today": "due_today", "source": src}]), yesterday)
    assert r["brief"]["text"] == "今天到期：把发票交给财务"
    assert r["dropped"] == [{"highlight": copied, "reason": "verbatim"}]
    assert r["warnings"] == ["亮点「记住了：周一交发票 给财务 」与昨天 w1 第 2 轮 assistant 的原话逐字重合，已过滤"]


def test_verbatim_substring_threshold():
    long = {"text": "周一要把发票交给财务，不然报销要拖到下个月", "why_today": "due_today", "source": {"sessionId": "w1", "turn": 2}}
    short = {"text": "PR #19 今晚合不完", "why_today": "unfinished", "source": src}
    r = present(cons([long, short]), yesterday)
    assert r["brief"]["text"] == "昨天没收尾：PR #19 今晚合不完"
    assert r["dropped"] == [{"highlight": long, "reason": "verbatim"}]
    assert len(r["warnings"]) == 1 and "与昨天 w1 第 2 轮 user 的原话逐字重合" in r["warnings"][0]


def test_all_filtered_keeps_upstream_warnings():
    copied = {"text": "好的，明天继续", "why_today": "unfinished", "source": src}
    r = present(cons([copied], ["upstream: rule fallback"]), yesterday)
    assert r["brief"] is None
    assert r["dropped"] == [{"highlight": copied, "reason": "verbatim"}]
    assert r["warnings"][0] == "upstream: rule fallback" and len(r["warnings"]) == 2
