"""#19 R6 + R7：复盘编排，由 contracts/review_machine.py 驱动（闸）。
  每一步先 interpret：allowed 才往下走，noop 停留，未列 (状态, 事件) = unknown → 不执行后续副作用、记一条 status=unknown 的 trace、
  以 failed_partial 收尾（journal 记 partial_read 并写明未建模转移；unknown_transition="throw" 时再抛出，测试用）。
  一次 interpret 一行写到 trace/reviews/<user>-<date>.jsonl（deps.trace，trace_id = review/<user>/<date>）；不给 trace 就不落盘。
  ③ 幂等键 userId + date：journal 已有同键 → REPLAYED，只把 attempts + 1 存回，不重跑整合、不重写记忆、不重发；返回原 journal 并标 replayed。
  ⑥ 三态：coverage none → skipped_no_chat（不调整合器、不写记忆）；partial → 照常整合但终态 failed_partial（journal partial_read，写明 unreadable）；full → delivered（ok）。
  ⑪ 昨天对话里的文字只是材料：接收人只由 opts.deliver_to 决定，整合器 / 转写里出现的「发给 B」不参与任何决定。
  终态 ↔ journal.status 由 TERMINAL_STATUS 一一对应（不变量 terminal_matches_journal_status）。
"""
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

from contracts.review_machine import TERMINAL_STATUS, ReviewFacts, review_machine
from ..machine.interpreter import Machine, interpret
from ..util import iso, now_utc
from .collect import collect_yesterday
from .present import present
from .window import yesterday_window

ConsolidateFn = Callable[[Dict[str, Any]], Dict[str, Any]]


@dataclass
class ReviewDeps:
    transcripts: Any
    memory: Any
    sessions: Any
    journal: Any
    consolidate: ConsolidateFn
    now: Optional[Callable[[], Any]] = None
    trace: Any = None  # 复盘 trace（trace/reviews/<user>-<date>.jsonl）；不给就不落盘
    machine: Optional[Machine] = None  # 默认 contracts/review_machine.py；测试用残缺表验证闸拦得住
    unknown_transition: str = "fail"  # 未列转移：默认 "fail"（记 trace、journal partial_read、正常返回）；"throw" 在收尾之后抛出（测试模式）


class _Reader:
    """把 R1 的 TranscriptStore 适配成 R2 要的 TranscriptReader：
    FileTranscriptStore.read 对缺失文件返回 []（= 没聊），对坏行抛错 → 这里接成 None（= 读不出，计入 partial_read）。"""

    def __init__(self, store: Any):
        self.store = store

    def list(self, user_id: str) -> List[str]:
        return self.store.list(user_id)

    def read(self, user_id: str, session_id: str) -> Optional[List[dict]]:
        try:
            return self.store.read(user_id, session_id)
        except Exception:  # noqa: BLE001 —— 坏 JSON 行等一切读失败都算「读不出」
            return None


def transcript_reader(store: Any) -> _Reader:
    return _Reader(store)


