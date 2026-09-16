"""用法：python -m mini_agent.cli --user A --session w1 [--native-tools] [--quiet] [--data <dir>]
--data：文件存储根目录（默认 data/；memory / sessions / transcripts 都在它下面），复盘 CLI 用同一个目录就能读到转写
多开终端、不同 --session 就是「同一用户的两个窗口」；同一 --session 再次进入即接着聊。
"""
import sys
from typing import Dict, List

from .config import llm_config
from .memory.user_memory import FileUserMemoryStore
from .review.transcript import FileTranscriptStore
from .runtime.agent import Agent, default_tools
from .runtime.trace import FileTraceSink
from .session.store import FileSessionStore


def parse_args(argv: List[str]) -> Dict[str, str]:
    args: Dict[str, str] = {}
    for i, a in enumerate(argv):
        if a.startswith("--"):
            nxt = argv[i + 1] if i + 1 < len(argv) else None
            args[a[2:]] = "true" if nxt is None or nxt.startswith("--") else nxt
    return args


def main(argv: List[str]) -> None:
    args = parse_args(argv)
    user_id = args.get("user", "A")
    session_id = args.get("session", "w1")
    data_dir = args.get("data", "data")
    native = "native-tools" in args

    cfg = llm_config()
    from .llm.openai_compatible import OpenAICompatibleLLM

    memory = FileUserMemoryStore(f"{data_dir}/memory")
    tools = default_tools(memory)
    llm = OpenAICompatibleLLM(**cfg, native_tools=tools.specs() if native else None)
    agent = Agent(
        llm=llm, tools=tools, memory=memory,
        sessions=FileSessionStore(f"{data_dir}/sessions"),
        trace=FileTraceSink("trace", "quiet" not in args),
        transcripts=FileTranscriptStore(f"{data_dir}/transcripts"),
    )
    sys.stderr.write(f"mini-agent · model={cfg['model']} · user={user_id} · session={session_id} · {'native function calling' if native else '文本协议'}\n输入 /exit 退出，/sessions 列出本用户的会话\n")
    tty = sys.stdin.isatty()

    def prompt() -> None:
        if tty:
            sys.stdout.write("你> ")
            sys.stdout.flush()

    prompt()
    # 逐行读 stdin，交互和管道输入都能跑完
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            prompt()
            continue
        if line == "/exit":
            break
        if line == "/sessions":
            sys.stdout.write("\n".join(agent.sessions.list(user_id)) + "\n")
            prompt()
            continue
        if not tty:
            sys.stdout.write(f"你> {line}\n")
        r = agent.run(user_id=user_id, session_id=session_id, input=line)
        sys.stdout.write(f"助手> {r['answer']}\n")
        sys.stdout.flush()
        if r["stoppedBy"] != "final":
            sys.stderr.write(f"  (结束原因：{r['stoppedBy']})\n")
        prompt()


if __name__ == "__main__":
    main(sys.argv[1:])
