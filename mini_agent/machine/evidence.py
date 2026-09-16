"""把不变量 oracle 接到真实证据上：读 FileTraceSink 写出的 JSONL，按 trace_id 分轮，逐轮过
check_trace_only_invariants（① ② ③ ⑤ + unknown 点名）。live 测试收尾时对本次产出跑一遍；
离线单测对仓库里已提交的 evals/live-trace/ 跑一遍。这里不碰 runtime，只读文件。
④（答案 == 盘上历史末条 == trace 末次决策）需要 RunResult 与盘上会话历史，只凭 trace 判不了，不在此列。
"""
import json
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from .invariants import check_trace_only_invariants


@dataclass
class TurnReport:
    file: str
    trace_id: str
    records: int
    terminal: Optional[str]
    violations: List[dict]


@dataclass
class EvidenceReport:
    files: int
    turns: List[TurnReport]
    failed: List[TurnReport]  # 有违反项的轮
    records: int  # 所有记录数（可写进报告的「N 条转移」）
    statuses: Dict[str, int] = field(default_factory=dict)  # status 分布：allowed / noop / blocked / unknown 各多少条


def list_trace_files(root: str) -> List[str]:
    """递归列出 root 下所有 .jsonl（按名排序，稳定）"""
    if not os.path.exists(root):
        return []
    out: List[str] = []
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isdir(p):
            out.extend(list_trace_files(p))
        elif name.endswith(".jsonl"):
            out.append(p)
    return out


def read_trace_file(path: str) -> List[dict]:
    out: List[dict] = []
    with open(path, encoding="utf8") as f:
        for i, line in enumerate(f):
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except ValueError as e:
                raise ValueError(f"{path}:{i + 1} 不是合法 JSON：{e}")
    return out


def group_by_trace(records: List[dict]) -> Dict[str, List[dict]]:
    """按 trace_id 分组（一个 trace_id = 一轮），保持文件内出现顺序"""
    m: Dict[str, List[dict]] = {}
    for r in records:
        m.setdefault(r["trace_id"], []).append(r)
    return m


def check_trace_files(paths: List[str]) -> EvidenceReport:
    turns: List[TurnReport] = []
    statuses: Dict[str, int] = {}
    records = 0
    for file in paths:
        rows = read_trace_file(file)
        records += len(rows)
        for r in rows:
            statuses[r["status"]] = statuses.get(r["status"], 0) + 1
        for trace_id, turn in group_by_trace(rows).items():
            violations = [x for x in check_trace_only_invariants(turn) if x["violations"]]
            turns.append(TurnReport(file, trace_id, len(turn), turn[-1]["to"] if turn else None, violations))
    return EvidenceReport(len(paths), turns, [t for t in turns if t.violations], records, statuses)


def summarize(report: EvidenceReport) -> str:
    """报告的可读摘要，给测试失败信息与 TEST_REPORT 用"""
    lines = [f"{report.files} 个文件，{len(report.turns)} 轮，{report.records} 条转移，status 分布 {json.dumps(report.statuses, ensure_ascii=False)}"]
    for t in report.failed:
        for v in t.violations:
            for msg in v["violations"]:
                lines.append(f"  ✗ {t.file} {t.trace_id} [{v['id']}] {msg}")
    return "\n".join(lines)
