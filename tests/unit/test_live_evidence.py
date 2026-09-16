"""独立 oracle 触到真实模型证据：仓库里提交的 evals/live-trace/**/*.jsonl 是真实模型跑出来的转移记录（TS 版 runtime 跑出，
两个实现共用同一份 JSON 契约），这里离线逐轮过「只凭 trace 就能判」的不变量（① ② ③ ⑤ + unknown 点名）。
这不是「真实模型已验证」——只证明已提交的证据与表、与不变量一致；live 是否重跑见 docs/TEST_REPORT.md §3。"""
import re

from mini_agent.machine.evidence import check_trace_files, list_trace_files, read_trace_file, summarize
from mini_agent.machine.invariants import check_trace_only_invariants

files = list_trace_files("evals/live-trace")


def test_evidence_files_are_valid_transition_records():
    assert files
    for f in files:
        rows = read_trace_file(f)
        assert rows, f
        for r in rows:
            assert isinstance(r["trace_id"], str) and r["feature"] == "turn" and isinstance(r["transition"], str), f
            for k in ("from", "to", "event", "status"):
                assert isinstance(r[k], str)


def test_every_turn_passes_trace_only_invariants():
    report = check_trace_files(files)
    assert report.turns
    assert [f"{t.file} {t.trace_id}" for t in report.failed] == [], summarize(report)
    assert report.statuses.get("unknown", 0) == 0
    # LLM_OK 是 noop 行：真实 trace 里必然有 noop 记录，「无 unknown」不是「全 allowed」
    assert report.statuses.get("noop", 0) > 0
    assert [t for t in report.turns if t.terminal not in ("done", "max_steps", "error")] == []


def test_offline_check_goes_red_on_tampering():
    report = check_trace_files(files)
    t = report.turns[0]
    rows = [r for r in read_trace_file(t.file) if r["trace_id"] == t.trace_id]
    rows[0]["effects"].append({"kind": "tool", "request_id": "r-tampered", "step": 1, "name": "x", "args": {}, "ok": True, "durationMs": 0, "resultPreview": ""})
    v = [x for x in check_trace_only_invariants(rows) if x["violations"]]
    ids = [x["id"] for x in v]
    assert "effects_declared" in ids and "no_tool_after_parse_error" in ids
    t.violations = v
    report.failed = [x for x in report.turns if x.violations]
    assert re.search(rf'✗ {re.escape(t.file)} {re.escape(t.trace_id)} \[effects_declared\] #1 t-llm-ok 上出现了表未声明的副作用 "tool"', summarize(report))
