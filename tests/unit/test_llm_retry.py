"""#11：模型调用失败按错误类型决定重不重试。断言打在用户可见契约上：
返回值（stoppedBy、答案含状态码）、假客户端被调用的次数、trace 里 llm effect 的逐次尝试明细、注入的 sleep 收到的等待毫秒。"""
import pytest

from mini_agent.runtime.agent import Agent
from mini_agent.runtime.trace import MemoryTraceSink


class Scripted:
    """按脚本抛错 / 回答的假客户端：script 里是 Exception 就 raise，是字符串就回复"""

    model = "scripted"

    def __init__(self, script):
        self.script = list(script)
        self.calls = 0

    def chat(self, messages, tools=None):
        self.calls += 1
        if not self.script:
            raise RuntimeError("脚本用完了")
        nxt = self.script.pop(0)
        if isinstance(nxt, BaseException):
            raise nxt
        return {"text": nxt}


def fail(message, **extra):
    e = RuntimeError(message)
    for k, v in extra.items():
        setattr(e, k, v)
    return e


class FakeSleep:
    def __init__(self):
        self.waits = []

    def __call__(self, ms):
        self.waits.append(ms)


def test_401_once_then_error():
    llm = Scripted([fail("Incorrect API key provided", status=401), "<final>不该到这</final>"])
    trace, sleep = MemoryTraceSink(), FakeSleep()
    r = Agent(llm=llm, trace=trace, sleep=sleep).run(user_id="u1", session_id="s1", input="hi")
    assert r["stoppedBy"] == "error"
    assert "401" in r["answer"]
    assert llm.calls == 1
    assert sleep.waits == []
    fx = trace.effects("llm")
    assert len(fx) == 1 and fx[0]["attempts"] == 1
    assert fx[0]["tries"] == [{"n": 1, "errorClass": "auth", "waitMs": 0}]


def test_429_three_times_then_error():
    llm = Scripted([fail("Rate limit reached", status=429)] * 3 + ["<final>不该到这</final>"])
    trace, sleep = MemoryTraceSink(), FakeSleep()
    r = Agent(llm=llm, trace=trace, sleep=sleep).run(user_id="u1", session_id="s1", input="hi")
    assert r["stoppedBy"] == "error"
    assert "429" in r["answer"]
    assert llm.calls == 3
    assert sleep.waits == [300, 600]
    fx = trace.effects("llm")
    assert len(fx) == 1 and fx[0]["attempts"] == 3
    assert fx[0]["tries"] == [{"n": 1, "errorClass": "rate_limited", "waitMs": 300}, {"n": 2, "errorClass": "rate_limited", "waitMs": 600}, {"n": 3, "errorClass": "rate_limited", "waitMs": 0}]
    assert trace.sequence() == ["t-llm-failed"]


@pytest.mark.parametrize("name,make,cls", [
    ("超时 ETIMEDOUT", lambda: fail("connect ETIMEDOUT", code="ETIMEDOUT"), "timeout"),
    ("网络 ECONNRESET", lambda: fail("read ECONNRESET", code="ECONNRESET"), "network"),
    ("服务端 503", lambda: fail("Service Unavailable", status=503), "server"),
])  # ×3
def test_retryable_succeeds_third_time(name, make, cls):
    llm = Scripted([make(), make(), "<final>第三次才通</final>"])
    trace, sleep = MemoryTraceSink(), FakeSleep()
    r = Agent(llm=llm, trace=trace, sleep=sleep).run(user_id="u1", session_id="s1", input="hi")
    assert r["stoppedBy"] == "final" and r["answer"] == "第三次才通"
    assert llm.calls == 3
    assert sleep.waits == [300, 600]
    fx = trace.effects("llm")
    assert len(fx) == 1 and fx[0]["attempts"] == 3
    assert fx[0]["tries"] == [{"n": 1, "errorClass": cls, "waitMs": 300}, {"n": 2, "errorClass": cls, "waitMs": 600}]


def test_single_success_no_tries():
    llm = Scripted(["<final>一次就好</final>"])
    trace, sleep = MemoryTraceSink(), FakeSleep()
    r = Agent(llm=llm, trace=trace, sleep=sleep).run(user_id="u1", session_id="s1", input="hi")
    assert r["answer"] == "一次就好"
    assert sleep.waits == []
    fx = trace.effects("llm")[0]
    assert (fx["attempts"], fx["tries"]) == (1, [])
