import json

import pytest

from mini_agent.machine.interpreter import Invariant, MachineDefinitionError, define_machine, enumerate_cells, interpret, reachable, render_contract, row, to_contract

BASE = dict(feature="sample", anchor="test", initial="a", states=["a", "b", "c", "end"], terminal=["end"], events=["GO", "STAY", "STOP", "NEVER"])


def sample():
    return define_machine(
        **BASE,
        guards={"small": lambda f: f["n"] < 3, "big": lambda f: f["n"] >= 3},
        rows=[
            row("r-go-small", "a", "GO", "b", "allowed", guard="small", reason="小走 b"),
            row("r-go-big", "a", "GO", "c", "allowed", guard="big", reason="大走 c"),
            row("r-stay", "a", "STAY", "a", "noop", reason="原地"),
            row("r-stop", "b", "STOP", "end", "allowed"),
            row("r-b-stay", "b", "STAY", "b", "rejected", reject_code="B_NO_STAY", reason="b 不接受 STAY"),
            row("r-never", "c", "NEVER", "c", "unknown", reason="诚实声明：c 收到 NEVER 未建模"),
        ],
    )


def test_unlisted_returns_unknown_without_raising():
    m = sample()
    r = interpret(m, "b", "GO", {"n": 0})
    assert r.status == "unknown" and r.to == "b"
    assert "未在表里列出" in r.reason
    assert interpret(m, "zzz", "GO", {"n": 0}).status == "unknown"
    assert interpret(m, "a", "WHAT", {"n": 0}).status == "unknown"


def test_declared_unknown_row():
    r = interpret(sample(), "c", "NEVER", {"n": 0})
    assert r.status == "unknown"
    assert "诚实声明" in r.reason
    assert r.row is not None


def test_guard_order_first_hit_and_none_hit_is_unknown():
    m = sample()
    r1 = interpret(m, "a", "GO", {"n": 1})
    assert (r1.status, r1.to, r1.reason) == ("allowed", "b", "小走 b")
    r5 = interpret(m, "a", "GO", {"n": 5})
    assert (r5.status, r5.to, r5.reason) == ("allowed", "c", "大走 c")
    both = define_machine(**{**BASE, "feature": "both"}, guards={"t1": lambda f: True, "t2": lambda f: True}, rows=[row("x1", "a", "GO", "c", "allowed", guard="t2"), row("x2", "a", "GO", "b", "allowed", guard="t1")])
    assert interpret(both, "a", "GO", {"n": 0}).to == "c"
    none = define_machine(**{**BASE, "feature": "none"}, guards={"f": lambda f: False}, rows=[row("x3", "a", "GO", "b", "allowed", guard="f")])
    r = interpret(none, "a", "GO", {"n": 0})
    assert (r.status, r.to) == ("unknown", "a")
    assert "守卫均未命中" in r.reason


def test_rejected_and_noop_keep_state():
    m = sample()
    r = interpret(m, "a", "STAY", {"n": 0})
    assert (r.status, r.to) == ("noop", "a")
    b = interpret(m, "b", "STAY", {"n": 0})
    assert (b.status, b.to, b.reason, b.reject_code) == ("blocked", "b", "b 不接受 STAY", "B_NO_STAY")
    assert b.row.kind == "rejected"
    c = next(x for x in to_contract(m)["rows"] if x["id"] == "r-b-stay")
    assert (c["kind"], c["reject_code"]) == ("rejected", "B_NO_STAY")


