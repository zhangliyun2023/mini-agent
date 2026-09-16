"""真实 LLM 集成测试：LIVE=1 python -m pytest tests/live（make test-live）。trace 写到 evals/live-trace/，提交进仓库当运行证据。
断言只打在「用户可见结果」上（答案里有没有正确数字 / 清单内容），不断模型的措辞。"""
import os
import re
import sys
from datetime import datetime, timezone

import pytest

from mini_agent.config import llm_config
from mini_agent.machine.evidence import check_trace_files, list_trace_files, summarize
from mini_agent.memory.user_memory import MemoryUserMemoryStore
from mini_agent.runtime.agent import Agent, default_tools
from mini_agent.runtime.trace import FileTraceSink

try:
    CFG = llm_config()
except RuntimeError:
    CFG = None
STAMP = datetime.now(timezone.utc).strftime("%Y-%m-%d-%H-%M") + "-py"
skip = pytest.mark.skipif(not CFG or not os.environ.get("LIVE"), reason="需要 .env 里的 key 且 LIVE=1")


def build(native=False):
    from mini_agent.llm.openai_compatible import OpenAICompatibleLLM

    memory = MemoryUserMemoryStore()
    tools = default_tools(memory)
    llm = OpenAICompatibleLLM(**CFG, native_tools=tools.specs() if native else None)
    return Agent(llm=llm, tools=tools, memory=memory, trace=FileTraceSink(f"evals/live-trace/{STAMP}{'-native' if native else ''}"))


@skip
def test_calculator_used_for_precise_math():
    r = build().run(user_id="live", session_id="calc", input="帮我算一下 (137*29 + 1234) / 7，保留两位小数")
    assert r["stoppedBy"] == "final"
    assert any(s["kind"] == "tool" and s["detail"].startswith("calculator") for s in r["steps"])
    assert re.search(r"743\.86", r["answer"].replace(",", ""))


@skip
def test_search_then_pure_followup():
    agent = build()
    r1 = agent.run(user_id="live", session_id="wx", input="上海今天天气怎么样？")
    assert re.search("多云|晴|24|30", r1["answer"])
    r2 = agent.run(user_id="live", session_id="wx", input="那我要带伞吗？一句话回答")
    assert r2["stoppedBy"] == "final" and r2["answer"]


@skip
def test_followup_with_tool_and_window_isolation():
    agent = build()
    agent.run(user_id="A", session_id="w1", input="帮我记两条待办：买牛奶、写周报")
    r = agent.run(user_id="A", session_id="w1", input="第一条做完了，帮我标一下，然后把清单给我")
    assert "牛奶" in r["answer"] and "周报" in r["answer"]
    other = agent.run(user_id="A", session_id="w2", input="我的待办清单里有什么？")
    assert "牛奶" not in other["answer"]


@skip
def test_remember_then_new_session():
    agent = build()
    agent.run(user_id="M", session_id="s1", input="记住：我叫小张，常住上海。")
    assert re.search("上海|小张", " ".join(agent.memory.load("M").values()))
    r = agent.run(user_id="M", session_id="s2", input="我住哪个城市？只回答城市名")
    assert "上海" in r["answer"]


@skip
def test_native_mode_tool_call():
    r = build(True).run(user_id="live", session_id="native", input="算 99*99")
    assert "9801" in r["answer"]


@skip
def test_live_trace_passes_invariants():
    """收尾：本次跑出来的 trace 逐轮过「只凭 trace 就能判」的不变量（① ② ③ ⑤ + unknown 点名）。"""
    files = [*list_trace_files(f"evals/live-trace/{STAMP}"), *list_trace_files(f"evals/live-trace/{STAMP}-native")]
    assert files
    report = check_trace_files(files)
    sys.stderr.write(f"live trace 不变量：{summarize(report)}\n")
    assert not report.failed, summarize(report)