def run_review(deps: ReviewDeps, user_id: str, date: str, tz: str, deliver_to: Optional[str] = None) -> Dict[str, Any]:
    """返回 {journal, replayed}；replayed=True 表示同键已有 journal，本次只递增 attempts，没有重跑"""
    now = deps.now or now_utc
    machine = deps.machine or review_machine
    trace_id = f"review/{user_id}/{date}"

    existing = deps.journal.get(user_id, date)
    attempt = (existing["attempts"] if existing else 0) + 1
    st: Dict[str, Any] = {"facts": ReviewFacts(existing["status"] if existing else None, None, 0), "state": machine.initial, "seq": 0, "journal": None, "replayed": False}
    # 各步的产物：只在对应转移 allowed 之后才会被填上
    collected: Optional[dict] = None
    consolidation: Optional[dict] = None
    presented: Optional[dict] = None
    counters = {"entries_written": 0, "conflicts": 0}
    delivered_to: List[str] = []

    def finish(to: str, unknown_reason: Optional[str] = None) -> dict:
        """终态收尾：journal.status 由终态定（TERMINAL_STATUS）；重跑只把 attempts + 1 存回；unknown 收尾把未建模转移写进 warnings"""
        updated_at = iso(now())
        extra = [unknown_reason] if unknown_reason else []
        if existing:
            st["replayed"] = True
            warnings = [*(existing.get("warnings") or []), *extra]
            return {**existing, "attempts": attempt, **({"warnings": warnings} if warnings else {}), "updatedAt": updated_at}
        status = TERMINAL_STATUS.get(to, "partial_read")
        warnings = [*(presented["warnings"] if presented else []), *extra]
        j: Dict[str, Any] = {"userId": user_id, "date": date, "tz": tz, "attempts": attempt, "coverage": collected["coverage"] if collected else "none"}
        if collected and collected["unreadable"]:
            j["unreadable"] = list(collected["unreadable"])
        j.update({"status": status, "entries_written": counters["entries_written"], "brief": presented["brief"] if presented else None, "delivered_to": delivered_to})
        if consolidation:
            j["method"] = consolidation["method"]
        if warnings:
            j["warnings"] = warnings
        j["updatedAt"] = updated_at
        return j

    def transition(event: str, effects: List[dict]) -> str:
        """闸：先 interpret，再决定要不要收尾；一次 interpret 一行 trace。返回新状态。"""
        state = st["state"]
        t = interpret(machine, state, event, st["facts"])
        to = "failed_partial" if t.status == "unknown" else t.to
        all_effects = list(effects)
        if machine.is_terminal(to):
            st["journal"] = finish(to, f"未建模的状态转移：{state} + {event}（{t.reason}）" if t.status == "unknown" else None)
            deps.journal.save(st["journal"])
            all_effects.append({"kind": "journal", "status": st["journal"]["status"], "attempts": st["journal"]["attempts"]})
        st["seq"] += 1
        if deps.trace is not None:
            deps.trace.write({"ts": iso(now()), "trace_id": trace_id, "feature": "review", "userId": user_id, "date": date, "attempt": attempt, "seq": st["seq"], "from": state, "to": to, "event": event, "status": t.status, "reason": t.reason, "reject_code": t.reject_code, "transition": t.row.id if t.row else None, "effects": all_effects})
        if t.status == "unknown" and deps.unknown_transition == "throw":
            raise RuntimeError(f"未建模的状态转移：{state} + {event}（{t.reason}）")
        st["state"] = to
        return to

    while not machine.is_terminal(st["state"]):
        state = st["state"]
        if state == "scheduled":
            # ③ 幂等：同键已有 → REPLAYED，直接落原终态，只记一次尝试
            transition("REPLAYED" if existing else "START", [])
            continue
        if state == "collecting":
            collected = collect_yesterday(transcript_reader(deps.transcripts), user_id, yesterday_window(date, tz))
            st["facts"] = ReviewFacts(st["facts"].existing, collected["coverage"], len(collected["sessions"]))
            lines = sum(len(s["lines"]) for s in collected["sessions"])
            transition("COLLECTED", [{"kind": "collect", "coverage": collected["coverage"], "sessions": len(collected["sessions"]), "lines": lines, "unreadable": list(collected["unreadable"])}])
            continue
        if state == "consolidating":
            # ① 整合 → entries 写回记忆（同 key 异值走 conflict，不覆盖）
            assert collected is not None
            consolidation = deps.consolidate({"userId": user_id, "date": date, "sessions": collected["sessions"]})
            for e in consolidation["entries"]:
                written = deps.memory.upsert(user_id, e)
                counters["entries_written"] += 1
                if written["status"] == "conflict":
                    counters["conflicts"] += 1
            transition("CONSOLIDATED", [
                {"kind": "consolidate", "method": consolidation["method"], "entries": len(consolidation["entries"]), "highlights": len(consolidation["highlights"]), "warnings": len(consolidation["warnings"])},
                {"kind": "memory", "written": counters["entries_written"], "conflicts": counters["conflicts"]},
            ])
            continue
        if state == "presenting":
            # ⑤ 呈现门槛 → brief（可为 None）；PRESENTED 是 noop，停留等交付
            assert collected is not None and consolidation is not None
            presented = present(consolidation, [l for s in collected["sessions"] for l in s["lines"]])
            brief = presented["brief"]
            if transition("PRESENTED", [{"kind": "present", "kept": len(brief["highlights"]) if brief else 0, "dropped": len(presented["dropped"]), "brief": brief is not None}]) != "presenting":
                continue
            # ⑩ 交付：接收人只由 opts.deliver_to 决定（⑪）
            effects: List[dict] = []
            if deliver_to and brief:
                target = deps.sessions.get(user_id, deliver_to)
                target["history"].append({"role": "assistant", "content": brief["text"], "kind": "review_brief"})
                deps.sessions.save(target)
                delivered_to.append(deliver_to)
                effects.append({"kind": "deliver", "sessionId": deliver_to})
            transition("DELIVERED", effects)
            continue
        raise RuntimeError(f"run_review 不认识状态 {state}")
    return {"journal": st["journal"], "replayed": st["replayed"]}
