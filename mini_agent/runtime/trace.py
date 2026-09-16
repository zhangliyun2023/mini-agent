"""trace 的单位是「一次状态转移」（docs/product/SPEC-state-machines.md §2 D4）：
    {trace_id, seq, step, from, to, event, status, reason, reject_code, transition, effects}
llm / tool / compact / parse 调用作为 effects 挂在触发它们的那条转移上；
终态转移的 effects 里带一条 answer。本地全量落盘、不采样；API key 从不进 trace。

Effect（dict，按 kind 分）：
    compact          {before, after, method}
    memory_truncated {total, kept, limit}      记忆块超 memory_max_chars 被截，挂在轮首第一条转移上
    llm              {request_id, step, model, mode, messages, attempts, tries:[{n, errorClass, waitMs}], promptTokens?, completionTokens?, durationMs, outputPreview, error?}
    parse            {step, toolCalls, hasFinal, errors, warnings}
    tool             {request_id, step, name, args, ok, durationMs, resultPreview}
    answer           {stoppedBy, answer, totalMs}
"""
import json
import os
import re
import secrets
import sys
from typing import Any, Callable, Dict, List, Optional

from ..util import append_jsonl, encode_component

TransitionRecord = Dict[str, Any]


def format_transition(r: dict) -> str:
    """答案卷与 trace 序列都用这个格式：行 id（unknown 没有行，退回 `from --EVENT--> to`），非 allowed 追加 ` [status]`"""
    head = r.get("transition") or f"{r['from']} --{r['event']}--> {r['to']}"
    return head if r["status"] == "allowed" else f"{head} [{r['status']}]"


class MemoryTraceSink:
    def __init__(self) -> None:
        self.records: List[TransitionRecord] = []

    def write(self, r: TransitionRecord) -> None:
        self.records.append(r)

    def sequence(self, trace_id: Optional[str] = None) -> List[str]:
        """转移序列（可选按 trace_id 过滤）"""
        return [format_transition(r) for r in self.records if not trace_id or r["trace_id"] == trace_id]

    def effects(self, kind: str) -> List[dict]:
        """拍平所有转移上的某类副作用"""
        return [e for r in self.records for e in r["effects"] if e.get("kind") == kind]


class FileTraceSink:
    """文件 sink：一个目录、按 `stem(record)` 分文件（turn 默认按 sessionId；review 用 `<user>-<date>`，目录 trace/reviews/，见 review/trace.py）"""

    def __init__(self, directory: str, echo: bool = False, stem: Optional[Callable[[dict], str]] = None):
        self.dir = directory
        self.echo = echo
        self.stem = stem or (lambda r: str(r["sessionId"]))

    def write(self, r: TransitionRecord) -> None:
        append_jsonl(os.path.join(self.dir, f"{encode_component(self.stem(r))}.jsonl"), r)
        if self.echo:
            fx = " · ".join(x for x in (describe_effect(e) for e in r["effects"]) if x)
            sys.stderr.write(f"  ⎿ #{r['seq']} {format_transition(r)}{' · ' + fx if fx else ''}\n")


def describe_effect(e: dict) -> str:
    kind = e.get("kind")
    if kind == "llm":
        attempts = f" ({e['attempts']} 次)" if e.get("attempts", 1) > 1 else ""
        return f"llm#{e['step']} {e['durationMs']}ms{attempts} {e.get('error') or e.get('outputPreview', '')}"
    if kind == "tool":
        return f"tool {e['name']}({json.dumps(e['args'], ensure_ascii=False, separators=(',', ':'))}) {'ok' if e['ok'] else 'FAIL'} {e['durationMs']}ms → {e['resultPreview']}"
    if kind == "compact":
        return f"compact {e['before']}→{e['after']} msgs ({e['method']})"
    if kind == "memory_truncated":
        return f"memory_truncated {e['kept']}/{e['total']} 条 (limit {e['limit']} chars)"
    if kind == "parse":
        return f"parse {' | '.join([*e['errors'], *e['warnings']])}" if e["errors"] or e["warnings"] else ""
    if kind == "answer":
        return f"answer({e['stoppedBy']}) {e['totalMs']}ms"
    return str(kind)


_WS = re.compile(r"\s+")


def preview(s: str, n: int = 120) -> str:
    return _WS.sub(" ", s)[:n]


def new_request_id() -> str:
    """一次外部调用（模型 / 工具）一个 id：`r-` + 短随机；runtime 生成，只用来在 trace 里把 effect 与调用对上"""
    return f"r-{secrets.token_hex(6)}"
