"""B2 / S3.5 模型层随机探索：只用表 + interpret，几秒。带种子随机游走，每步随机事件 + 随机 guard 取值；
通用不变量：已建模的格不得 unknown（guard 洞）、blocked/noop 停留、allowed 落在 modeled 状态、终态吸收；红了 ddmin 缩到最短复现。"""
import re

import pytest

from contracts.review_machine import review_machine
from contracts.session_machine import session_machine
from contracts.session_runtime_machine import session_runtime_machine
from contracts.turn_machine import turn_machine
from mini_agent.machine.explore import Step, ddmin, explore
from mini_agent.machine.interpreter import define_machine, row


def test_same_seed_reproducible():
    a = explore(turn_machine, seed=7, walks=50, max_steps=20)
    b = explore(turn_machine, seed=7, walks=50, max_steps=20)
    assert a.to_json() == b.to_json()
    assert a.steps_taken > 0


def test_red_guard_hole_found_and_minimized():
    holed = define_machine(
        feature="holed", anchor="t", initial="a", states=["a", "b", "end"], terminal=["end"], events=["GO", "STAY"],
        guards={"ok": lambda f: f["ok"]},
        rows=[row("h-go", "a", "GO", "b", "allowed", guard="ok"), row("h-stay", "a", "STAY", "a", "noop"), row("h-stop", "b", "GO", "end", "allowed")],
    )
    r = explore(holed, seed=1, walks=30, max_steps=10)
    assert r.violations
    assert r.violations[0].invariant == "modeled-cell-never-unknown"
    assert re.search(r"\(a, GO\)", r.violations[0].message)
    assert r.minimal.steps == [Step("GO", {"ok": False})]


def test_ddmin_minimizes():
    assert ddmin([1, 2, 3, 4, 5, 6, 7, 8], lambda xs: 3 in xs and 7 in xs) == [3, 7]


@pytest.mark.parametrize("name,m", [("turn", turn_machine), ("session", session_machine), ("session-runtime", session_runtime_machine), ("review", review_machine)])  # ×4
def test_tables_zero_violations(name, m):
    r = explore(m, seed=20260914, walks=300, max_steps=40)
    assert r.violations == []
    assert r.minimal is None
    # 每一行都被随机游走碰到过（探索覆盖，不是手写覆盖）
    assert r.rows_never_hit == []
