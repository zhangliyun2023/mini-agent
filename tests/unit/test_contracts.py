"""S1 / S5：表、契约 JSON、测试三者不许漂（用户故事 42）。漂了怎么修：改表 → make contracts-gen → 看 diff 是否是你想要的。"""
import json
import os
import re

import pytest

from contracts.review_machine import review_machine
from contracts.session_machine import session_machine
from contracts.session_runtime_machine import session_runtime_machine
from contracts.turn_machine import turn_machine
from mini_agent.machine.interpreter import interpret, reachable, to_contract

CONTRACTS = [
    ("turn", turn_machine, "contracts/turn.contract.json"),
    ("session", session_machine, "contracts/session.contract.json"),
    ("session-runtime", session_runtime_machine, "contracts/session-runtime.contract.json"),
    ("review", review_machine, "contracts/review.contract.json"),
]


def locate(ref):
    """`file::name` → 文件存在且内容里找得到 name"""
    file, name = ref.split("::")
    if not os.path.exists(file):
        return f"{ref}：文件 {file} 不存在"
    if name not in open(file, encoding="utf8").read():
        return f"{ref}：在 {file} 里找不到「{name}」"
    return None


@pytest.mark.parametrize("name,machine,path", CONTRACTS)  # ×4
def test_contract_json_no_drift(name, machine, path):
    assert os.path.exists(path)
    assert json.load(open(path, encoding="utf8")) == to_contract(machine)


def test_turn_reachable_all():
    r = reachable(turn_machine)
    assert r.unreachable_states == [] and r.unreachable_rows == []
    assert r.states == list(turn_machine.states)


def test_turn_p0_rows_covered_by_on_disk():
    p0 = [r for r in turn_machine.rows if r.priority == "P0"]
    assert len(p0) == len(turn_machine.rows)
    problems = [p for r in p0 for p in ([locate(c) for c in r.covered_by] if r.covered_by else [f"行 {r.from_} + {r.event} 没有 covered_by"]) if p]
    assert problems == []


def test_turn_enforced_invariants_evidence_on_disk():
    enforced = [i for i in turn_machine.invariants if i.status == "enforced"]
    for want in ("no_tool_after_parse_error", "exactly_one_final_answer", "terminal_states_distinct", "answer_alignment"):
        assert want in [i.id for i in enforced]
    assert [p for i in enforced for p in (locate(e) for e in i.evidence) if p] == []


def test_turn_unlisted_cells_visible():
    c = to_contract(turn_machine)
    assert len(c["rows"]) == 8
    assert (c["cells"]["total"], c["cells"]["listed"]) == (30, 6)
    assert len(c["cells"]["unlisted"]) == 24
    assert len([u for u in c["cells"]["unlisted"] if re.match(r"^(done|max_steps|error) \+", u)]) == 18
    assert c["cells"]["declared_unknown"] == []


def test_session_runtime_q4_three_cells_allowed():
    c = to_contract(session_runtime_machine)
    t = interpret(session_runtime_machine, "busy", "ASYNC_DONE", {})
    assert (t.status, t.to, t.row.id) == ("allowed", "queued", "sr-async-while-busy")
    t = interpret(session_runtime_machine, "idle", "ASYNC_DONE", {})
    assert (t.status, t.to, t.row.id) == ("allowed", "executing", "sr-async-idle")
    t = interpret(session_runtime_machine, "queued", "TURN_DONE", {})
    assert (t.status, t.to, t.row.id) == ("allowed", "executing", "sr-queued-turn-done")
    assert "busy --INPUT--> busy" in c["cells"]["declared_unknown"]
    assert "busy --ASYNC_DONE--> busy" not in c["cells"]["declared_unknown"]
    rw = next(r for r in c["rows"] if r["id"] == "sr-input-while-busy")
    assert (rw["kind"], rw["signature"]) == ("unknown", "busy --INPUT--> busy")
    for rid in ("sr-async-while-busy", "sr-async-idle", "sr-queued-turn-done"):
        assert "单进程 CLI 不可达" in next(r for r in c["rows"] if r["id"] == rid)["reason"]
    assert reachable(session_runtime_machine).unreachable_states == []


def test_session_table_shape():
    c = to_contract(session_machine)
    assert c["reachable"]["unreachable_states"] == []
    assert any(r["kind"] == "rejected" for r in c["rows"])
    assert any(r["kind"] == "noop" for r in c["rows"])
    assert c["cells"]["declared_unknown"] == ["compacting --INPUT--> compacting"]


def test_review_table_reachable_and_guard_fallbacks():
    r = reachable(review_machine)
    assert r.unreachable_states == [] and r.unreachable_rows == []
    assert r.states == list(review_machine.states)
    c = to_contract(review_machine)
    assert c["terminal"] == ["delivered", "skipped_no_chat", "failed_partial"]
    assert len([u for u in c["cells"]["unlisted"] if re.match(r"^(delivered|skipped_no_chat|failed_partial) \+", u)]) == 18
    assert c["cells"]["declared_unknown"] == []
    # 每个带守卫的格都有无守卫兜底（否则是 guard 洞，explore 会红）
    for cell in {(x.from_, x.event) for x in review_machine.rows}:
        rows = review_machine.cell(*cell)
        if any(x.guard for x in rows):
            assert rows[-1].guard is None, cell


def test_review_rows_covered_and_evidence_on_disk():
    assert all(x.priority == "P0" for x in review_machine.rows)
    row_problems = [p for x in review_machine.rows for p in ([locate(c) for c in x.covered_by] if x.covered_by else [f"行 {x.id} 没有 covered_by"]) if p]
    assert row_problems == []
    enforced = [i for i in review_machine.invariants if i.status == "enforced"]
    for want in ("idempotent", "no_overwrite_on_conflict", "every_highlight_has_source", "brief_not_verbatim", "unknown_never_silent"):
        assert want in [i.id for i in enforced]
    assert [p for i in enforced for p in (locate(e) for e in i.evidence) if p] == []
