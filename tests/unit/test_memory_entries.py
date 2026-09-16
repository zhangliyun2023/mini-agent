import json
import os
import re

from mini_agent.llm.fake import FakeLLM
from mini_agent.memory.user_memory import FileUserMemoryStore, MemoryUserMemoryStore, render_memory
from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import MemoryTraceSink
from mini_agent.session.context import ContextOptions
from tests.conftest import tc


def memory_block_of(llm, i):
    """第 i 次模型调用的 system prompt 里的记忆块（用户可见契约：模型收到的文本）"""
    m = re.search(r"<memory>[\s\S]*</memory>", llm.calls[i][0]["content"])
    return m.group(0) if m else ""


def entry(**p):
    return {"kind": "stated", "confidence": 1, "source": {"sessionId": "s", "turn": 1}, "date": "2026-09-14", "status": "active", **p}


def test_remember_writes_stated_entry():
    memory = MemoryUserMemoryStore()
    llm = FakeLLM(["<final>ok</final>", tc("remember", {"key": "city", "value": "上海"}), "<final>记住了</final>"])
    agent = Agent(llm=llm, memory=memory)
    agent.run(user_id="A", session_id="w1", input="hi")
    agent.run(user_id="A", session_id="w1", input="我在上海")
    entries = memory.entries("A")
    assert len(entries) == 1
    e = entries[0]
    assert (e["key"], e["value"], e["kind"], e["confidence"], e["source"], e["status"]) == ("city", "上海", "stated", 1, {"sessionId": "w1", "turn": 2}, "active")
    assert re.match(r"^\d{4}-\d{2}-\d{2}", e["date"])
    assert memory.load("A") == {"city": "上海"}


def test_conflict_not_overwritten_and_rendered():
    memory = MemoryUserMemoryStore()
    llm = FakeLLM([tc("remember", {"key": "city", "value": "上海"}), "<final>记住了</final>", tc("remember", {"key": "city", "value": "北京"}), "<final>记住了</final>", "<final>ok</final>"])
    agent = Agent(llm=llm, memory=memory)
    agent.run(user_id="A", session_id="w1", input="我在上海")
    agent.run(user_id="A", session_id="w2", input="我在北京")
    agent.run(user_id="A", session_id="w3", input="hi")
    entries = memory.entries("A")
    assert [[e["value"], e["status"], e.get("conflictWith")] for e in entries] == [["上海", "active", None], ["北京", "conflict", "上海"]]
    assert entries[1]["source"] == {"sessionId": "w2", "turn": 1}
    assert memory.load("A") == {"city": "上海"}
    block = memory_block_of(llm, 4)
    assert "- city: 上海" in block
    assert "（待确认：昨天说 北京，之前记 上海）" in block


def test_same_value_refreshes_date_and_source():
    memory = MemoryUserMemoryStore()
    memory.upsert("A", entry(key="city", value="上海", source={"sessionId": "old", "turn": 1}, date="2020-01-01"))
    llm = FakeLLM([tc("remember", {"key": "city", "value": "上海"}), "<final>记住了</final>"])
    Agent(llm=llm, memory=memory).run(user_id="A", session_id="w9", input="我在上海")
    entries = memory.entries("A")
    assert len(entries) == 1
    assert (entries[0]["key"], entries[0]["value"], entries[0]["status"], entries[0]["source"]) == ("city", "上海", "active", {"sessionId": "w9", "turn": 1})
    assert entries[0]["date"] != "2020-01-01"


def test_inferred_rendered_with_marker():
    memory = MemoryUserMemoryStore()
    memory.upsert("A", entry(key="city", value="上海"))
    memory.upsert("A", entry(key="lang", value="中文", kind="inferred", confidence=0.6))
    llm = FakeLLM(["<final>ok</final>"])
    Agent(llm=llm, memory=memory).run(user_id="A", session_id="w1", input="hi")
    block = memory_block_of(llm, 0)
    assert "- city: 上海\n" in block
    assert "- lang: 中文（推断）" in block
    assert memory.load("A") == {"city": "上海"}


