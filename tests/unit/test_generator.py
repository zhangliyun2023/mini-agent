"""S3：从表 BFS 生成路径清单 → 对账手写 covered_by → 每条路径用 FakeLLM 真跑一遍，trace 序列 == 答案卷。"""
import os

import pytest

from contracts.turn_machine import TERMINAL_STOPPED_BY, turn_machine, turn_runner_protocol
from mini_agent.llm.fake import FakeLLM
from mini_agent.machine.generator import generate_paths
from mini_agent.machine.invariants import check_turn_invariants
from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import MemoryTraceSink

MAX_STEPS = 2
gen = generate_paths(turn_machine, turn_runner_protocol, initial_facts=lambda: turn_runner_protocol.initial_facts(MAX_STEPS))


def script_for(events):
    """路径的事件序列 → FakeLLM 脚本：每个 LLM_OK 看它后面的 PARSED_* 决定吐什么；LLM_FAILED 抛异常"""
    script = []
    for i, e in enumerate(events):
        if e == "LLM_FAILED":
            script.append(RuntimeError("模拟接口失败"))
        if e != "LLM_OK":
            continue
        nxt = events[i + 1] if i + 1 < len(events) else None
        if nxt == "PARSED_FINAL":
            script.append("<final>生成路径的最终答案</final>")
        elif nxt == "PARSED_TOOL_CALLS":
            script.append('<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>')
        elif nxt == "PARSED_ERROR":
            script.append('<tool_call>{"name":"calculator","arguments":{"expression":</tool_call>')
        else:
            raise RuntimeError(f"LLM_OK 后面不该是 {nxt}")
    return script


def test_no_gaps():
    assert gen.gaps == []


def test_ten_paths_three_terminals():
    assert len(gen.paths) == 10
    assert len({p.id for p in gen.paths}) == 10
    assert {p.terminal for p in gen.paths} == {"done", "max_steps", "error"}


def test_rows_used_equals_all_rows():
    assert gen.rows_used == [r.id for r in turn_machine.rows]


def test_generated_subset_of_handwritten_coverage():
    covered = {r.id: r.covered_by for r in turn_machine.rows}
    assert [rid for rid in gen.rows_used if not covered[rid]] == []
    not_on_disk = []
    for rid in gen.rows_used:
        for ref in covered[rid]:
            file, name = ref.split("::")
            if not os.path.exists(file) or name not in open(file, encoding="utf8").read():
                not_on_disk.append(ref)
    assert not_on_disk == []


def test_expected_is_row_id_sequence():
    failed = next(p for p in gen.paths if ",".join(p.events) == "LLM_FAILED")
    assert failed.expected == ["t-llm-failed"]
    direct = next(p for p in gen.paths if ",".join(p.events) == "LLM_OK,PARSED_FINAL")
    assert direct.expected == ["t-llm-ok [noop]", "t-final"]


def test_reason_change_does_not_drift_answer_key():
    from dataclasses import replace

    reworded = turn_machine.replace(rows=[replace(r, reason="措辞改了，语义没改") if r.id == "t-final" else r for r in turn_machine.rows])
    again = generate_paths(reworded, turn_runner_protocol, initial_facts=lambda: turn_runner_protocol.initial_facts(MAX_STEPS))
    assert [p.expected for p in again.paths] == [p.expected for p in gen.paths]


@pytest.mark.parametrize("path", gen.paths, ids=[p.id for p in gen.paths])  # ×10
def test_each_generated_path_runs_to_answer_key(path):
    llm = FakeLLM(script_for(path.events))
    trace = MemoryTraceSink()
    agent = Agent(llm=llm, trace=trace, max_tool_steps=MAX_STEPS, llm_retries=0)
    r = agent.run(user_id="gen", session_id=path.id, input="go")
    assert trace.sequence() == path.expected
    assert r["stoppedBy"] == TERMINAL_STOPPED_BY[path.terminal]
    assert all(x["status"] != "unknown" for x in trace.records)
    # 每条生成路径跑出来的证据都过五条 P0 不变量（含 ⑤ 副作用对账）
    report = check_turn_invariants({"records": trace.records, "result": r, "lastHistoryMessage": agent.sessions.get("gen", path.id)["history"][-1]})
    assert "effects_declared" in [x["id"] for x in report]
    assert [x for x in report if x["violations"]] == []
