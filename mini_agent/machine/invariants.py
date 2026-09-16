"""五条 P0 不变量的独立 oracle（docs/product/SPEC-state-machines.md §2 D3 四条 + ⑤ 副作用对账）。
输入只有「用户可见的证据」：一轮的 trace 记录、RunResult、盘上历史末条；不碰 runtime 内部。
每个函数返回违反项列表，空 = 通过。测试里每条都一红一绿：真实运行过 oracle，篡改后的证据被 oracle 点名。

TurnEvidence（dict）：{records: [TransitionRecord], result: {answer, stoppedBy}, lastHistoryMessage?: ChatMessage, history?: [ChatMessage]}
    history 给了就取「最近一轮的末条」（跳过复盘交付追加的 kind: "review_brief"，#19 Q8），优先于 lastHistoryMessage
"""
import re
from typing import Any, Dict, List, Optional

from contracts.turn_machine import TERMINAL_STOPPED_BY, TURN_TERMINAL, turn_machine
from .check import unknown_rows
from .interpreter import Machine

_FINAL = re.compile(r"^<final>(.*)</final>$", re.S)


def last_turn_message(history: List[dict]) -> Optional[dict]:
    """「最近一轮的末条」：从后往前跳过 review_brief 之类非本轮产物的标记消息；没有则 None"""
    for m in reversed(history):
        if m.get("kind") != "review_brief":
            return m
    return None


def _is_terminal(s: str) -> bool:
    return s in TURN_TERMINAL


def _answer_effects(r: dict) -> List[dict]:
    return [e for e in r["effects"] if e.get("kind") == "answer"]


def no_tool_after_parse_error(records: List[dict]) -> List[str]:
    """① 无工具执行于解析失败之后"""
    v: List[str] = []
    for i, r in enumerate(records):
        tools = [e for e in r["effects"] if e.get("kind") == "tool"]
        if r["event"] == "PARSED_ERROR" and tools:
            v.append(f"#{r['seq']} PARSED_ERROR 转移上挂了 {len(tools)} 个 tool 副作用")
        if not tools:
            continue
        if r["event"] != "TOOLS_DONE" or r["from"] != "executing_tools":
            v.append(f"#{r['seq']} tool 副作用出现在 {r['from']} + {r['event']} 上，只允许出现在 executing_tools + TOOLS_DONE")
        prev = records[i - 1] if i > 0 else None
        if not prev or prev["event"] != "PARSED_TOOL_CALLS" or prev["status"] != "allowed" or prev["to"] != "executing_tools":
            actual = f"{prev['event']} [{prev['status']}]" if prev else "无"
            v.append(f"#{r['seq']} 工具执行前一条不是 allowed 的 PARSED_TOOL_CALLS → executing_tools（实际：{actual}）")
    return v


def exactly_one_final_answer(records: List[dict], turn_history: Optional[List[dict]] = None) -> List[str]:
    """② 一轮恰一个最终答案"""
    v: List[str] = []
    terminals = [r for r in records if _is_terminal(r["to"])]
    if len(terminals) != 1:
        v.append(f"终态转移应恰 1 条，实际 {len(terminals)} 条")
    if records and not _is_terminal(records[-1]["to"]):
        v.append(f"末条转移 {records[-1]['to']} 不是终态")
    answers = [a for r in records for a in _answer_effects(r)]
    if len(answers) != 1:
        v.append(f"answer 副作用应恰 1 个，实际 {len(answers)} 个")
    if len(answers) == 1:
        holder = next(r for r in records if _answer_effects(r))
        if not _is_terminal(holder["to"]):
            v.append("answer 副作用挂在非终态转移上")
    if turn_history is not None:
        finals = [m for m in turn_history if m["role"] == "assistant" and _FINAL.match(m["content"].strip())]
        if len(finals) != 1:
            v.append(f"本轮历史里 <final> 消息应恰 1 条，实际 {len(finals)} 条")
    return v


def terminal_states_distinct(records: List[dict], stopped_by: str) -> List[str]:
    """③ 三终态互斥可区分"""
    v: List[str] = []
    terminals = [r for r in records if _is_terminal(r["to"])]
    if len(terminals) != 1:
        return [f"终态转移应恰 1 条，实际 {len(terminals)} 条：{', '.join(t['to'] for t in terminals)}"]
    to = terminals[0]["to"]
    if TERMINAL_STOPPED_BY.get(to) != stopped_by:
        v.append(f"终态 {to} 应对应 stoppedBy={TERMINAL_STOPPED_BY.get(to)}，实际 {stopped_by}")
    answers = _answer_effects(terminals[0])
    if answers and answers[0].get("stoppedBy") != stopped_by:
        v.append(f"answer 副作用的 stoppedBy={answers[0].get('stoppedBy')} 与结果 {stopped_by} 不一致")
    return v


