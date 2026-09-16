"""#19 R7：复盘表的四条 P0 不变量各一红一绿（与 turn 的五条同法）——
  绿：真实跑 run_review（真落盘）得到的证据通过 oracle；红：把证据篡改成违反的样子，oracle 必须点名。"""
import copy
import json
import os
import re

from mini_agent.memory.user_memory import FileUserMemoryStore
from mini_agent.review.invariants import brief_not_verbatim, every_highlight_has_source, idempotent, no_overwrite_on_conflict
from mini_agent.review.journal import FileReviewJournalStore
from mini_agent.review.run import ReviewDeps, run_review
from mini_agent.review.trace import review_trace_sink
from mini_agent.review.transcript import FileTranscriptStore
from mini_agent.session.store import FileSessionStore

USER, DATE, TZ = "A", "2026-09-15", "Asia/Shanghai"
YDAY = "2026-09-14T10:00:00+08:00"


def line(session_id, turn, role, content, ts=YDAY):
    return {"ts": ts, "userId": USER, "sessionId": session_id, "turn": turn, "traceId": f"{USER}/{session_id}/{turn}", "role": role, "content": content}


def entry(key, value):
    return {"key": key, "value": value, "kind": "inferred", "confidence": 0.8, "source": {"sessionId": "s1", "turn": 1}, "date": "2026-09-14", "status": "active"}


NORMAL = {"entries": [entry("deadline", "9 月 20 日交报告"), entry("project", "PR #19")], "highlights": [{"text": "把复盘报告交给老板", "why_today": "due_today", "source": {"sessionId": "s1", "turn": 1}}], "method": "llm", "warnings": []}
YESTERDAY = [line("s1", 1, "user", "我 9 月 20 日要交报告，老板催得很紧，明天一早就得发出去了"), line("s1", 1, "assistant", "<final>记下了</final>"), line("s1", 2, "user", "另外 PR #19 也要跟进")]


class Setup:
    def __init__(self, d):
        self.dir = d
        self.transcripts = FileTranscriptStore(os.path.join(d, "transcripts"))
        self.memory = FileUserMemoryStore(os.path.join(d, "memory"))
        self.sessions = FileSessionStore(os.path.join(d, "sessions"))
        self.journal = FileReviewJournalStore(os.path.join(d, "reviews"))
        self.trace = review_trace_sink(os.path.join(d, "trace", "reviews"))

    def deps(self, c):
        return ReviewDeps(transcripts=self.transcripts, memory=self.memory, sessions=self.sessions, journal=self.journal, consolidate=lambda inp: c, trace=self.trace)


def read_journals(d):
    p = os.path.join(d, "reviews", USER)
    return [json.load(open(os.path.join(p, f), encoding="utf8")) for f in os.listdir(p)]


def read_memory(d):
    return json.load(open(os.path.join(d, "memory", f"{USER}.memory.json"), encoding="utf8"))["entries"]


def run_twice(d, c=NORMAL):
    s = Setup(d)
    s.transcripts.append(YESTERDAY)
    deps = s.deps(c)
    first = run_review(deps, USER, DATE, TZ, deliver_to="w1")
    after_first = read_memory(d)
    second = run_review(deps, USER, DATE, TZ, deliver_to="w1")
    return {"first": first, "second": second, "memoryAfterFirst": after_first, "memoryAfterLast": read_memory(d), "journals": read_journals(d)}


def test_inv1_idempotent(tmp):
    r = run_twice(tmp)
    assert len(r["journals"]) == 1
    assert idempotent({"userId": USER, "date": DATE, "runs": 2, "journals": r["journals"], "memoryAfterFirst": r["memoryAfterFirst"], "memoryAfterLast": r["memoryAfterLast"]}) == []


