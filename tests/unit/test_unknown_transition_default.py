"""#11：unknown_transition 默认 "error"，运行时不读任何测试环境变量。"""
import re

from contracts.turn_machine import turn_machine
from mini_agent.llm.fake import FakeLLM
from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import MemoryTraceSink


def test_default_unknown_transition_is_error_not_raise():
    llm = FakeLLM(["<final>hi</final>"])
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, machine=turn_machine.replace(rows=[r for r in turn_machine.rows if r.event != "PARSED_FINAL"]))
    r = agent.run(user_id="u1", session_id="s1", input="hi")
    assert r["stoppedBy"] == "error"
    assert re.search(r"未建模的状态转移：deciding \+ PARSED_FINAL", r["answer"])
    last = trace.records[-1]
    assert (last["event"], last["status"], last["to"]) == ("PARSED_FINAL", "unknown", "error")