def test_drop_order_conflict_inferred_stated():
    memory = MemoryUserMemoryStore()
    memory.upsert("A", entry(key="city", value="上海", date="2026-09-10"))  # stated，最老
    memory.upsert("A", entry(key="lang", value="中文", kind="inferred", confidence=0.3, date="2026-09-11"))
    memory.upsert("A", entry(key="food", value="辣", kind="inferred", confidence=0.8, date="2026-09-12"))
    memory.upsert("A", entry(key="name", value="小张", date="2026-09-13"))  # stated，最新
    memory.upsert("A", entry(key="city", value="北京", date="2026-09-14"))  # → conflict
    all_ = memory.entries("A")
    assert [e["status"] for e in all_] == ["active", "active", "active", "active", "conflict"]
    full = render_memory(all_)["block"]
    lines = full.split("\n")[1:-1]
    assert lines == ["- city: 上海", "- lang: 中文（推断）", "- food: 辣（推断）", "- name: 小张", "- city（待确认：昨天说 北京，之前记 上海）"]

    def drop(limit, line):
        return limit - len(line) - 1  # 少一行 = 少这行加一个换行

    l4 = drop(len(full), lines[4])  # 刚好装不下 5 条
    l3 = drop(l4, lines[1])
    l2 = drop(l3, lines[2])
    l1 = drop(l2, lines[0])

    def kept_lines(limit):
        return render_memory(all_, limit)["block"].split("\n")[1:-1]

    assert kept_lines(l4) == ["- city: 上海", "- lang: 中文（推断）", "- food: 辣（推断）", "- name: 小张"]  # 先丢 conflict
    assert kept_lines(l3) == ["- city: 上海", "- food: 辣（推断）", "- name: 小张"]  # 再丢低置信度的 inferred
    assert kept_lines(l2) == ["- city: 上海", "- name: 小张"]  # 再丢高置信度的 inferred
    assert kept_lines(l1) == ["- name: 小张"]  # stated 之间最老先丢
    assert render_memory(all_, l3)["truncated"] == {"total": 5, "kept": 3}

    llm = FakeLLM(["<final>ok</final>"])
    trace = MemoryTraceSink()
    Agent(llm=llm, memory=memory, trace=trace, context=ContextOptions(memory_max_chars=l3)).run(user_id="A", session_id="w1", input="hi")
    block = memory_block_of(llm, 0)
    assert len(block) <= l3
    assert "待确认" not in block and "lang" not in block
    assert "- food: 辣（推断）" in block
    fx = trace.effects("memory_truncated")[0]
    assert (fx["total"], fx["kept"], fx["limit"]) == (5, 3, l3)


def test_legacy_kv_file_compat(tmp):
    with open(os.path.join(tmp, "A.memory.json"), "w", encoding="utf8") as f:
        json.dump({"city": "上海", "name": "小张"}, f, ensure_ascii=False, indent=2)
    store = FileUserMemoryStore(tmp)
    assert store.load("A") == {"city": "上海", "name": "小张"}
    entries = store.entries("A")
    assert [e["key"] for e in entries] == ["city", "name"]
    for e in entries:
        assert (e["kind"], e["confidence"], e["source"], e["status"]) == ("stated", 1, {"sessionId": "legacy", "turn": 0}, "active")
    store.upsert("A", entry(key="city", value="北京", source={"sessionId": "w1", "turn": 3}))
    on_disk = json.load(open(os.path.join(tmp, "A.memory.json"), encoding="utf8"))
    assert [[e["key"], e["value"], e["status"]] for e in on_disk["entries"]] == [["city", "上海", "active"], ["name", "小张", "active"], ["city", "北京", "conflict"]]
    again = FileUserMemoryStore(tmp)
    assert again.load("A") == {"city": "上海", "name": "小张"}
    third = again.entries("A")[2]
    assert (third["conflictWith"], third["source"]) == ("上海", {"sessionId": "w1", "turn": 3})
