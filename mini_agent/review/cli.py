"""#19 R8：复盘 CLI（⑨ 触发 = CLI 子命令，外部 cron 调它；⑩ 交付 = journal 落盘 + 打印 brief + 可选 --deliver）。
  python -m mini_agent.review.cli --user A [--date 2026-09-15] [--tz Asia/Shanghai] [--deliver <sessionId>] [--fake ok|no_chat|partial_read] [--data <dir>] [--json]
  - --date 缺省 = 任务时区的今天；--tz 缺省 Asia/Shanghai
  - 存储全是文件版：<data>/transcripts、<data>/memory、<data>/sessions、<data>/reviews；--data 缺省 data/（--fake 时缺省一个临时目录）
  - 真实模型：llm_config() + OpenAICompatibleLLM；--fake 不调模型，用脚本化 FakeLLM + 播种夹具跑出三态，无 key 也能跑
  - 退出码：ok / no_chat → 0；partial_read → 3（区分于失败）；配置错误 → 1；运行时异常 → 2
  - ⑪ 接收人只由 --deliver 决定：没给就谁也不追加；给了只追加到那一个会话（run_review 已守，这里不再多传任何接收人）
"""
import json
import os
import re
import sys
import tempfile
import traceback
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from ..config import llm_config
from ..llm.fake import FakeLLM
from ..memory.user_memory import FileUserMemoryStore
from ..session.store import FileSessionStore
from ..util import dumps, iso
from .consolidate import consolidate
from .journal import FileReviewJournalStore
from .run import ReviewDeps, run_review
from .transcript import FileTranscriptStore
from .window import today_in, yesterday_window

FAKE_SCENARIOS = ("ok", "no_chat", "partial_read")
VALUE_FLAGS = {"user", "date", "tz", "deliver", "fake", "data"}
BOOL_FLAGS = {"json"}
EXIT_BY_STATUS = {"ok": 0, "no_chat": 0, "partial_read": 3}


class ConfigError(Exception):
    """配置错误（参数 / key / 日期 / 时区）：退出码 1"""


