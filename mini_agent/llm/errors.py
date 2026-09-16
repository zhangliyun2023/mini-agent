"""模型调用错误的分类（#11）：纯函数，runtime 用它决定「重不重试」，trace 用它给每次尝试打标签。

输入是任何抛出物：OpenAI SDK 的 APIStatusError（status_code）/ APIConnectionError / APITimeoutError、
socket / httpx 的连接错（errno 或类名）、以及只有 message 的普通 Exception。
也接受 TS 风格的属性（status / code / name / message / cause），方便两个实现共用同一批夹具。
"""
import errno
import re
from typing import Any, Optional

# auth | bad_request | not_found | rate_limited | server | timeout | network | unknown
NON_RETRYABLE = frozenset(["auth", "bad_request", "not_found"])


def is_retryable(cls: str) -> bool:
    return cls not in NON_RETRYABLE


NETWORK_CODES = frozenset(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_SOCKET"])
TIMEOUT_CODES = frozenset(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"])
_ERRNO_NETWORK = frozenset([errno.ECONNRESET, errno.ECONNREFUSED, errno.EHOSTUNREACH, errno.ENETUNREACH, errno.EPIPE])
_ERRNO_TIMEOUT = frozenset([errno.ETIMEDOUT])


def _status(e: Any) -> Optional[int]:
    for attr in ("status", "status_code"):
        v = getattr(e, attr, None)
        if isinstance(v, int) and not isinstance(v, bool):
            return v
    return None


def _code(e: Any) -> Optional[str]:
    """字符串 code（TS 风格 / 自定义）或 errno 名；顺着 cause / __cause__ 找一层"""
    for obj in (e, getattr(e, "cause", None), getattr(e, "__cause__", None), getattr(e, "__context__", None)):
        if obj is None:
            continue
        c = getattr(obj, "code", None)
        if isinstance(c, str):
            return c
        n = getattr(obj, "errno", None)
        if isinstance(n, int):
            if n in _ERRNO_TIMEOUT:
                return "ETIMEDOUT"
            if n in _ERRNO_NETWORK:
                return errno.errorcode.get(n, str(n))
    return None


def _name(e: Any) -> str:
    n = getattr(e, "name", None)
    if isinstance(n, str) and n:
        return n
    return type(e).__name__ if isinstance(e, BaseException) else ""


def _message(e: Any) -> str:
    m = getattr(e, "message", None)
    if isinstance(m, str) and m:
        return m
    if isinstance(e, BaseException):
        return str(e)
    return ""


def classify_llm_error(e: Any) -> str:
    if e is None or isinstance(e, (str, int, float, bool)):
        return "unknown"
    status = _status(e)
    if status is not None:
        if status in (401, 403):
            return "auth"
        if status == 404:
            return "not_found"
        if status == 429:
            return "rate_limited"
        if status >= 500:
            return "server"
        if status >= 400:
            return "bad_request"
    code = _code(e)
    if code is not None:
        if code in TIMEOUT_CODES:
            return "timeout"
        if code in NETWORK_CODES:
            return "network"
    name = _name(e)
    if re.search(r"timeout", name, re.I) or name == "AbortError" or isinstance(e, TimeoutError):
        return "timeout"
    if re.search(r"connection|connect", name, re.I) or isinstance(e, ConnectionError):
        return "network"
    message = _message(e)
    if re.search(r"timed? ?out", message, re.I):
        return "timeout"
    if re.search(r"connection error|fetch failed|socket hang up|network", message, re.I):
        return "network"
    return "unknown"


def describe_llm_error(e: Any, cls: Optional[str] = None) -> str:
    """给用户看的一行：类别 + 状态码/错误码 + 原始 message，例：`auth 401: Incorrect API key`"""
    cls = cls or classify_llm_error(e)
    status = _status(e)
    parts = [cls, str(status) if status is not None else None, _code(e)]
    tag = " ".join(p for p in parts if p)
    message = _message(e) or str(e)
    return f"{tag}: {message}"
