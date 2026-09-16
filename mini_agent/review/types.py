"""#19 复盘（记忆整合）的共享类型——并行开工的契约，改动先改这里（原文来自 issue #19 评论）。全部是 dict，键名与 JSON 一致。

Source        {sessionId: str, turn: int}
MemoryEntry   {key, value, kind: stated|inferred, confidence, source: Source, date, status: active|conflict, conflictWith?}
Highlight     {text, why_today: due_today|unfinished|planned_today, source: Source}
Brief         {highlights: [Highlight], text} | None
Consolidation {entries: [MemoryEntry], highlights: [Highlight], method: llm|rule, warnings: [str]}
Coverage      full | partial | none
ReviewJournal {userId, date, tz, status: ok|no_chat|partial_read, attempts, coverage, entries_written, brief, delivered_to: [str], method?, updatedAt, unreadable?, warnings?}
              （R6 只增了两个可选字段：⑥ partial_read 要写明覆盖范围 → unreadable = 读不出的会话 id；warnings = 整合 + 呈现门槛的警告）
TranscriptLine 见 transcript.py

TranscriptReader（R2 复盘取数只依赖这个最小读接口）：list(user_id) -> [session_id]；read(user_id, session_id) -> [TranscriptLine] | None（None = 转写文件缺失或读不出，计入 partial_read）
"""
from typing import Any, Dict, List, Optional, Protocol

Source = Dict[str, Any]
MemoryEntry = Dict[str, Any]
Highlight = Dict[str, Any]
Brief = Optional[Dict[str, Any]]
Consolidation = Dict[str, Any]
ReviewJournal = Dict[str, Any]
TranscriptLine = Dict[str, Any]

KINDS = ("stated", "inferred")
WHY_TODAY = ("due_today", "unfinished", "planned_today")


class TranscriptReader(Protocol):
    def list(self, user_id: str) -> List[str]: ...
    def read(self, user_id: str, session_id: str) -> Optional[List[TranscriptLine]]: ...