def parse_args(argv: List[str], now: Optional[datetime] = None) -> Dict[str, Any]:
    raw: Dict[str, str] = {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if not a.startswith("--"):
            raise ConfigError(f"不认识的参数：{a}")
        name = a[2:]
        if name in BOOL_FLAGS:
            raw[name] = "true"
            i += 1
            continue
        if name not in VALUE_FLAGS:
            raise ConfigError(f"不认识的参数：{a}")
        v = argv[i + 1] if i + 1 < len(argv) else None
        if v is None or v.startswith("--"):
            raise ConfigError(f"{a} 需要一个值")
        raw[name] = v
        i += 2
    tz = raw.get("tz", "Asia/Shanghai")
    try:
        date = raw.get("date") or today_in(tz, now)
    except ValueError as e:
        raise ConfigError(f"--tz 不是合法时区：{tz}（{e}）")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        raise ConfigError(f"--date 必须是 YYYY-MM-DD：{date}")
    if raw.get("fake") is not None and raw["fake"] not in FAKE_SCENARIOS:
        raise ConfigError(f"--fake 只能是 {' | '.join(FAKE_SCENARIOS)}，收到：{raw['fake']}")
    return {"user": raw.get("user", "A"), "date": date, "tz": tz, "deliver": raw.get("deliver"), "fake": raw.get("fake"), "data": raw.get("data"), "json": raw.get("json") == "true"}


def fake_consolidator_llm() -> FakeLLM:
    """--fake 的脚本化模型：不看内容，只从整合器发来的转写里取第一个会话与第一个 user 轮号，回一段固定形状的 JSON。
    这样 source 一定指向真实存在的轮（否则 R4 会丢弃），也能对任意 --data 目录里的真实转写跑通。"""

    def reply(messages: List[dict]) -> str:
        user = next((m["content"] for m in messages if m["role"] == "user"), "")
        m_sid = re.search(r"^## 会话 (.+)$", user, re.M)
        m_turn = re.search(r"^\[第 (\d+) 轮 user\]", user, re.M)
        source = {"sessionId": m_sid.group(1) if m_sid else "unknown", "turn": int(m_turn.group(1)) if m_turn else 1}
        return json.dumps({
            "entries": [{"key": "fake_note", "value": "（假模型）昨天聊过一件要办的事", "kind": "inferred", "confidence": 0.6, "source": source}],
            "highlights": [{"text": "（假模型）把昨天说的那件事办完", "why_today": "due_today", "source": source}],
        }, ensure_ascii=False)

    return FakeLLM([reply])


def seed_fake_scenario(scenario: str, data_dir: str, user: str, date: str, tz: str) -> None:
    """--fake 播种：ok → 昨天一段可读转写；no_chat → 什么都不种；partial_read → 可读转写 + 一个只有坏 JSON 行的转写"""
    if scenario == "no_chat":
        return
    d = os.path.join(data_dir, "transcripts", user)
    os.makedirs(d, exist_ok=True)
    ts = iso(yesterday_window(date, tz)["start"] + timedelta(hours=10))
    lines = [
        {"ts": ts, "userId": user, "sessionId": "fake-ok", "turn": 1, "traceId": f"{user}/fake-ok/1", "role": "user", "content": "明天下午 3 点要交周报，记得提醒我"},
        {"ts": ts, "userId": user, "sessionId": "fake-ok", "turn": 1, "traceId": f"{user}/fake-ok/1", "role": "assistant", "content": "<final>记下了</final>"},
    ]
    with open(os.path.join(d, "fake-ok.jsonl"), "a", encoding="utf8") as f:
        f.write("\n".join(dumps(l) for l in lines) + "\n")
    if scenario == "partial_read":
        with open(os.path.join(d, "fake-bad.jsonl"), "a", encoding="utf8") as f:
            f.write(f'{{"ts": "{ts}", 坏掉的 JSON 行\n')


def format_human(j: dict) -> str:
    """人读格式：首行固定形状，然后 brief 全文（None 打「（今天没有需要提醒的事）」），然后 delivered_to"""
    out = [
        f"review {j['userId']} {j['date']} {j['tz']} → {j['status']}（attempts={j['attempts']}, coverage={j['coverage']}, entries_written={j['entries_written']}）",
        j["brief"]["text"] if j.get("brief") else "（今天没有需要提醒的事）",
        f"delivered_to: {', '.join(j['delivered_to']) if j['delivered_to'] else '（无）'}",
    ]
    if j.get("unreadable"):
        out.append(f"unreadable: {', '.join(j['unreadable'])}")
    return "\n".join(out) + "\n"


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    try:
        yesterday_window(args["date"], args["tz"])  # 日期 / 时区在这里就验，坏的 → ConfigError（不落 journal）
    except ValueError as e:
        raise ConfigError(str(e))
    data_dir = args["data"] or (tempfile.mkdtemp(prefix="mini-agent-review-fake-") if args["fake"] else "data")

    if args["fake"]:
        seed_fake_scenario(args["fake"], data_dir, args["user"], args["date"], args["tz"])
        llm: Any = fake_consolidator_llm()
        sys.stderr.write(f"review · --fake {args['fake']} · 不调模型 · data={data_dir}\n")
    else:
        try:
            cfg = llm_config()
        except RuntimeError as e:
            raise ConfigError(str(e))
        from ..llm.openai_compatible import OpenAICompatibleLLM

        llm = OpenAICompatibleLLM(**cfg)
        sys.stderr.write(f"review · model={cfg['model']} · data={data_dir}\n")

    r = run_review(
        ReviewDeps(
            transcripts=FileTranscriptStore(os.path.join(data_dir, "transcripts")),
            memory=FileUserMemoryStore(os.path.join(data_dir, "memory")),
            sessions=FileSessionStore(os.path.join(data_dir, "sessions")),
            journal=FileReviewJournalStore(os.path.join(data_dir, "reviews")),
            consolidate=lambda inp: consolidate(inp, llm),
        ),
        user_id=args["user"], date=args["date"], tz=args["tz"], deliver_to=args["deliver"],
    )
    journal = r["journal"]
    sys.stdout.write(dumps(journal, pretty=True) + "\n" if args["json"] else format_human(journal))
    for w in journal.get("warnings") or []:
        sys.stderr.write(f"warning: {w}\n")
    return EXIT_BY_STATUS[journal["status"]]


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except ConfigError as e:
        sys.stderr.write(f"配置错误：{e}\n")
        sys.exit(1)
    except Exception:  # noqa: BLE001 —— 运行时异常统一退出码 2，栈进 stderr
        sys.stderr.write(f"复盘失败：{traceback.format_exc()}\n")
        sys.exit(2)
