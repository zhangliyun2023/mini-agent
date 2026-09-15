#!/usr/bin/env python3
"""evals/judge.py —— 只凭 JSONL 转移记录判分的独立判分器（#13）。

用法：
    python3 evals/judge.py <dir-or-file>... [--contract contracts/turn.contract.json] [--json]

递归收集 *.jsonl，按文件、按 trace_id 分轮（一个 trace_id = 一轮），轮内按 seq 排序，逐轮跑
「只凭 trace 就能判」的不变量——与 src/machine/invariants.ts::checkTraceOnlyInvariants 同一份判据：
  ① no_tool_after_parse_error  解析失败之后不跑工具：tool 副作用只出现在 executing_tools + TOOLS_DONE，
                                且前一条必是 allowed 的 PARSED_TOOL_CALLS → executing_tools
  ② exactly_one_final_answer   一轮恰一条终态转移且是末条，恰一个 answer 副作用且挂在终态转移上
  ③ terminal_states_distinct   终态 ↔ answer.stoppedBy 一一对应（done→final / max_steps→max_steps / error→error）
  ⑤ effects_declared           每条记录的 effects[].kind ⊆ 契约里该行（按 transition 行 id 查）声明的 effects；
                                compact 只允许挂在 seq 1；status=unknown 的记录没有行 id，不在此判
  +  unknown_never_silent      status=unknown 的记录单独点名，永远不静默
④（答案 == 盘上历史末条 == trace 末次决策）需要 RunResult 与盘上会话历史，只凭 trace 判不了，不在此列。

输出：每轮一行 `trace_id<TAB>passed|failed<TAB>file`，failed 的轮下面缩进列违反明细 `✗ [不变量 id] 明细`；
unknown 记录另起一节点名；末行汇总 `files=… turns=… transitions=… passed=… failed=… unknown=…`。
`--json` 输出结构化结果。退出码：有 failed 或 unknown → 1；没有任何轮 → 打印 not_observed，退出码 2；否则 0。
只用标准库，Python ≥ 3.9。不改表、不碰 runtime：契约 JSON 是判据来源，表改了这里跟着改口径。
"""
import argparse
import json
import os
import sys
from collections import OrderedDict

STOPPED_BY = {"done": "final", "max_steps": "max_steps", "error": "error"}
DEFAULT_CONTRACT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "contracts", "turn.contract.json")


# ---------- 读入 ----------

def list_trace_files(root):
    """递归列出 root 下所有 .jsonl（按名排序，稳定）；root 是文件则原样返回。与 evidence.ts::listTraceFiles 同序。"""
    if os.path.isfile(root):
        return [root]
    if not os.path.isdir(root):
        return []
    out = []
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isdir(p):
            out.extend(list_trace_files(p))
        elif name.endswith(".jsonl"):
            out.append(p)
    return out