def test_definition_time_validation():
    base = {**BASE, "feature": "bad"}
    with pytest.raises(MachineDefinitionError):
        define_machine(**base, rows=[row("x4", "end", "GO", "a", "allowed")])
    with pytest.raises(MachineDefinitionError, match='guard "nope" 未定义'):
        define_machine(**base, rows=[row("x5", "a", "GO", "b", "allowed", guard="nope")])
    with pytest.raises(MachineDefinitionError, match="永远不可达"):
        define_machine(**base, guards={"g": lambda f: True}, rows=[row("x6", "a", "GO", "b", "allowed"), row("x7", "a", "GO", "c", "allowed", guard="g")])
    with pytest.raises(MachineDefinitionError, match="不能改变状态"):
        define_machine(**base, rows=[row("x8", "a", "GO", "b", "rejected", reject_code="X")])
    with pytest.raises(MachineDefinitionError, match="reject_code"):
        define_machine(**base, rows=[row("x8b", "a", "GO", "a", "rejected")])
    with pytest.raises(MachineDefinitionError, match="covered_by"):
        define_machine(**base, rows=[row("x9", "a", "GO", "b", "allowed", covered_by=["no-separator"])])
    with pytest.raises(MachineDefinitionError, match="evidence"):
        define_machine(**base, rows=[], invariants=[Invariant("x", "t", "P0", "enforced")])


def test_a1_row_ids_required_and_unique():
    base = {**BASE, "feature": "ids"}
    with pytest.raises(MachineDefinitionError, match="id"):
        define_machine(**base, rows=[row("", "a", "GO", "b", "allowed")])
    with pytest.raises(MachineDefinitionError, match="dup"):
        define_machine(**base, rows=[row("dup", "a", "GO", "b", "allowed"), row("dup", "b", "STOP", "end", "allowed")])
    c = to_contract(sample())
    assert (c["rows"][0]["id"], c["rows"][0]["signature"]) == ("r-go-small", "a --GO[small]--> b")


def test_a4_planned_invariant_needs_note():
    base = {**BASE, "feature": "inv", "rows": []}
    with pytest.raises(MachineDefinitionError, match="planned.*note|note.*planned"):
        define_machine(**base, invariants=[Invariant("p", "t", "P1", "planned")])
    ok = define_machine(**base, invariants=[Invariant("p", "t", "P1", "planned", note="只靠 prompt 规则，live 场景观察")])
    inv = to_contract(ok)["invariants"][0]
    assert (inv["id"], inv["status"], inv["note"]) == ("p", "planned", "只靠 prompt 规则，live 场景观察")


def test_enumerate_all_cells():
    cells = enumerate_cells(sample())
    assert len(cells) == 16
    assert sum(1 for c in cells if c.listed) == 5
    assert len(next(c for c in cells if c.from_ == "a" and c.event == "GO").rows) == 2
    assert next(c for c in cells if c.from_ == "b" and c.event == "GO").listed is False
    assert all(not c.listed for c in cells if c.from_ == "end")


def test_reachable_bfs():
    m = define_machine(**{**BASE, "feature": "r"}, rows=[row("x10", "a", "GO", "b", "allowed"), row("x11", "b", "STOP", "end", "allowed"), row("x12", "b", "STAY", "b", "rejected", reject_code="NO"), row("x13", "c", "GO", "end", "allowed")])
    r = reachable(m)
    assert r.states == ["a", "b", "end"]
    assert r.unreachable_states == ["c"]
    assert len(r.rows) == 3
    assert [x.from_ for x in r.unreachable_rows] == ["c"]
    assert reachable(sample()).unreachable_states == []


def test_to_contract_deterministic():
    assert render_contract(sample()) == render_contract(sample())
    c = to_contract(sample())
    assert c["guards"] == ["small", "big"]
    assert "lambda" not in json.dumps(c) and "function" not in json.dumps(c)
    assert (c["cells"]["total"], c["cells"]["listed"]) == (16, 5)
    assert c["cells"]["declared_unknown"] == ["c --NEVER--> c"]
    assert "b + GO" in c["cells"]["unlisted"]
    r0 = c["rows"][0]
    assert (r0["id"], r0["signature"], r0["guard"], r0["kind"], r0["covered_by"]) == ("r-go-small", "a --GO[small]--> b", "small", "allowed", [])