def test_inv1_red(tmp):
    r = run_twice(tmp)
    base = {"userId": USER, "date": DATE, "runs": 2, "journals": r["journals"], "memoryAfterFirst": r["memoryAfterFirst"], "memoryAfterLast": r["memoryAfterLast"]}
    assert re.search("journal 应恰 1 份，实际 2 份", "\n".join(idempotent({**base, "journals": [*r["journals"], copy.deepcopy(r["journals"][0])]})))
    assert re.search("attempts 应为 2，实际 1", "\n".join(idempotent({**base, "journals": [{**r["journals"][0], "attempts": 1}]})))
    assert re.search("记忆条目数变了：2 → 3", "\n".join(idempotent({**base, "memoryAfterLast": [*r["memoryAfterLast"], entry("extra", "第二次多写的")]})))


def run_with_existing(d):
    s = Setup(d)
    s.memory.set(USER, "deadline", "9 月 18 日交报告", {"sessionId": "s0", "turn": 3})
    before = read_memory(d)
    s.transcripts.append(YESTERDAY)
    run_review(s.deps(NORMAL), USER, DATE, TZ)
    return before, read_memory(d)


def test_inv2_no_overwrite_on_conflict(tmp):
    before, after = run_with_existing(tmp)
    assert [[e["key"], e["status"]] for e in after] == [["deadline", "active"], ["deadline", "conflict"], ["project", "active"]]
    assert no_overwrite_on_conflict({"before": before, "after": after}) == []


def test_inv2_red(tmp):
    before, after = run_with_existing(tmp)
    overwritten = [({**e, "status": "active", "conflictWith": None} if e["key"] == "deadline" else e) for e in after if not (e["key"] == "deadline" and e["value"] == "9 月 18 日交报告")]
    v = no_overwrite_on_conflict({"before": before, "after": overwritten})
    assert v
    assert re.search("deadline.*旧值「9 月 18 日交报告」.*(不见了|不再 active)", "\n".join(v))
    assert re.search("deadline.*新值「9 月 20 日交报告」.*active", "\n".join(v))


def test_inv3_every_highlight_has_source(tmp):
    first = run_twice(tmp)["first"]
    assert first["journal"]["brief"] is not None
    assert every_highlight_has_source({"brief": first["journal"]["brief"], "lines": YESTERDAY}) == []


def test_inv3_red(tmp):
    b = run_twice(tmp)["first"]["journal"]["brief"]
    bad_turn = {**b, "highlights": [{**b["highlights"][0], "source": {"sessionId": "s1", "turn": 99}}]}
    assert re.search("s1 第 99 轮.*不存在", "\n".join(every_highlight_has_source({"brief": bad_turn, "lines": YESTERDAY})))
    bad_session = {**b, "highlights": [{**b["highlights"][0], "source": {"sessionId": "ghost", "turn": 1}}]}
    assert re.search("ghost 第 1 轮.*不存在", "\n".join(every_highlight_has_source({"brief": bad_session, "lines": YESTERDAY})))
    no_source = {**b, "highlights": [{"text": b["highlights"][0]["text"], "why_today": "due_today"}]}
    assert re.search("没有 source", "\n".join(every_highlight_has_source({"brief": no_source, "lines": YESTERDAY})))


def test_inv4_brief_not_verbatim(tmp):
    first = run_twice(tmp)["first"]
    assert brief_not_verbatim({"brief": first["journal"]["brief"], "lines": YESTERDAY}) == []
    assert brief_not_verbatim({"brief": None, "lines": YESTERDAY}) == []


def test_inv4_red(tmp):
    b = run_twice(tmp)["first"]["journal"]["brief"]
    whole = {**b, "highlights": [{**b["highlights"][0], "text": "另外 PR #19 也要跟进"}]}
    assert re.search("与昨天 s1 第 2 轮 user 的原话逐字重合", "\n".join(brief_not_verbatim({"brief": whole, "lines": YESTERDAY})))
    long = {**b, "highlights": [{**b["highlights"][0], "text": "我 9 月 20 日要交报告，老板催得很紧，明天一早"}]}
    assert re.search("s1 第 1 轮 user", "\n".join(brief_not_verbatim({"brief": long, "lines": YESTERDAY})))
    short = {**b, "highlights": [{**b["highlights"][0], "text": "老板催得很紧，明天一早就得发出去"}]}
    assert len("老板催得很紧，明天一早就得发出去") < 20
    assert brief_not_verbatim({"brief": short, "lines": YESTERDAY}) == []
