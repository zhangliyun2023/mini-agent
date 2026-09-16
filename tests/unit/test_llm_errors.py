"""#11：错误分类是纯函数——输入看 status / code / name / message，输出八类之一；
可重试 = rate_limited / server / timeout / network / unknown，不可重试 = auth / bad_request / not_found。"""
import socket

import pytest
from openai import APIConnectionError, APITimeoutError, AuthenticationError, RateLimitError

# openai ≥ 3 用 httpx2 构造异常里的 request / response；2.x 用 httpx。取 SDK 实际依赖的那个，两边都能构造真实 SDK 异常
try:
    import httpx2 as httpx  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover —— 取决于装的是哪个 SDK 大版本
    import httpx

from mini_agent.llm.errors import classify_llm_error, is_retryable


def err(message, **extra):
    e = RuntimeError(message)
    for k, v in extra.items():
        setattr(e, k, v)
    return e


class Cause:
    def __init__(self, code):
        self.code = code


_REQ = httpx.Request("POST", "http://x")


@pytest.mark.parametrize("e,cls", [
    (err("Incorrect API key", status=401), "auth"),
    (err("forbidden", status=403), "auth"),
    (err("bad request", status=400), "bad_request"),
    (err("unprocessable", status=422), "bad_request"),
    (err("model not found", status=404), "not_found"),
    (err("rate limited", status=429), "rate_limited"),
    (err("upstream down", status=502), "server"),
    (err("internal", status=500), "server"),
    (err("socket timed out", code="ETIMEDOUT"), "timeout"),
    (err("Request timed out.", name="APIConnectionTimeoutError"), "timeout"),
    (err("Connection error.", code="ECONNRESET"), "network"),
    (err("fetch failed", name="APIConnectionError"), "network"),
    (err("fetch failed", cause=Cause("ECONNREFUSED")), "network"),
    (err("something odd"), "unknown"),
    ("not even an Error", "unknown"),
    # Python 原生的网络 / 超时错误形状
    (ConnectionResetError(54, "Connection reset by peer"), "network"),
    (socket.timeout("timed out"), "timeout"),
    # 真实 SDK 抛出的形状（openai-python：status_code / message）
    (AuthenticationError("Incorrect API key", response=httpx.Response(401, request=_REQ), body=None), "auth"),
    (RateLimitError("Rate limit reached", response=httpx.Response(429, request=_REQ), body=None), "rate_limited"),
    (APITimeoutError(request=_REQ), "timeout"),
    (APIConnectionError(request=_REQ), "network"),
])  # ×21
def test_classify(e, cls):
    assert classify_llm_error(e) == cls


def test_status_beats_code():
    assert classify_llm_error(err("x", status=401, code="ETIMEDOUT")) == "auth"


def test_only_three_classes_non_retryable():
    assert [is_retryable(c) for c in ("auth", "bad_request", "not_found")] == [False, False, False]
    assert [is_retryable(c) for c in ("rate_limited", "server", "timeout", "network", "unknown")] == [True] * 5
