"""通用状态表解释器：数据表 + 一个解释器，语义与 docs/product/SPEC-state-machines.md §2 D2 一致。
  - 定义期校验：状态/事件/守卫存在、终态无出边、同格 guard 顺序合法
  - interpret：同格多行按 guard 顺序取首条命中；未列 (state, event) = unknown，永不抛
  - enumerate_cells：全表逐格列出（含未列格），供契约与对账
  - reachable：从某状态出发沿 allowed 行 BFS，给出可达状态/行与不可达项
  - to_contract：同一张表永远产出同一份 JSON（无时间戳、无函数），漂移测试对它

行级 kind：allowed | rejected | noop | unknown；判定级 verdict：allowed | blocked | noop | unknown（rejected 行命中 → blocked）
"""
import json
import re
from dataclasses import dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Sequence

KINDS = ("allowed", "rejected", "noop", "unknown")
_REF = re.compile(r"^[^:]+::.+$")


@dataclass
class Row:
    id: str  # 行的显式 id（`t-llm-ok` 风格），定义期查重；trace 记录与答案卷都用它，改 reason 不会漂
    from_: str
    event: str
    to: str
    kind: str
    guard: Optional[str] = None  # 守卫名，需在 machine.guards 里有对应函数；同格多行按定义顺序取首条命中
    reject_code: Optional[str] = None  # rejected 行必填：被拦下的机器可读原因（如 PARSE_ERROR），进 trace 的 reject_code
    reason: Optional[str] = None
    priority: Optional[str] = None
    covered_by: List[str] = field(default_factory=list)  # 手写测试位置：`tests/unit/<file>::<测试名>`
    effects: List[str] = field(default_factory=list)  # 该转移允许触发的副作用种类（只作文档与对账，不参与解释）


def row(id: str, from_: str, event: str, to: str, kind: str, **kw: Any) -> Row:
    return Row(id=id, from_=from_, event=event, to=to, kind=kind, **kw)


@dataclass
class Invariant:
    id: str
    text: str
    priority: str
    status: str  # enforced | planned
    evidence: List[str] = field(default_factory=list)  # enforced 时必填：`<file>::<symbol>`，契约测试会到盘上找
    note: Optional[str] = None  # planned 时必填：为什么还没 enforced、现在靠什么观察


@dataclass
class Interpretation:
    status: str
    from_: str
    to: str
    event: str
    reason: Optional[str] = None
    reject_code: Optional[str] = None  # blocked 时 = 行的 reject_code
    row: Optional[Row] = None  # 命中的行；unknown 且未列时为空


@dataclass
class Cell:
    from_: str
    event: str
    rows: List[Row]
    listed: bool  # 表里至少列了一行（含 kind:'unknown' 的诚实声明）


@dataclass
class Reachability:
    states: List[str]
    rows: List[Row]
    unreachable_states: List[str]
    unreachable_rows: List[Row]


class MachineDefinitionError(Exception):
    pass


def row_signature(r: Row) -> str:
    """可读的格签名 `from --EVENT[guard]--> to`：只作文档与报错，不是行的身份（身份是 row.id）"""
    return f"{r.from_} --{r.event}{'[' + r.guard + ']' if r.guard else ''}--> {r.to}"


@dataclass
class Machine:
    feature: str
    anchor: str  # 规格锚点，如 docs/SPEC.md#实现决策 → 循环
    initial: str
    states: List[str]
    terminal: List[str]
    events: List[str]
    rows: List[Row]
    guards: Dict[str, Callable[[Any], bool]] = field(default_factory=dict)
    invariants: List[Invariant] = field(default_factory=list)

    def is_terminal(self, state: str) -> bool:
        return state in self.terminal

    def cell(self, state: str, event: str) -> List[Row]:
        """某格 (state, event) 的全部行，按定义顺序"""
        return [r for r in self.rows if r.from_ == state and r.event == event]

    def replace(self, **changes: Any) -> "Machine":
        """换掉若干字段后重新走定义期校验（测试用：残缺表 / 改措辞）"""
        m = replace(self, **changes)
        return define_machine(feature=m.feature, anchor=m.anchor, initial=m.initial, states=m.states, terminal=m.terminal, events=m.events, rows=m.rows, guards=m.guards, invariants=m.invariants)