def read_trace_file(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except ValueError as e:
                raise SystemExit("%s:%d 不是合法 JSON：%s" % (path, i, e))
    return rows


def group_by_trace(rows):
    """按 trace_id 分组，保持文件内首次出现顺序；组内按 seq 稳定排序。"""
    groups = OrderedDict()
    for r in rows:
        groups.setdefault(r.get("trace_id"), []).append(r)
    for tid in groups:
        groups[tid].sort(key=lambda r: r.get("seq", 0))
    return groups


def load_contract(path):
    with open(path, encoding="utf-8") as f:
        c = json.load(f)
    terminal = set(c.get("terminal") or [])
    rows = {row["id"]: row for row in c.get("rows", [])}
    return terminal, rows


# ---------- 判据（与 invariants.ts 逐条对应，文字尽量一致） ----------

def _effects(r, kind):
    return [e for e in r.get("effects") or [] if e.get("kind") == kind]


def no_tool_after_parse_error(records):
    v = []
    for i, r in enumerate(records):
        tools = _effects(r, "tool")
        if r.get("event") == "PARSED_ERROR" and tools:
            v.append("#%s PARSED_ERROR 转移上挂了 %d 个 tool 副作用" % (r.get("seq"), len(tools)))
        if not tools:
            continue
        if r.get("event") != "TOOLS_DONE" or r.get("from") != "executing_tools":
            v.append("#%s tool 副作用出现在 %s + %s 上，只允许出现在 executing_tools + TOOLS_DONE" % (r.get("seq"), r.get("from"), r.get("event")))
        prev = records[i - 1] if i > 0 else None
        if not prev or prev.get("event") != "PARSED_TOOL_CALLS" or prev.get("status") != "allowed" or prev.get("to") != "executing_tools":
            actual = "%s [%s]" % (prev.get("event"), prev.get("status")) if prev else "无"
            v.append("#%s 工具执行前一条不是 allowed 的 PARSED_TOOL_CALLS → executing_tools（实际：%s）" % (r.get("seq"), actual))
    return v


def exactly_one_final_answer(records, terminal):
    v = []
    terminals = [r for r in records if r.get("to") in terminal]
    if len(terminals) != 1:
        v.append("终态转移应恰 1 条，实际 %d 条" % len(terminals))
    if records and records[-1].get("to") not in terminal:
        v.append("末条转移 %s 不是终态" % records[-1].get("to"))
    answers = [e for r in records for e in _effects(r, "answer")]
    if len(answers) != 1:
        v.append("answer 副作用应恰 1 个，实际 %d 个" % len(answers))
    if len(answers) == 1:
        holder = next(r for r in records if _effects(r, "answer"))
        if holder.get("to") not in terminal:
            v.append("answer 副作用挂在非终态转移上")
    return v


def terminal_states_distinct(records, stopped_by, terminal):
    terminals = [r for r in records if r.get("to") in terminal]
    if len(terminals) != 1:
        return ["终态转移应恰 1 条，实际 %d 条：%s" % (len(terminals), ", ".join(str(t.get("to")) for t in terminals))]
    v = []
    to = terminals[0].get("to")
    expected = STOPPED_BY.get(to)
    if expected != stopped_by:
        v.append("终态 %s 应对应 stoppedBy=%s，实际 %s" % (to, expected, stopped_by))
    a = _effects(terminals[0], "answer")
    if a and a[0].get("stoppedBy") != stopped_by:
        v.append("answer 副作用的 stoppedBy=%s 与结果 %s 不一致" % (a[0].get("stoppedBy"), stopped_by))
    return v


def effects_declared(records, rows):
    v = []
    for r in records:
        if r.get("status") == "unknown":
            continue
        row = rows.get(r.get("transition")) if r.get("transition") else None
        if row is None:
            v.append('#%s 行 id "%s" 在表里不存在（%s --%s--> %s [%s]）' % (r.get("seq"), r.get("transition"), r.get("from"), r.get("event"), r.get("to"), r.get("status")))
            continue
        declared = row.get("effects") or []
        for e in r.get("effects") or []:
            kind = e.get("kind")
            if kind not in declared:
                v.append('#%s %s 上出现了表未声明的副作用 "%s"（该行声明：%s）' % (r.get("seq"), row["id"], kind, ", ".join(declared) or "无"))
            elif kind == "compact" and r.get("seq") != 1:
                v.append("#%s %s 上出现了 compact，但 compact 只允许挂在轮首第一条转移上" % (r.get("seq"), row["id"]))
    return v


def unknown_rows(records):
    return [r for r in records if r.get("status") == "unknown"]


def check_trace_only_invariants(records, terminal, rows):
    """与 invariants.ts::checkTraceOnlyInvariants 同一份清单、同一顺序；③ 的 stoppedBy 取自末条 answer 副作用。"""
    last = records[-1] if records else None
    answer = _effects(last, "answer")[0] if last and _effects(last, "answer") else None
    return [
        {"id": "no_tool_after_parse_error", "violations": no_tool_after_parse_error(records)},
        {"id": "exactly_one_final_answer", "violations": exactly_one_final_answer(records, terminal)},
        {"id": "terminal_states_distinct", "violations": terminal_states_distinct(records, answer.get("stoppedBy"), terminal) if answer else ["末条转移上没有 answer 副作用，无法判定终态"]},
        {"id": "effects_declared", "violations": effects_declared(records, rows)},
        {"id": "unknown_never_silent", "violations": ["#%s %s + %s 是 unknown 转移：%s" % (r.get("seq"), r.get("from"), r.get("event"), r.get("reason") or "") for r in unknown_rows(records)]},
    ]


# ---------- 跑一批文件 ----------

def judge(paths, contract_path):
    terminal, rows = load_contract(contract_path)
    files = []
    for p in paths:
        files.extend(list_trace_files(p))
    turns, unknown, statuses = [], [], {}
    transitions = 0
    for file in files:
        records = read_trace_file(file)
        transitions += len(records)
        for r in records:
            statuses[r.get("status")] = statuses.get(r.get("status"), 0) + 1
        for trace_id, turn in group_by_trace(records).items():
            checks = [c for c in check_trace_only_invariants(turn, terminal, rows) if c["violations"]]
            turns.append({
                "file": file,
                "trace_id": trace_id,
                "records": len(turn),
                "terminal": turn[-1].get("to") if turn else None,
                "verdict": "failed" if checks else "passed",
                "violations": checks,
            })
            for r in unknown_rows(turn):
                unknown.append({"file": file, "trace_id": trace_id, "seq": r.get("seq"), "from": r.get("from"), "event": r.get("event"), "reason": r.get("reason") or ""})
    failed = sum(1 for t in turns if t["verdict"] == "failed")
    summary = {
        "files": len(files),
        "turns": len(turns),
        "transitions": transitions,
        "passed": len(turns) - failed,
        "failed": failed,
        "unknown": statuses.get("unknown", 0),
    }
    return {"files": len(files), "contract": contract_path, "turns": turns, "unknown": unknown, "statuses": statuses, "summary": summary}


def render(report):
    lines = []
    for t in report["turns"]:
        lines.append("%s\t%s\t%s" % (t["trace_id"], t["verdict"], t["file"]))
        for c in t["violations"]:
            for msg in c["violations"]:
                lines.append("    ✗ [%s] %s" % (c["id"], msg))
    if report["unknown"]:
        lines.append("unknown（表上还没决定的转移，单独点名）:")
        for u in report["unknown"]:
            lines.append("    ? %s %s #%s %s + %s：%s" % (u["file"], u["trace_id"], u["seq"], u["from"], u["event"], u["reason"]))
    s = report["summary"]
    lines.append("files=%d turns=%d transitions=%d passed=%d failed=%d unknown=%d" % (s["files"], s["turns"], s["transitions"], s["passed"], s["failed"], s["unknown"]))
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="只凭 JSONL 转移记录跑 trace-only 不变量（① ② ③ ⑤ + unknown 点名）")
    ap.add_argument("paths", nargs="+", help="目录（递归收集 *.jsonl）或单个 .jsonl 文件")
    ap.add_argument("--contract", default=os.path.normpath(DEFAULT_CONTRACT), help="契约 JSON，默认 contracts/turn.contract.json")
    ap.add_argument("--json", action="store_true", help="输出结构化 JSON")
    args = ap.parse_args(argv)

    report = judge(args.paths, args.contract)
    if report["summary"]["turns"] == 0:
        print(json.dumps({"verdict": "not_observed", "files": report["files"], "summary": report["summary"]}, ensure_ascii=False) if args.json else "not_observed")
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.json else render(report))
    return 1 if report["summary"]["failed"] or report["summary"]["unknown"] else 0


if __name__ == "__main__":
    sys.exit(main())
