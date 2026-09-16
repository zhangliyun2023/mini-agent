import json
import re

from mini_agent.llm.fake import FakeLLM
from mini_agent.memory.user_memory import MemoryUserMemoryStore
from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import MemoryTraceSink
from mini_agent.session.context import ContextOptions
from tests.conftest import last_tool, tc


def test_two_windows_isolated():
    llm = FakeLLM([
        tc("todo", {"action": "add", "item": "周三 3 点开会（日历）"}), "<final>日历加好了</final>",
        tc("todo", {"action": "add", "item": "联系人：李哲"}), "<final>联系人加好了</final>",
        tc("todo", {"action": "list"}), lambda m: f"<final>{last_tool(m)}</final>",
        tc("todo", {"action": "list"}), lambda m: f"<final>{last_tool(m)}</final>",
    ])
    agent = Agent(llm=llm)
    agent.run(user_id="A", session_id="w1", input="帮我加个日历")
    agent.run(user_id="A", session_id="w2", input="帮我加个联系人")
    w1 = agent.run(user_id="A", session_id="w1", input="看看清单")
    w2 = agent.run(user_id="A", session_id="w2", input="看看清单")
    assert "日历" in w1["answer"] and "李哲" not in w1["answer"]
    assert "李哲" in w2["answer"] and "日历" not in w2["answer"]
    # 窗口1 第二轮的 context 里只有窗口1 自己的历史
    second = llm.calls[4]
    assert any("加个日历" in m["content"] for m in second)
    assert not any("联系人" in m["content"] for m in second)


def test_pure_followup_has_previous_turn():
    llm = FakeLLM(["<think>先答</think><final>上海今天 28 度</final>", "<final>那北京呢</final>"])
    agent = Agent(llm=llm)
    agent.run(user_id="u", session_id="s", input="上海天气")
    agent.run(user_id="u", session_id="s", input="北京呢")
    texts = [m["content"] for m in llm.calls[1]]
    assert "上海天气" in texts
    assert any("上海今天 28 度" in t for t in texts)


def test_followup_with_tool_acts_on_same_list():
    llm = FakeLLM([tc("todo", {"action": "add", "item": "买牛奶"}), "<final>加好了</final>", tc("todo", {"action": "done", "index": 1}), lambda m: f"<final>{last_tool(m)}</final>"])
    agent = Agent(llm=llm)
    agent.run(user_id="u", session_id="s", input="记一下买牛奶")
    r = agent.run(user_id="u", session_id="s", input="第一条完成了")
    assert "[x] 买牛奶" in r["answer"]


def test_think_visible_within_turn_stripped_after():
    llm = FakeLLM([f"<think>我要先算</think>{tc('calculator', {'expression': '6*7'})}", "<final>42</final>", "<final>ok</final>"])
    agent = Agent(llm=llm)
    agent.run(user_id="u", session_id="s", input="6乘7")
    assert "我要先算" in "\n".join(m["content"] for m in llm.calls[1])
    agent.run(user_id="u", session_id="s", input="再来")
    next_turn = "\n".join(m["content"] for m in llm.calls[2])
    assert "我要先算" not in next_turn
    assert "42" in next_turn
    assert any(m["role"] == "tool" and m["content"] == "42" for m in llm.calls[2])


def test_compaction_summarizes_old_turns():
    script = [f"<final>答{i}</final>" for i in range(1, 7)]
    # 第 7 轮开始前触发压缩：先消费一次摘要调用，再回答
    script.append(lambda m: "要点：用户问了 1-4 号问题" if "对话压缩器" in m[0]["content"] else "<final>不该走这里</final>")
    script.append(lambda m: "<final>" + "|".join(re.sub(r"</?final>", "", x["content"]) for x in m[1:]) + "</final>")
    llm = FakeLLM(script)
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, context=ContextOptions(max_history_messages=10, keep_recent_messages=4, max_history_chars=100_000))
    for i in range(1, 7):
        agent.run(user_id="u", session_id="s", input=f"问{i}")
    r = agent.run(user_id="u", session_id="s", input="问7")
    assert "要点：用户问了 1-4 号问题" in r["answer"]
    assert "问5" in r["answer"]
    assert "问1|" not in r["answer"]
    # compact 不再是独立记录，而是挂在本轮第一条转移上的副作用（D4）
    compact = trace.effects("compact")[0]
    assert (compact["before"], compact["after"], compact["method"]) == (12, 4, "llm")
    first_of_turn7 = next(x for x in trace.records if x["trace_id"] == "u/s/7" and x["seq"] == 1)
    assert [e["kind"] for e in first_of_turn7["effects"]] == ["compact", "llm"]


