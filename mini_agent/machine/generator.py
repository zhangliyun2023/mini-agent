"""自动 E2E 的前半段（docs/product/SPEC-state-machines.md §5）：
从表 + runner 协议 BFS 出所有到终态的事件路径，每条路径 = 期望转移序列（答案卷）+ 走过的行。
不让 LLM 写用例：路径→FakeLLM 脚本的绑定在测试侧完成（tests/unit/test_generator.py）。
"""
from dataclasses import dataclass, field
from typing import Any, Callable, List, Optional

from .interpreter import Machine, Row, interpret


@dataclass
class GeneratedPath:
    id: str
    events: List[str]
    expected: List[str]  # 答案卷：行 id 序列，非 allowed 追加 ` [status]`；与 MemoryTraceSink.sequence() 同格式
    row_ids: List[str]  # 纯行 id 序列（不带 status），与 contracts/journeys.json 的 expect 同格式
    rows: List[Row]
    terminal: str


@dataclass
class Gap:
    state: str
    event: str
    after: List[str]
    reason: Optional[str] = None


@dataclass
class GenerationResult:
    paths: List[GeneratedPath]
    gaps: List[Gap]  # runner 会发出、但表没列（或守卫全不命中）的组合——表与代码漂了
    rows_used: List[str]  # 生成路径走过的行 id（去重，按定义顺序）


@dataclass
class _Node:
    state: str
    facts: Any
    last: Optional[str]
    events: List[str] = field(default_factory=list)
    expected: List[str] = field(default_factory=list)
    rows: List[Row] = field(default_factory=list)


def generate_paths(m: Machine, protocol: Any, initial_facts: Optional[Callable[[], Any]] = None, max_depth: int = 64) -> GenerationResult:
    """protocol 需有 advance(facts, event) 与 next(state, last)；initial_facts 缺省用 protocol.initial_facts()"""
    init = initial_facts or protocol.initial_facts
    paths: List[GeneratedPath] = []
    gaps: List[Gap] = []
    used: set = set()
    queue = [_Node(m.initial, init(), None)]
    while queue:
        n = queue.pop(0)
        if m.is_terminal(n.state):
            paths.append(GeneratedPath(" > ".join(n.events), n.events, n.expected, [r.id for r in n.rows], n.rows, n.state))
            continue
        if len(n.events) >= max_depth:
            raise RuntimeError(f"路径超过 {max_depth} 步仍未到终态：{' > '.join(n.events)}")
        candidates = protocol.next(n.state, n.last)
        if not candidates:
            raise RuntimeError(f"runner 协议在非终态 {n.state}（上一事件 {n.last}）没有可发出的事件")
        for event in candidates:
            facts = protocol.advance(n.facts, event)
            t = interpret(m, n.state, event, facts)
            if t.status == "unknown":
                gaps.append(Gap(n.state, event, list(n.events), t.reason))
                continue
            assert t.row is not None
            used.add(t.row.id)
            queue.append(_Node(t.to, facts, event, [*n.events, event], [*n.expected, f"{t.row.id}{'' if t.status == 'allowed' else ' [' + t.status + ']'}"], [*n.rows, t.row]))
    return GenerationResult(paths, gaps, [r.id for r in m.rows if r.id in used])
