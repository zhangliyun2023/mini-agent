"""#19 R1：轮末写不压缩的逐轮转写（Raw 层）。复盘只读转写，不读 session.history。
断言全部落在用户可见契约上：盘上 JSONL 每行内容、ts 单调、与历史的 role/content 一致、读回保序、list 只见本用户。"""
import json
import os
import re

from mini_agent.llm.fake import FakeLLM
from mini_agent.review.transcript import FileTranscriptStore, MemoryTranscriptStore
from mini_agent.runtime.agent import Agent
from mini_agent.session.store import FileSessionStore
from mini_agent.util import parse_ts
from tests.conftest import tc

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


def read_lines(path):
    return [json.loads(l) for l in open(path, encoding="utf8").read().strip().split("\n")]


def build(d, script):
    return Agent(llm=FakeLLM(script), llm_retries=0, sessions=FileSessionStore(os.path.join(d, "sessions")), transcripts=FileTranscriptStore(os.path.join(d, "transcripts")))


def test_two_turns_written_to_jsonl(tmp):
    agent = build(tmp, ["<final>你好</final>", tc("calculator", {"expression": "6*7"}), "<final>答案是 42</final>"])
    r1 = agent.run(user_id="A", session_id="w1", input="hi")
    r2 = agent.run(user_id="A", session_id="w1", input="6*7=?")
    path = os.path.join(tmp, "transcripts", "A", "w1.jsonl")
    assert os.path.exists(path)
    lines = read_lines(path)
    history = agent.sessions.get("A", "w1")["history"]
    assert [{"role": l["role"], "content": l["content"]} for l in lines] == [{"role": m["role"], "content": m["content"]} for m in history]
    assert [l["content"] for l in lines if l["role"] == "assistant"] == ["<final>你好</final>", tc("calculator", {"expression": "6*7"}), "<final>答案是 42</final>"]
    for l in lines:
        assert ISO.match(l["ts"]), l["ts"]
        assert l["userId"] == "A" and l["sessionId"] == "w1"
    assert [l["traceId"] for l in lines if l["turn"] == 1] == [r1["traceId"]] * 2
    assert [l["traceId"] for l in lines if l["turn"] == 2] == [r2["traceId"]] * 4
    assert next(l for l in lines if l["role"] == "tool")["name"] == "calculator"
    assert "name" not in next(l for l in lines if l["role"] == "user")
    ts = [parse_ts(l["ts"]) for l in lines]
    for i in range(1, len(ts)):
        assert ts[i] >= ts[i - 1]
    for turn in (1, 2):
        rows = [l for l in lines if l["turn"] == turn]
        user_ts = parse_ts(next(l for l in rows if l["role"] == "user")["ts"])
        for l in rows:
            assert parse_ts(l["ts"]) >= user_ts


def test_read_back_and_list(tmp):
    agent = build(tmp, ["<final>一</final>", "<final>二</final>", "<final>B 的</final>"])
    agent.run(user_id="A", session_id="w1", input="1")
    agent.run(user_id="A", session_id="w1", input="2")
    agent.run(user_id="B", session_id="w9", input="b")
    store = FileTranscriptStore(os.path.join(tmp, "transcripts"))
    assert store.read("A", "w1") == read_lines(os.path.join(tmp, "transcripts", "A", "w1.jsonl"))
    assert [[l["turn"], l["role"], l["content"]] for l in store.read("A", "w1")] == [[1, "user", "1"], [1, "assistant", "<final>一</final>"], [2, "user", "2"], [2, "assistant", "<final>二</final>"]]
    assert store.list("A") == ["w1"] and store.list("B") == ["w9"] and store.list("nobody") == []
    assert store.read("A", "w9") == []


def test_default_memory_transcripts():
    agent = Agent(llm=FakeLLM(["<final>ok</final>", "<final>b</final>"]), llm_retries=0)
    agent.run(user_id="A", session_id="s", input="go")
    agent.run(user_id="B", session_id="t", input="go")
    lines = agent.transcripts.read("A", "s")
    assert [[l["role"], l["content"]] for l in lines] == [["user", "go"], ["assistant", "<final>ok</final>"]]
    assert all(l["turn"] == 1 and l["traceId"] == "A/s/1" and ISO.match(l["ts"]) for l in lines)
    assert agent.transcripts.list("A") == ["s"] and agent.transcripts.list("B") == ["t"]
    assert MemoryTranscriptStore().read("A", "s") == []


def test_think_stripped_in_transcript():
    agent = Agent(llm=FakeLLM(["<think>想一想</think><final>剥掉了</final>"]), llm_retries=0)
    agent.run(user_id="A", session_id="s", input="go")
    assert [l["content"] for l in agent.transcripts.read("A", "s")] == ["go", "<final>剥掉了</final>"]
    assert [m["content"] for m in agent.sessions.get("A", "s")["history"]] == ["go", "<final>剥掉了</final>"]
