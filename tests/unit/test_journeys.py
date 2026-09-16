"""B1 答案卷落盘：contracts/journeys.json（旅程名 → 行 id 序列）+ check_journey 三态。人、AI、测试对答案用同一个函数。"""
import json
import re

from contracts.session_machine import session_machine
from contracts.session_runtime_machine import session_runtime_machine
from contracts.turn_machine import turn_machine, turn_runner_protocol
from mini_agent.llm.fake import FakeLLM
from mini_agent.machine.check import check_journey, unknown_rows, validate_journey
from mini_agent.machine.generator import generate_paths
from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import MemoryTraceSink
from tests.conftest import tc

journeys = json.load(open("contracts/journeys.json", encoding="utf8"))
machines = {"turn": turn_machine, "session": session_machine, "session-runtime": session_runtime_machine}


def run_once(script, **opts):
    trace = MemoryTraceSink()
    r = Agent(llm=FakeLLM(script), trace=trace, llm_retries=0, **opts).run(user_id="j", session_id="s", input="go")
    return r, trace.records


def test_journeys_tied_to_tables():
    assert journeys
    problems = []
    for name, j in journeys.items():
        m = machines.get(j["feature"])
        problems += [f"{name}：{p}" for p in validate_journey(j, m)] if m else [f'{name}：feature "{j["feature"]}" 不是一张表']
    assert problems == []


def test_validate_journey_names_problems():
    assert re.search("nope", "\n".join(validate_journey({"feature": "turn", "expect": ["t-llm-ok", "nope"]}, turn_machine)))
    assert re.search("首尾|接不上", "\n".join(validate_journey({"feature": "turn", "expect": ["t-llm-ok", "t-tools-done"]}, turn_machine)))


def test_generated_paths_equal_journeys():
    gen = generate_paths(turn_machine, turn_runner_protocol, initial_facts=lambda: turn_runner_protocol.initial_facts(2))
    generated = {" > ".join(p.row_ids) for p in gen.paths}
    written = {" > ".join(j["expect"]) for j in journeys.values() if j["feature"] == "turn"}
    assert len(generated) == 10
    assert generated - written == set() and written - generated == set()


def test_check_journey_passed():
    _, rows = run_once(["<final>hi</final>"])
    assert check_journey(rows, journeys["direct-final"]) == {"status": "passed", "trace_id": "j/s/1"}


def test_check_journey_failed_with_closest():
    _, rows = run_once([tc("calculator", {"expression": "1+1"}), "<final>2</final>"])
    assert check_journey(rows, journeys["direct-final"]) == {"status": "failed", "closest": {"trace_id": "j/s/1", "actual": ["t-llm-ok", "t-tools", "t-tools-done", "t-llm-ok", "t-final"]}}
    assert check_journey(rows, journeys["tool-then-final"])["status"] == "passed"


def test_check_journey_not_observed():
    _, rows = run_once(["<final>hi</final>"])
    assert check_journey([], journeys["direct-final"]) == {"status": "not_observed"}
    assert check_journey(rows, journeys["direct-final"], "j/s/99") == {"status": "not_observed"}
    assert check_journey(rows, {"feature": "session", "expect": ["s-first-input"]}) == {"status": "not_observed"}


def test_alternatives_pass():
    _, rows = run_once(["<final>hi</final>"])
    assert check_journey(rows, {"feature": "turn", "expect": ["t-llm-failed"], "alternatives": [["t-llm-ok", "t-final"]]})["status"] == "passed"


def test_unknown_rows_listed_separately():
    holed = turn_machine.replace(rows=[r for r in turn_machine.rows if r.event != "PARSED_TOOL_CALLS"])
    _, rows = run_once([tc("calculator", {"expression": "1+1"})], machine=holed, unknown_transition="error")
    assert [[r["from"], r["event"], r["transition"]] for r in unknown_rows(rows)] == [["deciding", "PARSED_TOOL_CALLS", None]]
    assert check_journey(rows, journeys["direct-final"])["status"] == "failed"
