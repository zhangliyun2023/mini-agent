"""#13：evals/judge.py 是 machine/evidence.py + invariants.py（① ② ③ ⑤ + unknown 点名）的独立实现，只用标准库。
用户可见契约 = 进程退出码 + stdout 文本；这里用子进程真跑，不 import 任何判据来「代跑」。
与进程内 oracle 对账：对同一批 evals/live-trace/ 文件，轮数 / 转移数 / 违反数 / unknown 数必须与 check_trace_files 一致。"""
import json
import os
import re
import subprocess
import sys

from mini_agent.machine.evidence import check_trace_files, list_trace_files, read_trace_file
from mini_agent.machine.invariants import check_trace_only_invariants

LIVE = "evals/live-trace"


def judge(*args):
    r = subprocess.run([sys.executable, "evals/judge.py", *args], capture_output=True, text=True, encoding="utf8")
    return {"code": r.returncode, "out": r.stdout or "", "err": r.stderr or ""}


def test_committed_live_trace_all_passed_and_matches_in_process():
    ts = check_trace_files(list_trace_files(LIVE))
    assert ts.turns
    plain = judge(LIVE)
    assert plain["code"] == 0, plain["out"] + plain["err"]
    lines = plain["out"].strip().split("\n")
    turn_lines = [l for l in lines if re.search(r"\t(passed|failed)\t", l)]
    assert len(turn_lines) == len(ts.turns)
    assert [l for l in turn_lines if "\tpassed\t" not in l] == []
    assert lines[-1] == f"files={ts.files} turns={len(ts.turns)} transitions={ts.records} passed={len(ts.turns)} failed=0 unknown={ts.statuses.get('unknown', 0)}"
    j = judge(LIVE, "--json")
    assert j["code"] == 0, j["out"] + j["err"]
    report = json.loads(j["out"])
    assert report["summary"] == {"files": ts.files, "turns": len(ts.turns), "transitions": ts.records, "passed": len(ts.turns), "failed": 0, "unknown": ts.statuses.get("unknown", 0)}
    assert report["statuses"] == ts.statuses
    assert report["unknown"] == []
    assert [[t["file"], t["trace_id"], t["records"], t["terminal"]] for t in report["turns"]] == [[t.file, t.trace_id, t.records, t.terminal] for t in ts.turns]


def test_tampered_record_fails_with_same_ids(tmp):
    src = next(f for f in list_trace_files(LIVE) if any(r["event"] == "TOOLS_DONE" and any(e["kind"] == "tool" for e in r["effects"]) for r in read_trace_file(f)))
    rows = read_trace_file(src)
    i = next(k for k, r in enumerate(rows) if r["event"] == "TOOLS_DONE" and any(e["kind"] == "tool" for e in r["effects"]))
    tools_done, prev = rows[i], rows[i - 1]
    assert prev["event"] == "PARSED_TOOL_CALLS"
    tools = [e for e in tools_done["effects"] if e["kind"] == "tool"]
    tampered = {**prev, "event": "PARSED_ERROR", "to": "deciding", "status": "blocked", "transition": "t-parse-error", "reject_code": "PARSE_ERROR", "effects": [*prev["effects"], *tools]}
    stripped = {**tools_done, "effects": [e for e in tools_done["effects"] if e["kind"] != "tool"]}
    mutated = [tampered if k == i - 1 else stripped if k == i else r for k, r in enumerate(rows)]
    with open(os.path.join(tmp, "tampered.jsonl"), "w", encoding="utf8") as f:
        f.write("\n".join(json.dumps(r, ensure_ascii=False) for r in mutated) + "\n")
    r = judge(tmp)
    assert r["code"] == 1, r["out"] + r["err"]
    assert f"{tampered['trace_id']}\tfailed\t" in r["out"]
    assert f"[no_tool_after_parse_error] #{tampered['seq']} PARSED_ERROR 转移上挂了 {len(tools)} 个 tool 副作用" in r["out"]
    assert f'[effects_declared] #{tampered["seq"]} t-parse-error 上出现了表未声明的副作用 "tool"' in r["out"]
    others = {x["trace_id"] for x in mutated} - {tampered["trace_id"]}
    for tid in others:
        assert f"{tid}\tpassed\t" in r["out"]
    assert re.match(rf"^files=1 turns={len(others) + 1} transitions={len(mutated)} passed={len(others)} failed=1 unknown=0$", r["out"].strip().split("\n")[-1])
    ids = sorted(x["id"] for x in check_trace_only_invariants([x for x in mutated if x["trace_id"] == tampered["trace_id"]]) if x["violations"])
    j = json.loads(judge(tmp, "--json")["out"])
    turn = next(t for t in j["turns"] if t["trace_id"] == tampered["trace_id"])
    assert turn["verdict"] == "failed"
    assert sorted(v["id"] for v in turn["violations"]) == ids
    assert ids == ["effects_declared", "no_tool_after_parse_error"]


def test_empty_dir_not_observed(tmp):
    os.makedirs(os.path.join(tmp, "sub"))
    with open(os.path.join(tmp, "sub", "notes.txt"), "w") as f:
        f.write("nothing here\n")
    r = judge(tmp)
    assert r["code"] == 2, r["out"] + r["err"]
    assert r["out"].strip() == "not_observed"


def test_contract_is_the_source_of_truth(tmp):
    contract = json.load(open("contracts/turn.contract.json", encoding="utf8"))
    for rw in contract["rows"]:
        if rw["id"] == "t-tools-done":
            rw["effects"] = []
    cpath = os.path.join(tmp, "turn.contract.json")
    with open(cpath, "w", encoding="utf8") as f:
        json.dump(contract, f, ensure_ascii=False)
    r = judge(LIVE, "--contract", cpath, "--json")
    assert r["code"] == 1, r["out"] + r["err"]
    j = json.loads(r["out"])
    ts = check_trace_files(list_trace_files(LIVE))
    with_tools = len([t for t in ts.turns if any(x["trace_id"] == t.trace_id and x["transition"] == "t-tools-done" and any(e["kind"] == "tool" for e in x["effects"]) for x in read_trace_file(t.file))])
    assert with_tools > 0
    assert j["summary"]["failed"] == with_tools
    for t in [t for t in j["turns"] if t["verdict"] == "failed"]:
        assert [v["id"] for v in t["violations"]] == ["effects_declared"]
