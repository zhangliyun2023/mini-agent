"""S4：五条 P0 不变量各一条 Given / When / Then，每条一红一绿——
  绿：真实跑出来的证据通过 oracle；红：把证据篡改成违反的样子，oracle 必须点名。
oracle 只看用户可见证据（trace 记录、返回值、盘上历史），不碰 runtime 内部。"""
import copy
import json
import os
import re

from contracts.turn_machine import turn_machine
from mini_agent.llm.fake import FakeLLM
from mini_agent.machine.invariants import answer_aligned, check_turn_invariants, effects_declared, exactly_one_final_answer, no_tool_after_parse_error, terminal_states_distinct
from mini_agent.memory.user_memory import FileUserMemoryStore
from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import FileTraceSink, MemoryTraceSink
from mini_agent.session.context import ContextOptions
from mini_agent.session.store import FileSessionStore
from tests.conftest import tc

BAD = '<tool_call>{"name":"calculator","arguments":{"expression":</tool_call>'


def run_once(script, **opts):
    llm = FakeLLM(script)
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, llm_retries=0, **opts)
    result = agent.run(user_id="inv", session_id="s", input="go")
    return {"result": result, "records": trace.records, "history": agent.sessions.get("inv", "s")["history"], "trace": trace}


def test_inv1_no_tool_after_parse_error():
    records = run_once([BAD, tc("calculator", {"expression": "1+1"}), "<final>2</final>"])["records"]
    assert no_tool_after_parse_error(records) == []
    tool_idx = next(i for i, r in enumerate(records) if any(e["kind"] == "tool" for e in r["effects"]))
    assert (records[tool_idx - 1]["event"], records[tool_idx - 1]["status"]) == ("PARSED_TOOL_CALLS", "allowed")


def test_inv1_red_tool_moved_to_parse_error():
    records = run_once([BAD, tc("calculator", {"expression": "1+1"}), "<final>2</final>"])["records"]
    tampered = copy.deepcopy(records)
    tool = next(e for r in tampered for e in r["effects"] if e["kind"] == "tool")
    next(r for r in tampered if r["event"] == "PARSED_ERROR")["effects"].append(tool)
    v = no_tool_after_parse_error(tampered)
    assert v and re.search("PARSED_ERROR 转移上挂了", "\n".join(v))


def test_inv2_exactly_one_final_answer():
    out = run_once([tc("calculator", {"expression": "1+1"}), "<final>2</final>"])
    assert exactly_one_final_answer(out["records"], out["history"]) == []


def test_inv2_red_duplicate_terminal_and_extra_final():
    out = run_once(["<final>hi</final>"])
    dup = copy.deepcopy(out["records"])
    dup.append(copy.deepcopy(dup[-1]))
    assert re.search("终态转移应恰 1 条，实际 2 条", "\n".join(exactly_one_final_answer(dup)))
    bad_hist = [*out["history"], {"role": "assistant", "content": "<final>第二个答案</final>"}]
    assert re.search("<final> 消息应恰 1 条，实际 2 条", "\n".join(exactly_one_final_answer(out["records"], bad_hist)))


def test_inv3_terminal_states_distinct():
    fin = run_once(["<final>ok</final>"])
    mx = run_once([tc("calculator", {"expression": "1+1"})] * 3, max_tool_steps=2)
    err = run_once([RuntimeError("boom")])
    assert fin["records"][-1]["to"] == "done"
    assert mx["records"][-1]["to"] == "max_steps"
    assert err["records"][-1]["to"] == "error"
    for x in (fin, mx, err):
        assert terminal_states_distinct(x["records"], x["result"]["stoppedBy"]) == []
    assert len({x["result"]["stoppedBy"] for x in (fin, mx, err)}) == 3


def test_inv3_red_done_reported_as_error():
    records = run_once(["<final>ok</final>"])["records"]
    assert re.search("终态 done 应对应 stoppedBy=final，实际 error", "\n".join(terminal_states_distinct(records, "error")))


def test_inv5_effects_declared():
    # 第 1 轮直接回答；第 2 轮开始前历史超过 max_history_messages=1 且 keep_recent_messages=0 → 全部压缩（消费一次摘要调用），再走 坏 JSON → 工具 → final
    llm = FakeLLM(["<final>第一轮</final>", lambda m: "要点" if "对话压缩器" in m[0]["content"] else "<final>不该走这里</final>", BAD, tc("calculator", {"expression": "1+1"}), "<final>2</final>"])
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, llm_retries=0, context=ContextOptions(max_history_messages=1, keep_recent_messages=0))
    agent.run(user_id="inv", session_id="s", input="一")
    agent.run(user_id="inv", session_id="s", input="二")
    turn2 = [r for r in trace.records if r["trace_id"] == "inv/s/2"]
    assert effects_declared(turn2) == []
    assert effects_declared(trace.records) == []
    assert {e["kind"] for r in turn2 for e in r["effects"]} == {"compact", "llm", "parse", "tool", "answer"}
    assert next(r for r in turn2 if any(e["kind"] == "compact" for e in r["effects"]))["seq"] == 1