def test_compaction_falls_back_to_rule():
    script = [f"<final>答{i}</final>" for i in range(1, 4)]
    script.append(RuntimeError("摘要接口挂了"))
    script.append(lambda m: "<final>" + "|".join(re.sub(r"</?final>", "", x["content"]) for x in m[1:]) + "</final>")
    llm = FakeLLM(script)
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, llm_retries=0, context=ContextOptions(max_history_messages=4, keep_recent_messages=2, max_history_chars=100_000))
    for i in range(1, 4):
        agent.run(user_id="u", session_id="s", input=f"问{i}")
    r = agent.run(user_id="u", session_id="s", input="问4")
    assert r["stoppedBy"] == "final"
    assert "用户：问1" in r["answer"]
    assert trace.effects("compact")[0]["method"] == "rule"


def test_remember_visible_in_new_session():
    memory = MemoryUserMemoryStore()
    llm = FakeLLM([tc("remember", {"key": "city", "value": "上海"}), "<final>记住了</final>", "<final>ok</final>"])
    agent = Agent(llm=llm, memory=memory)
    agent.run(user_id="A", session_id="w1", input="我在上海")
    agent.run(user_id="A", session_id="w2", input="天气")
    assert llm.calls[2][0]["role"] == "system"
    assert re.search(r"<memory>[\s\S]*city: 上海", llm.calls[2][0]["content"])


def test_a5_remember_value_redacted_in_trace():
    memory = MemoryUserMemoryStore()
    trace = MemoryTraceSink()
    llm = FakeLLM([tc("remember", {"key": "city", "value": "上海徐汇区"}), "<final>记住了</final>"])
    Agent(llm=llm, memory=memory, trace=trace).run(user_id="A", session_id="w1", input="我住上海徐汇区")
    assert memory.load("A") == {"city": "上海徐汇区"}
    tool = trace.effects("tool")[0]
    assert tool["name"] == "remember"
    assert "上海徐汇区" not in json.dumps(tool["args"], ensure_ascii=False)
    assert tool["args"] == {"key": "city", "value_len": 5}
    assert "上海徐汇区" not in json.dumps([r for r in trace.records if any(e["kind"] == "tool" for e in r["effects"])], ensure_ascii=False)


def test_other_user_cannot_see_memory():
    memory = MemoryUserMemoryStore()
    memory.set("A", "city", "上海")
    llm = FakeLLM(["<final>ok</final>"])
    Agent(llm=llm, memory=memory).run(user_id="B", session_id="w1", input="hi")
    assert "上海" not in llm.calls[0][0]["content"]


def test_trace_sequence_matches_answer_key():
    trace = MemoryTraceSink()
    llm = FakeLLM([tc("calculator", {"expression": "1+1"}), "<final>2</final>"])
    r = Agent(llm=llm, trace=trace).run(user_id="u", session_id="s", input="1+1")
    assert trace.sequence() == ["t-llm-ok [noop]", "t-tools", "t-tools-done", "t-llm-ok [noop]", "t-final"]
    assert [x["transition"] for x in trace.records] == ["t-llm-ok", "t-tools", "t-tools-done", "t-llm-ok", "t-final"]
    assert (trace.records[1]["from"], trace.records[1]["event"], trace.records[1]["to"]) == ("deciding", "PARSED_TOOL_CALLS", "executing_tools")
    assert r["traceId"] == "u/s/1"
    assert all(x["trace_id"] == "u/s/1" and x["sessionId"] == "s" and x["turn"] == 1 and x["status"] in ("allowed", "noop") for x in trace.records)
    assert [x["seq"] for x in trace.records] == [1, 2, 3, 4, 5]
    assert [x["step"] for x in trace.records] == [1, 1, 1, 2, 2]
    assert [e["kind"] for e in trace.records[0]["effects"]] == ["llm"]
    tool = trace.records[2]["effects"][0]
    assert (tool["kind"], tool["name"], tool["ok"], tool["resultPreview"]) == ("tool", "calculator", True, "2")
    assert isinstance(tool["durationMs"], int)
    answer = next(e for e in trace.records[4]["effects"] if e["kind"] == "answer")
    assert (answer["stoppedBy"], answer["answer"]) == ("final", "2")
    assert isinstance(answer["totalMs"], int)
    assert trace.records[-1]["to"] == "done"


