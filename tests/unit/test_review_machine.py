"""#19 R7：复盘表是闸——表里没列的 (状态, 事件) 在运行时被拦下。与 test_agent_loop 的「残缺表」同法：从表里抠掉一格再跑真实的 run_review。
断言只打用户可见契约：盘上 trace 文件、journal 文件、记忆文件是否存在、整合器有没有被调。"""
import json
import os
import re

import pytest

from contracts.review_machine import review_machine
from mini_agent.memory.user_memory import FileUserMemoryStore
from mini_agent.review.journal import FileReviewJournalStore
from mini_agent.review.run import ReviewDeps, run_review
from mini_agent.review.trace import review_trace_sink
from mini_agent.review.transcript import FileTranscriptStore
from mini_agent.runtime.trace import format_transition
from mini_agent.session.store import FileSessionStore

USER, DATE, TZ = "A", "2026-09-15", "Asia/Shanghai"
YDAY = "2026-09-14T10:00:00+08:00"
NORMAL = {"entries": [{"key": "deadline", "value": "9 月 20 日交报告", "kind": "inferred", "confidence": 0.8, "source": {"sessionId": "s1", "turn": 1}, "date": "2026-09-14", "status": "active"}], "highlights": [{"text": "把复盘报告交给老板", "why_today": "due_today", "source": {"sessionId": "s1", "turn": 1}}], "method": "llm", "warnings": []}


def line(session_id, turn, role, content, ts=YDAY):
    return {"ts": ts, "userId": USER, "sessionId": session_id, "turn": turn, "traceId": f"{USER}/{session_id}/{turn}", "role": role, "content": content}


class Setup:
    def __init__(self, d):
        self.dir = d
        self.transcripts = FileTranscriptStore(os.path.join(d, "transcripts"))
        self.memory = FileUserMemoryStore(os.path.join(d, "memory"))
        self.sessions = FileSessionStore(os.path.join(d, "sessions"))
        self.journal = FileReviewJournalStore(os.path.join(d, "reviews"))
        self.trace = review_trace_sink(os.path.join(d, "trace", "reviews"))

    def deps(self, c, **kw):
        return ReviewDeps(transcripts=self.transcripts, memory=self.memory, sessions=self.sessions, journal=self.journal, consolidate=c, trace=self.trace, **kw)


class FakeConsolidate:
    def __init__(self, result):
        self.result, self.calls = result, []

    def __call__(self, inp):
        self.calls.append(inp)
        return self.result


def read_journal(d):
    return json.load(open(os.path.join(d, "reviews", USER, f"{DATE}.json"), encoding="utf8"))


def read_trace(d):
    return [json.loads(l) for l in open(os.path.join(d, "trace", "reviews", f"{USER}-{DATE}.jsonl"), encoding="utf8").read().strip().split("\n")]


def machine_without(event):
    return review_machine.replace(rows=[r for r in review_machine.rows if r.event != event])


def test_gate_without_collected(tmp_path):
    a = Setup(str(tmp_path / "a"))
    a.transcripts.append([line("s1", 1, "user", "我 9 月 20 日要交报告")])
    c = FakeConsolidate(NORMAL)
    r = run_review(a.deps(c, machine=machine_without("COLLECTED")), USER, DATE, TZ, deliver_to="w1")
    records = read_trace(a.dir)
    assert [format_transition(x) for x in records] == ["rv-start", "collecting --COLLECTED--> failed_partial [unknown]"]
    last = records[-1]
    assert (last["status"], last["transition"], last["from"], last["to"], last["event"], last["trace_id"], last["feature"]) == ("unknown", None, "collecting", "failed_partial", "COLLECTED", f"review/{USER}/{DATE}", "review")
    assert "未在表里列出" in last["reason"]
    assert c.calls == []
    assert not os.path.exists(os.path.join(a.dir, "memory", f"{USER}.memory.json"))
    assert not os.path.exists(os.path.join(a.dir, "sessions"))
    j = read_journal(a.dir)
    assert (j["status"], j["coverage"], j["attempts"], j["entries_written"], j["brief"], j["delivered_to"]) == ("partial_read", "full", 1, 0, None, [])
    assert re.search(r"未建模的状态转移：collecting \+ COLLECTED", "\n".join(j.get("warnings", [])))
    assert r == {"journal": j, "replayed": False}

    b = Setup(str(tmp_path / "b"))
    b.transcripts.append([line("s1", 1, "user", "我 9 月 20 日要交报告")])
    c2 = FakeConsolidate(NORMAL)
    with pytest.raises(RuntimeError, match=r"未建模的状态转移：collecting \+ COLLECTED"):
        run_review(b.deps(c2, machine=machine_without("COLLECTED"), unknown_transition="throw"), USER, DATE, TZ)
    assert c2.calls == []
    assert not os.path.exists(os.path.join(b.dir, "memory", f"{USER}.memory.json"))
    assert [format_transition(x) for x in read_trace(b.dir)] == ["rv-start", "collecting --COLLECTED--> failed_partial [unknown]"]
    assert read_journal(b.dir)["status"] == "partial_read"


def test_gate_without_delivered(tmp):
    a = Setup(tmp)
    a.transcripts.append([line("s1", 1, "user", "我 9 月 20 日要交报告")])
    c = FakeConsolidate(NORMAL)
    run_review(a.deps(c, machine=machine_without("DELIVERED")), USER, DATE, TZ, deliver_to="w1")
    records = read_trace(a.dir)
    assert [format_transition(x) for x in records] == ["rv-start", "rv-collected-full", "rv-consolidated", "rv-presented [noop]", "presenting --DELIVERED--> failed_partial [unknown]"]
    assert len(c.calls) == 1
    assert os.path.exists(os.path.join(a.dir, "memory", f"{USER}.memory.json"))
    assert [e["kind"] for e in records[-1]["effects"]] == ["deliver", "journal"]
    j = read_journal(a.dir)
    assert (j["status"], j["coverage"], j["entries_written"], j["delivered_to"]) == ("partial_read", "full", 1, ["w1"])
    assert re.search(r"未建模的状态转移：presenting \+ DELIVERED", "\n".join(j.get("warnings", [])))