def test_inv5_red_unmodeled_effects():
    records = run_once([tc("calculator", {"expression": "1+1"}), "<final>2</final>"])["records"]
    tampered = copy.deepcopy(records)
    tool = next(r for r in tampered if r["transition"] == "t-tools-done")["effects"][0]
    next(r for r in tampered if r["transition"] == "t-llm-ok")["effects"].append(tool)
    v1 = effects_declared(tampered)
    assert len(v1) == 1
    assert re.search('#1 t-llm-ok 上出现了表未声明的副作用 "tool"（该行声明：compact, llm）', v1[0])
    late = copy.deepcopy(records)
    next(r for r in late if r["transition"] == "t-tools-done")["effects"].append({"kind": "compact", "before": 3, "after": 1, "method": "rule"})
    assert re.search('#3 t-tools-done 上出现了表未声明的副作用 "compact"', "\n".join(effects_declared(late)))
    ghost = copy.deepcopy(records)
    ghost[0]["transition"] = "t-does-not-exist"
    assert re.search('#1 行 id "t-does-not-exist" 在表里不存在', "\n".join(effects_declared(ghost)))


def test_inv5_reverse_red_table_declaration_removed():
    records = run_once([tc("calculator", {"expression": "1+1"}), "<final>2</final>"])["records"]
    stingy = turn_machine.replace(rows=[(r.__class__(**{**r.__dict__, "effects": []}) if r.event == "TOOLS_DONE" else r) for r in turn_machine.rows])
    assert effects_declared(records) == []
    assert re.search('#3 t-tools-done 上出现了表未声明的副作用 "tool"（该行声明：无）', "\n".join(effects_declared(records, stingy)))


def build(d, script):
    return Agent(llm=FakeLLM(script), llm_retries=0, sessions=FileSessionStore(os.path.join(d, "sessions")), trace=FileTraceSink(os.path.join(d, "trace")), memory=FileUserMemoryStore(os.path.join(d, "memory")))


def read_session(d):
    return json.load(open(os.path.join(d, "sessions", "A", "w1.json"), encoding="utf8"))


def read_trace(d):
    return [json.loads(l) for l in open(os.path.join(d, "trace", "w1.jsonl"), encoding="utf8").read().strip().split("\n")]


def test_inv4_answer_alignment(tmp):
    r = build(tmp, [tc("calculator", {"expression": "6*7"}), "<final>答案是 42</final>"]).run(user_id="A", session_id="w1", input="6乘7")
    session = read_session(tmp)
    records = read_trace(tmp)
    assert answer_aligned({"records": records, "result": r, "lastHistoryMessage": session["history"][-1]}) == []
    assert session["history"][-1] == {"role": "assistant", "content": "<final>答案是 42</final>"}
    assert next(e for e in records[-1]["effects"] if e["kind"] == "answer")["answer"] == "答案是 42"
    all_ = check_turn_invariants({"records": records, "result": r, "lastHistoryMessage": session["history"][-1]})
    assert [x["id"] for x in all_] == ["no_tool_after_parse_error", "exactly_one_final_answer", "terminal_states_distinct", "answer_alignment", "effects_declared"]
    assert all(not x["violations"] for x in all_)
    # API key 之类的配置不在 trace 里
    assert not re.search(r"api_key|OPENAI", open(os.path.join(tmp, "trace", "w1.jsonl"), encoding="utf8").read())


def test_inv4_red_tampered_history_and_trace(tmp):
    r = build(tmp, ["<final>真答案</final>"]).run(user_id="A", session_id="w1", input="hi")
    session = read_session(tmp)
    session["history"][-1]["content"] = "<final>被改过的答案</final>"
    json.dump(session, open(os.path.join(tmp, "sessions", "A", "w1.json"), "w", encoding="utf8"), ensure_ascii=False)
    v1 = answer_aligned({"records": read_trace(tmp), "result": r, "lastHistoryMessage": read_session(tmp)["history"][-1]})
    assert re.search("历史末条 <final> 与返回值不一致", "\n".join(v1))
    records = read_trace(tmp)
    next(e for e in records[-1]["effects"] if e["kind"] == "answer")["answer"] = "trace 里被改过"
    v2 = answer_aligned({"records": records, "result": r, "lastHistoryMessage": {"role": "assistant", "content": "<final>真答案</final>"}})
    assert re.search("trace 末次决策的答案与返回值不一致", "\n".join(v2))


def test_file_persistence_resume(tmp):
    build(tmp, [tc("remember", {"key": "city", "value": "上海"}), "<final>上海今天 28 度</final>"]).run(user_id="A", session_id="w1", input="我在上海，天气怎么样")
    llm2 = FakeLLM(["<final>那北京呢</final>"])
    agent2 = Agent(llm=llm2, sessions=FileSessionStore(os.path.join(tmp, "sessions")), trace=FileTraceSink(os.path.join(tmp, "trace")), memory=FileUserMemoryStore(os.path.join(tmp, "memory")))
    r2 = agent2.run(user_id="A", session_id="w1", input="北京呢")
    assert r2["turn"] == 2
    ctx = "\n".join(m["content"] for m in llm2.calls[0])
    assert "我在上海，天气怎么样" in ctx and "上海今天 28 度" in ctx
    assert re.search(r"<memory>[\s\S]*city: 上海", ctx)
    assert agent2.sessions.list("A") == ["w1"]
    assert agent2.sessions.list("B") == []
    assert os.listdir(os.path.join(tmp, "trace")) == ["w1.jsonl"]
    turns = [x["turn"] for x in read_trace(tmp)]
    assert turns == [1 if i < 5 else 2 for i in range(len(turns))]