def answer_aligned(ev: Dict[str, Any]) -> List[str]:
    """④ 答案 == 盘上历史末条 == trace 末次决策"""
    v: List[str] = []
    records = ev["records"]
    result = ev["result"]
    last_record = records[-1] if records else None
    answers = _answer_effects(last_record) if last_record else []
    if not answers:
        v.append("trace 末条转移上没有 answer 副作用")
    elif answers[0].get("answer") != result["answer"]:
        v.append(f"trace 末次决策的答案与返回值不一致：trace=「{str(answers[0].get('answer'))[:60]}」 result=「{result['answer'][:60]}」")
    last = last_turn_message(ev["history"]) if ev.get("history") is not None else ev.get("lastHistoryMessage")
    if not last:
        v.append("没有盘上历史末条")
    else:
        m = _FINAL.match(last["content"].strip())
        if last["role"] != "assistant" or not m:
            v.append(f"历史末条不是 assistant 的 <final>：{last['role']} 「{last['content'][:60]}」")
        elif m.group(1) != result["answer"]:
            v.append(f"历史末条 <final> 与返回值不一致：history=「{m.group(1)[:60]}」 result=「{result['answer'][:60]}」")
    return v


def effects_declared(records: List[dict], machine: Machine = turn_machine) -> List[str]:
    """⑤ 副作用对账：每条转移记录上出现的 effects[].kind 必须 ⊆ 记录 `transition` 行 id 在表里命中行声明的 `effects`。
    表上没声明的副作用 = unmodeled（标准 §7「运行时元素清单与契约清单不一致」在本仓的对应物）；
    compact 只允许出现在轮首第一条转移（seq 1）上。status=unknown 的记录没有行 id，由 unknown 点名单独列，不在这里判。
    对 noop / blocked 记录同样成立：LLM_OK 行声明了 llm，rejected 的 PARSED_ERROR 行声明了 parse。"""
    v: List[str] = []
    by_id = {r.id: r for r in machine.rows}
    for r in records:
        if r["status"] == "unknown":
            continue
        rw = by_id.get(r["transition"]) if r.get("transition") else None
        if rw is None:
            v.append(f'#{r["seq"]} 行 id "{r.get("transition")}" 在表里不存在（{r["from"]} --{r["event"]}--> {r["to"]} [{r["status"]}]）')
            continue
        declared = rw.effects or []
        for e in r["effects"]:
            if e["kind"] not in declared:
                v.append(f'#{r["seq"]} {rw.id} 上出现了表未声明的副作用 "{e["kind"]}"（该行声明：{", ".join(declared) or "无"}）')
            elif e["kind"] == "compact" and r["seq"] != 1:
                v.append(f"#{r['seq']} {rw.id} 上出现了 compact，但 compact 只允许挂在轮首第一条转移上")
    return v


TURN_INVARIANT_IDS = ["no_tool_after_parse_error", "exactly_one_final_answer", "terminal_states_distinct", "answer_alignment", "effects_declared"]


def check_trace_only_invariants(records: List[dict]) -> List[Dict[str, Any]]:
    """只凭 trace 记录就能判的不变量（① ② ③ ⑤ + unknown 点名）——用来过真实模型跑出来的 JSONL（evidence.py），
    那里没有 RunResult 与盘上历史，所以 ④ 不在此列。③ 的 stoppedBy 取自末条 answer 副作用。"""
    last = records[-1] if records else None
    answers = _answer_effects(last) if last else []
    return [
        {"id": "no_tool_after_parse_error", "violations": no_tool_after_parse_error(records)},
        {"id": "exactly_one_final_answer", "violations": exactly_one_final_answer(records)},
        {"id": "terminal_states_distinct", "violations": terminal_states_distinct(records, answers[0]["stoppedBy"]) if answers else ["末条转移上没有 answer 副作用，无法判定终态"]},
        {"id": "effects_declared", "violations": effects_declared(records)},
        {"id": "unknown_never_silent", "violations": [f"#{r['seq']} {r['from']} + {r['event']} 是 unknown 转移：{r.get('reason') or ''}" for r in unknown_rows(records)]},
    ]


def check_turn_invariants(ev: Dict[str, Any]) -> List[Dict[str, Any]]:
    """一次跑全部五条；返回每条的违反项"""
    checks = {
        "no_tool_after_parse_error": lambda: no_tool_after_parse_error(ev["records"]),
        "exactly_one_final_answer": lambda: exactly_one_final_answer(ev["records"]),
        "terminal_states_distinct": lambda: terminal_states_distinct(ev["records"], ev["result"]["stoppedBy"]),
        "answer_alignment": lambda: answer_aligned(ev),
        "effects_declared": lambda: effects_declared(ev["records"]),
    }
    return [{"id": k, "violations": f()} for k, f in checks.items()]
