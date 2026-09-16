import os
import re
from typing import Dict

# 极简 .env 读取：不引 python-dotenv，评审 clone 下来 cp .env.example .env 就能跑
_LINE = re.compile(r"^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$")


def load_env(path: str = ".env") -> None:
    if not os.path.exists(path):
        return
    with open(path, encoding="utf8") as f:
        for line in f:
            m = _LINE.match(line.rstrip("\n"))
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = re.sub(r"^[\"']|[\"']$", "", m.group(2))


def llm_config() -> Dict[str, str]:
    load_env()
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("缺少 OPENAI_API_KEY：复制 .env.example 为 .env 并填入 key")
    return {
        "api_key": api_key,
        "base_url": os.environ.get("OPENAI_BASE_URL") or "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": os.environ.get("MODEL") or "qwen3-max",
    }