def test_a2_request_ids_unique():
    trace = MemoryTraceSink()
    llm = FakeLLM([tc("search", {"query": "上海"}) + tc("calculator", {"expression": "1+1"}), "<final>2</final>"])
    Agent(llm=llm, trace=trace).run(user_id="u", session_id="s", input="1+1")
    ids = [e["request_id"] for e in [*trace.effects("llm"), *trace.effects("tool")]]
    assert len(ids) == 4
    for i in ids:
        assert re.match(r"^r-[0-9a-z]{6,}$", i)
    assert len(set(ids)) == 4


def test_memory_block_truncated_to_limit():
    memory = MemoryUserMemoryStore()
    for i in range(60):
        memory.set("A", f"k{i:02d}", f"值{i:02d}".ljust(40, "。"))
    llm = FakeLLM(["<final>ok</final>"])
    Agent(llm=llm, memory=memory).run(user_id="A", session_id="w1", input="hi")
    system = llm.calls[0][0]["content"]
    m = re.search(r"<memory>[\s\S]*</memory>", system)
    block = m.group(0) if m else ""
    assert 0 < len(block) <= 1200
    assert "k59: 值59" in block
    assert "k00: 值00" not in block
    kept = len(re.findall(r"^- k\d\d: ", block, re.M))
    assert kept < 60
    for i in range(60 - kept, 60):
        assert f"k{i:02d}: " in block


def test_memory_truncated_effect_in_trace():
    memory = MemoryUserMemoryStore()
    for i in range(60):
        memory.set("A", f"k{i:02d}", "x" * 40)
    llm = FakeLLM(["<final>ok</final>", "<final>ok</final>"])
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, memory=memory)
    agent.run(user_id="A", session_id="w1", input="hi")
    first = next(r for r in trace.records if r["trace_id"] == "A/w1/1" and r["seq"] == 1)
    assert [e["kind"] for e in first["effects"]] == ["memory_truncated", "llm"]
    fx = trace.effects("memory_truncated")[0]
    shown = len(re.findall(r"^- k\d\d: ", llm.calls[0][0]["content"], re.M))
    assert (fx["total"], fx["kept"], fx["limit"]) == (60, shown, 1200)
    assert fx["kept"] < 60
    agent.run(user_id="B", session_id="w1", input="hi")
    assert not any(e["kind"] == "memory_truncated" for r in trace.records if r["trace_id"] == "B/w1/1" for e in r["effects"])


def test_history_threshold_and_memory_limit_independent():
    memory = MemoryUserMemoryStore()
    for i in range(60):
        memory.set("A", f"k{i:02d}", "x" * 40)
    llm = FakeLLM(["<final>答1</final>", "<final>答2</final>"])
    trace = MemoryTraceSink()
    # 历史阈值 600 字符：第 2 轮开始时历史只有「问1 + <final>答1</final>」≈ 20 字符；system prompt（含顶满 1200 的记忆块）远超 600
    agent = Agent(llm=llm, trace=trace, memory=memory, context=ContextOptions(max_history_chars=600))
    agent.run(user_id="A", session_id="s", input="问1")
    agent.run(user_id="A", session_id="s", input="问2")
    assert len(llm.calls[1][0]["content"]) > 600
    assert trace.effects("compact") == []
    assert not any("此前对话摘要" in m["content"] for m in llm.calls[1])
    block = re.search(r"<memory>[\s\S]*</memory>", llm.calls[1][0]["content"]).group(0)
    assert len(block) <= 1200