def define_machine(
    feature: str,
    anchor: str,
    initial: str,
    states: Sequence[str],
    terminal: Sequence[str],
    events: Sequence[str],
    rows: Sequence[Row],
    guards: Optional[Dict[str, Callable[[Any], bool]]] = None,
    invariants: Optional[Sequence[Invariant]] = None,
) -> Machine:
    def fail(msg: str) -> None:
        raise MachineDefinitionError(f"[{feature}] {msg}")

    guards = dict(guards or {})
    states, terminal, events, rows, invariants = list(states), list(terminal), list(events), list(rows), list(invariants or [])
    if not states:
        fail("states 不能为空")
    if not events:
        fail("events 不能为空")
    if len(set(states)) != len(states):
        fail("states 有重复")
    if len(set(events)) != len(events):
        fail("events 有重复")
    if initial not in states:
        fail(f'initial "{initial}" 不在 states 里')
    for t in terminal:
        if t not in states:
            fail(f'terminal "{t}" 不在 states 里')
    if initial in terminal:
        fail("initial 不能是终态")

    seen_guardless: set = set()
    seen_guards: set = set()
    seen_ids: set = set()
    for r in rows:
        sig = row_signature(r)
        if not isinstance(r.id, str) or not r.id.strip():
            fail(f"行 {sig}：缺少显式 id")
        if r.id in seen_ids:
            fail(f'行 {sig}：id "{r.id}" 重复')
        seen_ids.add(r.id)
        if r.from_ not in states:
            fail(f"行 {sig}：from 不在 states 里")
        if r.to not in states:
            fail(f"行 {sig}：to 不在 states 里")
        if r.event not in events:
            fail(f"行 {sig}：event 不在 events 里")
        if r.from_ in terminal:
            fail(f"行 {sig}：终态不能有出边")
        if r.guard is not None and not callable(guards.get(r.guard)):
            fail(f'行 {sig}：guard "{r.guard}" 未定义')
        if r.kind != "allowed" and r.to != r.from_:
            fail(f"行 {sig}：{r.kind} 行不能改变状态（to 必须等于 from）")
        if r.kind == "rejected" and not r.reject_code:
            fail(f"行 {sig}：rejected 行必须带 reject_code")
        cell_key = f"{r.from_}|{r.event}"
        if cell_key in seen_guardless:
            fail(f"行 {sig}：同格已有无守卫行在前，此行永远不可达")
        if r.guard is None:
            seen_guardless.add(cell_key)
        else:
            gk = f"{cell_key}|{r.guard}"
            if gk in seen_guards:
                fail(f'行 {sig}：同格重复守卫 "{r.guard}"')
            seen_guards.add(gk)
        for c in r.covered_by:
            if not _REF.match(c):
                fail(f'行 {sig}：covered_by "{c}" 应为 <file>::<测试名>')
    for inv in invariants:
        if inv.status == "enforced" and not inv.evidence:
            fail(f"不变量 {inv.id}：enforced 必须带 evidence")
        if inv.status == "planned" and not (inv.note and inv.note.strip()):
            fail(f"不变量 {inv.id}：planned 必须带 note（为什么还没 enforced、现在靠什么观察）")
        for e in inv.evidence:
            if not _REF.match(e):
                fail(f'不变量 {inv.id}：evidence "{e}" 应为 <file>::<symbol>')

    return Machine(feature=feature, anchor=anchor, initial=initial, states=states, terminal=terminal, events=events, rows=rows, guards=guards, invariants=invariants)


def interpret(m: Machine, state: str, event: str, facts: Any) -> Interpretation:
    """解释一次 (state, event)。永不抛：未列组合、守卫全不命中、甚至状态/事件名不在表里都返回 unknown。"""
    if state not in m.states:
        return Interpretation("unknown", state, state, event, reason=f'状态 "{state}" 不在表里')
    if event not in m.events:
        return Interpretation("unknown", state, state, event, reason=f'事件 "{event}" 不在表里')
    rows = m.cell(state, event)
    for r in rows:
        if r.guard is None or m.guards[r.guard](facts):
            return Interpretation("blocked" if r.kind == "rejected" else r.kind, state, r.to, event, reason=r.reason, reject_code=r.reject_code, row=r)
    return Interpretation("unknown", state, state, event, reason=f"({state}, {event}) 有 {len(rows)} 行但守卫均未命中" if rows else f"({state}, {event}) 未在表里列出")


def enumerate_cells(m: Machine) -> List[Cell]:
    """全表逐格：状态 × 事件，含未列格。顺序 = 定义顺序，保证确定性。"""
    return [Cell(s, e, m.cell(s, e), bool(m.cell(s, e))) for s in m.states for e in m.events]


def reachable(m: Machine, from_: Optional[str] = None) -> Reachability:
    """从 from（默认 initial）沿 allowed 行 BFS。非 allowed 行只要其 from 可达就算可达行。"""
    start = from_ or m.initial
    seen = {start}
    queue = [start]
    while queue:
        s = queue.pop(0)
        for r in m.rows:
            if r.from_ == s and r.kind == "allowed" and r.to not in seen:
                seen.add(r.to)
                queue.append(r.to)
    return Reachability(
        states=[s for s in m.states if s in seen],
        rows=[r for r in m.rows if r.from_ in seen],
        unreachable_states=[s for s in m.states if s not in seen],
        unreachable_rows=[r for r in m.rows if r.from_ not in seen],
    )


def to_contract(m: Machine) -> Dict[str, Any]:
    """契约 = 表的纯数据投影。同表同输出；函数（guard）只留名字。"""
    cells = enumerate_cells(m)
    r = reachable(m)
    return {
        "feature": m.feature,
        "anchor": m.anchor,
        "initial": m.initial,
        "states": list(m.states),
        "terminal": list(m.terminal),
        "events": list(m.events),
        "guards": list(m.guards.keys()),
        "rows": [
            {
                "id": x.id, "signature": row_signature(x), "from": x.from_, "event": x.event, "guard": x.guard, "to": x.to, "kind": x.kind,
                "reject_code": x.reject_code, "reason": x.reason, "priority": x.priority, "covered_by": list(x.covered_by), "effects": list(x.effects),
            }
            for x in m.rows
        ],
        "invariants": [{"id": i.id, "text": i.text, "priority": i.priority, "status": i.status, "evidence": list(i.evidence), "note": i.note} for i in m.invariants],
        "cells": {
            "total": len(cells),
            "listed": sum(1 for c in cells if c.listed),
            "declared_unknown": [row_signature(x) for x in m.rows if x.kind == "unknown"],
            "unlisted": [f"{c.from_} + {c.event}" for c in cells if not c.listed],
        },
        "reachable": {"states": r.states, "unreachable_states": r.unreachable_states, "unreachable_rows": [row_signature(x) for x in r.unreachable_rows]},
    }


def render_contract(m: Machine) -> str:
    return json.dumps(to_contract(m), ensure_ascii=False, indent=2) + "\n"
