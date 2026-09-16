"""#19 R7 / Q5：复盘 trace 单独目录 trace/reviews/<user>-<date>.jsonl，trace_id = review/<user>/<date>，feature = "review"。
打点单位仍是「一次 interpret 一行」；effects 挂在报告该步结果的那条转移上（见 contracts/review_machine.py 顶部的声明）。
白名单落盘：只写计数、状态、会话 id；记忆值、亮点原文、brief 全文一律不进 trace。
evals/judge.py 与 tests/unit/test_live_evidence.py 只看 evals/live-trace/（turn）；本目录不在其下（NEXT_STEPS：证据工具按 feature 分表）。

ReviewEffect（dict，按 kind）：
    collect      {coverage, sessions, lines, unreadable}
    consolidate  {method, entries, highlights, warnings}
    memory       {written, conflicts}
    present      {kept, dropped, brief}
    deliver      {sessionId}
    journal      {status, attempts}
"""
from ..runtime.trace import FileTraceSink

REVIEW_TRACE_DIR = "trace/reviews"


def review_trace_sink(directory: str = REVIEW_TRACE_DIR, echo: bool = False) -> FileTraceSink:
    """复盘的文件 sink：`<dir>/<user>-<date>.jsonl`"""
    return FileTraceSink(directory, echo, lambda r: f"{r['userId']}-{r['date']}")
