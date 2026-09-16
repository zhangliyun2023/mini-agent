import re

import pytest

from contracts.turn_machine import turn_machine
from mini_agent.llm.fake import FakeLLM
from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import MemoryTraceSink
from tests.conftest import tc

BAD = '<tool_call>{"name":"calculator","arguments":{"expression":</tool_call>'


def test_direct_reply_calls_llm_once():
    llm = FakeLLM(["<think>打招呼</think><final>你好，我能帮你算数、搜索、记待办。</final>"])
    r = Agent(llm=llm).run(user_id="u1", session_id="s1", input="你好")
    assert r["answer"] == "你好，我能帮你算数、搜索、记待办。"
    assert len(llm.calls) == 1
    assert [s["kind"] for s in r["steps"]] == ["llm"]


def test_tool_result_fed_back_then_final():
    llm = FakeLLM([f"<think>要算</think>{tc('calculator', {'expression': '12*12'})}", lambda m: f"<final>12×12 = {m[-1]['content']}</final>"])
    r = Agent(llm=llm).run(user_id="u1", session_id="s1", input="12乘12")
    assert r["answer"] == "12×12 = 144"
    second = llm.calls[1]
    assert second[-1]["role"] == "tool" and second[-1]["name"] == "calculator" and second[-1]["content"] == "144"
    assert [s["kind"] for s in r["steps"]] == ["llm", "tool", "llm"]


def test_multiple_tool_calls_all_executed():
    llm = FakeLLM([tc("search", {"query": "上海"}) + tc("search", {"query": "北京"}), lambda m: f"<final>两条都查了：{sum(1 for x in m if x['role'] == 'tool')}</final>"])
    r = Agent(llm=llm).run(user_id="u1", session_id="s1", input="上海北京天气")
    assert r["answer"] == "两条都查了：2"


def test_tools_until_cap_returns_partial():
    llm = FakeLLM([tc("calculator", {"expression": "1+1"})] * 10)
    r = Agent(llm=llm, max_tool_steps=3).run(user_id="u1", session_id="s1", input="循环")
    assert r["stoppedBy"] == "max_steps"
    assert "上限" in r["answer"]
    assert len(llm.calls) == 3


def test_bad_json_fed_back_as_tool_message():
    llm = FakeLLM([BAD, lambda m: "<final>纠正了</final>" if m[-1]["role"] == "tool" and re.search("JSON", m[-1]["content"]) else "<final>没收到错误</final>"])
    r = Agent(llm=llm).run(user_id="u1", session_id="s1", input="x")
    assert r["answer"] == "纠正了"


def test_a3_bad_json_step_is_blocked_with_reject_code():
    llm = FakeLLM([BAD, "<final>纠正了</final>"])
    trace = MemoryTraceSink()
    r = Agent(llm=llm, trace=trace).run(user_id="u1", session_id="s1", input="x")
    assert r["answer"] == "纠正了"
    assert trace.sequence() == ["t-llm-ok [noop]", "t-parse-error [blocked]", "t-llm-ok [noop]", "t-final"]
    blocked = [x for x in trace.records if x["status"] == "blocked"]
    assert len(blocked) == 1
    assert {k: blocked[0][k] for k in ("from", "to", "event", "transition", "reject_code")} == {"from": "deciding", "to": "deciding", "event": "PARSED_ERROR", "transition": "t-parse-error", "reject_code": "PARSE_ERROR"}
    # 回喂：第二次模型调用的末条是 parser 的 tool 消息
    second = llm.calls[1]
    assert second[-1]["role"] == "tool" and second[-1]["name"] == "parser"
    assert "无法解析" in second[-1]["content"]


def test_tool_failure_does_not_break_loop():
    llm = FakeLLM([tc("calculator", {"expression": "__import__('os')"}), lambda m: f"<final>{'工具报错了，我换个方式' if '失败' in m[-1]['content'] else '?'}</final>"])
    r = Agent(llm=llm).run(user_id="u1", session_id="s1", input="x")
    assert r["answer"] == "工具报错了，我换个方式"


class _Dead:
    model = "dead"

    def chat(self, messages, tools=None):
        raise RuntimeError("429 rate limited")


def test_llm_exception_returns_readable_error():
    r = Agent(llm=_Dead(), llm_retries=0).run(user_id="u1", session_id="s1", input="x")
    assert r["stoppedBy"] == "error"
    assert "429" in r["answer"]


def test_unparseable_until_cap_ends_max_steps():
    llm = FakeLLM([BAD] * 5)
    trace = MemoryTraceSink()
    r = Agent(llm=llm, trace=trace, max_tool_steps=2).run(user_id="u1", session_id="s1", input="x")
    assert r["stoppedBy"] == "max_steps"
    assert len(llm.calls) == 2
    assert trace.sequence() == ["t-llm-ok [noop]", "t-parse-error [blocked]", "t-llm-ok [noop]", "t-parse-error-cap"]
    # 解析失败的路径上没有任何工具被执行
    assert trace.effects("tool") == []
    assert all(s["kind"] == "llm" for s in r["steps"])


def machine_without(event: str):
    """从 turn 表里抠掉一行，得到一张残缺表：用它验证闸拦得住"""
    return turn_machine.replace(rows=[r for r in turn_machine.rows if r.event != event])


def test_unlisted_transition_blocked_at_runtime():
    llm = FakeLLM([tc("calculator", {"expression": "1+1"}), "<final>不该到这</final>"])
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, machine=machine_without("PARSED_TOOL_CALLS"), unknown_transition="error")
    r = agent.run(user_id="u1", session_id="s1", input="1+1")
    assert r["stoppedBy"] == "error"
    assert re.search(r"未建模的状态转移：deciding \+ PARSED_TOOL_CALLS", r["answer"])
    # 工具没跑，模型也没再被调
    assert [s for s in r["steps"] if s["kind"] == "tool"] == []
    assert trace.effects("tool") == []
    assert len(llm.calls) == 1
    last = trace.records[-1]
    assert (last["from"], last["event"], last["to"], last["status"]) == ("deciding", "PARSED_TOOL_CALLS", "error", "unknown")
    assert "未在表里列出" in last["reason"]
    assert trace.sequence() == ["t-llm-ok [noop]", "deciding --PARSED_TOOL_CALLS--> error [unknown]"]
    assert last["transition"] is None
    # 历史里仍然恰好一条最终答案，会话没被搞坏
    hist = agent.sessions.get("u1", "s1")["history"]
    assert len([m for m in hist if m["role"] == "assistant" and m["content"].startswith("<final>")]) == 1


def test_throw_mode_raises_but_still_records_unknown():
    llm = FakeLLM(["<final>hi</final>"])
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, machine=machine_without("PARSED_FINAL"), unknown_transition="throw")
    with pytest.raises(RuntimeError, match=r"deciding \+ PARSED_FINAL"):
        agent.run(user_id="u1", session_id="s1", input="hi")
    last = trace.records[-1]
    assert (last["event"], last["status"], last["to"]) == ("PARSED_FINAL", "unknown", "error")
