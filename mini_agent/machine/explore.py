"""模型层随机探索（S3.5 / B2）：只用表 + interpret，不跑 runtime。
带种子的随机游走：每步随机挑一个事件 + 一组随机 guard 取值（guard 的取值域 = 布尔），interpret 后检查通用不变量：
  modeled-cell-never-unknown  表里列了行的格，不论 guard 怎么取都不得返回 unknown（否则是 guard 洞：只有守卫行、没有兜底）
  stay-on-non-allowed         blocked / noop / unknown 必须停留在原状态
  allowed-lands-modeled       allowed 必须命中一行且落在表里声明的状态
  terminal-absorbing          到了终态，任何事件都出不去（本仓保留「终态无出边」，拍板①）
红了就 ddmin 把事件序列缩到最短复现；同一 seed 永远同一结果。
"""
import json
from dataclasses import asdict, dataclass, field, replace
from typing import Any, Callable, Dict, List, Optional, Sequence, TypeVar

from .interpreter import Machine, interpret

T = TypeVar("T")


@dataclass
class Step:
    event: str
    guards: Dict[str, bool]  # 这一步各 guard 的取值


@dataclass
class Violation:
    invariant: str
    message: str
    steps: List[Step]  # 从 initial 起到出问题那一步（含）的序列，可直接回放
    state: str


@dataclass
class ExploreResult:
    feature: str
    seed: int
    walks: int
    steps_taken: int
    violations: List[Violation]
    minimal: Optional[Violation]  # 第一条违反经 ddmin 缩减后的最短复现；没有违反时为 None
    rows_hit: List[str]
    rows_never_hit: List[str]

    def to_json(self) -> str:
        return json.dumps(asdict(self), ensure_ascii=False, sort_keys=True)


def prng(seed: int) -> Callable[[], float]:
    """mulberry32：够用的带种子 PRNG，同 seed 同序列（32 位无符号运算）"""
    state = [seed & 0xFFFFFFFF]

    def imul(a: int, b: int) -> int:
        return ((a & 0xFFFFFFFF) * (b & 0xFFFFFFFF)) & 0xFFFFFFFF

    def rnd() -> float:
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = imul(t ^ (t >> 15), t | 1)
        t = (t ^ (t + imul(t ^ (t >> 7), t | 61))) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rnd


def _probe_machine(m: Machine) -> Machine:
    """guard 的取值域是布尔：把表里的 guard 函数换成「查这一步的取值表」，其余不动（不重走定义期校验：只是换函数）"""
    return replace(m, guards={g: (lambda f, g=g: f.get(g) is True) for g in m.guards})


def replay(m: Machine, steps: Sequence[Step]) -> Dict[str, Any]:
    """回放一段序列：返回 {violation, state, rows_hit}；violation 为第一条违反或 None"""
    probe = _probe_machine(m)
    state = m.initial
    rows_hit: set = set()

    def fail(invariant: str, message: str, i: int) -> Dict[str, Any]:
        return {"violation": Violation(invariant, message, list(steps[: i + 1]), state), "state": state, "rows_hit": rows_hit}

    for i, step in enumerate(steps):
        t = interpret(probe, state, step.event, step.guards)
        if t.row:
            rows_hit.add(t.row.id)
        listed = m.cell(state, step.event)
        if m.is_terminal(state):
            if t.to != state or t.status == "allowed":
                return fail("terminal-absorbing", f"终态 {state} 收到 {step.event} 竟然 {t.status} → {t.to}", i)
            continue
        if t.status == "unknown" and not t.row and listed:
            return fail("modeled-cell-never-unknown", f"({state}, {step.event}) 表里列了 {len(listed)} 行，guard 取值 {json.dumps(step.guards)} 时却 unknown：只有守卫行、没有无守卫兜底", i)
        if t.status != "allowed" and t.to != state:
            return fail("stay-on-non-allowed", f"{t.status} 转移不该改状态：{state} → {t.to}", i)
        if t.status == "allowed" and (not t.row or t.to not in m.states):
            return fail("allowed-lands-modeled", f"allowed 却落在表外状态 {t.to}", i)
        state = t.to
    return {"violation": None, "state": state, "rows_hit": rows_hit}


def ddmin(items: List[T], test: Callable[[List[T]], bool]) -> List[T]:
    """经典 ddmin（Zeller）：在保持 test(sub)=True 的前提下把序列缩到 1-minimal"""
    cur = list(items)
    n = 2
    while len(cur) >= 2:
        size = -(-len(cur) // n)
        chunks = [cur[i : i + size] for i in range(0, len(cur), size)]
        reduced = False
        for chunk in chunks:
            if test(chunk):
                cur, n, reduced = chunk, 2, True
                break
        if reduced:
            continue
        if n > 2 or len(chunks) > 2:
            for chunk in chunks:
                complement = [x for x in cur if x not in chunk]
                if complement and test(complement):
                    cur, n, reduced = complement, max(n - 1, 2), True
                    break
        if reduced:
            continue
        if n >= len(cur):
            break
        n = min(n * 2, len(cur))
    return cur


def explore(m: Machine, seed: int, walks: int = 200, max_steps: int = 30) -> ExploreResult:
    rnd = prng(seed)
    guard_names = list(m.guards.keys())

    def pick(xs: Sequence[Any]) -> Any:
        return xs[int(rnd() * len(xs))]

    def random_step() -> Step:
        return Step(pick(m.events), {g: rnd() < 0.5 for g in guard_names})

    violations: List[Violation] = []
    rows_hit: set = set()
    steps_taken = 0
    for _ in range(walks):
        steps: List[Step] = []
        state = m.initial
        for _i in range(max_steps):
            steps.append(random_step())
            r = replay(m, steps)
            steps_taken += 1
            rows_hit |= r["rows_hit"]
            if r["violation"]:
                violations.append(r["violation"])
                break
            # 到了终态：再随机探一步验证吸收（replay 里会查），然后结束这条游走
            if m.is_terminal(r["state"]) and not m.is_terminal(state):
                steps.append(random_step())
                probe = replay(m, steps)
                steps_taken += 1
                if probe["violation"]:
                    violations.append(probe["violation"])
                break
            state = r["state"]
    minimal: Optional[Violation] = None
    if violations:
        first = violations[0]
        reduced = ddmin(first.steps, lambda sub: (replay(m, sub)["violation"] or Violation("", "", [], "")).invariant == first.invariant)
        v = replay(m, reduced)["violation"]
        assert v is not None
        minimal = replace(v, steps=reduced)
    hit = [r.id for r in m.rows if r.id in rows_hit]
    return ExploreResult(m.feature, seed, walks, steps_taken, violations, minimal, hit, [r.id for r in m.rows if r.id not in rows_hit])
