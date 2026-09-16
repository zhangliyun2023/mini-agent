"""#10 原生 function calling：断言只打在「模型实际收到的 messages」「trace 记录」「返回值」上。"""
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from mini_agent.llm.fake import FakeLLM
from mini_agent.memory.user_memory import MemoryUserMemoryStore
from mini_agent.runtime.agent import Agent, default_tools
from mini_agent.runtime.trace import MemoryTraceSink
from mini_agent.session.context import ContextOptions
from tests.conftest import last_tool


def test_native_system_prompt_no_tags():
    memory = MemoryUserMemoryStore()
    memory.set("A", "city", "上海")
    native = FakeLLM(["好的"], native=True)
    Agent(llm=native, memory=memory).run(user_id="A", session_id="s", input="hi")
    sys_msg = native.calls[0][0]
    assert sys_msg["role"] == "system"
    for tag in ("<tool_call>", "<final>", "<think>", "参数 Schema"):
        assert tag not in sys_msg["content"]
    assert "calculator" in sys_msg["content"] and "remember" in sys_msg["content"]
    assert re.search(r"city: 上海", sys_msg["content"])
    text = FakeLLM(["<final>好的</final>"])
    Agent(llm=text, memory=memory).run(user_id="A", session_id="s", input="hi")
    assert "<tool_call>" in text.calls[0][0]["content"] and "<final>" in text.calls[0][0]["content"]


def test_native_tool_calls_message_shape():
    trace = MemoryTraceSink()
    llm = FakeLLM([{"toolCalls": [{"name": "calculator", "arguments": {"expression": "99*99"}}]}, "99*99 = 9801"], native=True)
    r = Agent(llm=llm, trace=trace).run(user_id="u", session_id="s", input="算 99*99")
    assert r["answer"] == "99*99 = 9801"
    assert r["stoppedBy"] == "final"
    second = llm.calls[1]
    ai = next(i for i, m in enumerate(second) if m["role"] == "assistant")
    assert ai > 0
    assistant = second[ai]
    assert len(assistant["toolCalls"]) == 1
    assert assistant["toolCalls"][0]["name"] == "calculator"
    assert assistant["toolCalls"][0]["arguments"] == json.dumps({"expression": "99*99"}, separators=(",", ":"))
    assert isinstance(assistant["toolCalls"][0]["id"], str)
    assert "<tool_call>" not in assistant["content"]
    tool = second[ai + 1]
    assert (tool["role"], tool["name"], tool["toolCallId"], tool["content"]) == ("tool", "calculator", assistant["toolCalls"][0]["id"], "9801")
    llm_effects = trace.effects("llm")
    assert len(llm_effects) == 2
    assert all(e["mode"] == "native" for e in llm_effects)
    assert trace.sequence() == ["t-llm-ok [noop]", "t-tools", "t-tools-done", "t-llm-ok [noop]", "t-final"]


def test_text_mode_effect_and_step_index_id():
    trace = MemoryTraceSink()
    llm = FakeLLM(['<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>', "<final>2</final>"])
    Agent(llm=llm, trace=trace).run(user_id="u", session_id="s", input="1+1")
    assert all(e["mode"] == "text" for e in trace.effects("llm"))
    tool = next(m for m in llm.calls[1] if m["role"] == "tool")
    assert tool["toolCallId"] == "1-0"
    assert "toolCalls" not in next(m for m in llm.calls[1] if m["role"] == "assistant")


# ---- 发给厂商的线上形状：起一个本地 HTTP 端点收 OpenAICompatibleLLM 真正 POST 出去的 body ----
class _Capture:
    def __init__(self, replies):
        self.bodies = []
        queue = list(replies)
        bodies = self.bodies

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                bodies.append(json.loads(raw))
                r = queue.pop(0) if queue else {"content": "脚本用完了"}
                message = {"role": "assistant", "content": r.get("content"), **({"tool_calls": r["tool_calls"]} if r.get("tool_calls") else {})}
                body = json.dumps({"id": "x", "object": "chat.completion", "created": 0, "model": "m", "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if r.get("tool_calls") else "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def fn(id, name, args):
    return {"id": id, "type": "function", "function": {"name": name, "arguments": json.dumps(args, separators=(",", ":"))}}


def test_wire_native_replays_tool_calls():
    from mini_agent.llm.openai_compatible import OpenAICompatibleLLM

    cap = _Capture([{"tool_calls": [fn("call_abc", "calculator", {"expression": "99*99"})]}, {"content": "结果是 9801"}, {"tool_calls": [fn("call_def", "calculator", {"expression": "9801+1"})]}, {"content": "9802"}])
    try:
        memory = MemoryUserMemoryStore()
        tools = default_tools(memory)
        llm = OpenAICompatibleLLM(api_key="k", base_url=cap.base_url, model="m", native_tools=tools.specs(), timeout_s=5)
        agent = Agent(llm=llm, tools=tools, memory=memory, llm_retries=0)
        assert agent.run(user_id="u", session_id="s", input="算 99*99")["answer"] == "结果是 9801"
        assert agent.run(user_id="u", session_id="s", input="再加 1")["answer"] == "9802"
        assert len(cap.bodies) == 4
        assert [t["function"]["name"] for t in cap.bodies[0]["tools"]] == ["calculator", "search", "todo", "remember"]
        assert cap.bodies[0]["messages"][0]["role"] == "system"
        assert "<tool_call>" not in cap.bodies[0]["messages"][0]["content"]
        m2 = cap.bodies[1]["messages"]
        ai = next(i for i, m in enumerate(m2) if m["role"] == "assistant")
        assert m2[ai]["tool_calls"] == [fn("call_abc", "calculator", {"expression": "99*99"})]
        assert (m2[ai + 1]["role"], m2[ai + 1]["tool_call_id"], m2[ai + 1]["content"]) == ("tool", "call_abc", "9801")
        assert not any(m["role"] == "user" and "[工具" in str(m["content"]) for m in m2)
        m3 = cap.bodies[2]["messages"]
        hist = next(i for i, m in enumerate(m3) if m["role"] == "assistant" and m.get("tool_calls"))
        assert hist > 0
        assert m3[hist]["tool_calls"][0]["id"] == "call_abc"
        assert (m3[hist + 1]["role"], m3[hist + 1]["tool_call_id"]) == ("tool", "call_abc")
        assert (m3[hist + 2]["role"], m3[hist + 2]["content"]) == ("assistant", "结果是 9801")
        assert "<final>" not in json.dumps(m3, ensure_ascii=False) and "<tool_call>" not in json.dumps(m3, ensure_ascii=False)
        m4 = cap.bodies[3]["messages"]
        assert m4[-2]["tool_calls"][0]["id"] == "call_def"
        assert (m4[-1]["role"], m4[-1]["tool_call_id"], m4[-1]["content"]) == ("tool", "call_def", "9802")
    finally:
        cap.close()


def test_wire_text_mode_downgrades_tool_results():
    from mini_agent.llm.openai_compatible import OpenAICompatibleLLM

    cap = _Capture([{"content": '<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call>'}, {"content": "<final>2</final>"}])
    try:
        memory = MemoryUserMemoryStore()
        tools = default_tools(memory)
        llm = OpenAICompatibleLLM(api_key="k", base_url=cap.base_url, model="m", timeout_s=5)
        r = Agent(llm=llm, tools=tools, memory=memory, llm_retries=0).run(user_id="u", session_id="s", input="1+1")
        assert r["answer"] == "2"
        assert "tools" not in cap.bodies[0]
        assert "<tool_call>" in cap.bodies[0]["messages"][0]["content"]
        m2 = cap.bodies[1]["messages"]
        assert not any(m["role"] == "tool" for m in m2)
        assert m2[-1] == {"role": "user", "content": "[工具 calculator 的结果]\n2"}
    finally:
        cap.close()


def todo(action, **extra):
    return {"name": "todo", "arguments": {"action": action, **extra}}


def test_native_followup_replays_pairs():
    llm = FakeLLM([{"toolCalls": [todo("add", item="买牛奶")]}, "加好了", {"toolCalls": [todo("done", index=1)]}, lambda m: last_tool(m)], native=True)
    agent = Agent(llm=llm)
    agent.run(user_id="u", session_id="s", input="记一下买牛奶")
    r = agent.run(user_id="u", session_id="s", input="第一条完成了")
    assert "[x] 买牛奶" in r["answer"]
    replay = llm.calls[2]
    hist = next(i for i, m in enumerate(replay) if m["role"] == "assistant" and m.get("toolCalls"))
    assert hist > 0
    assert (replay[hist + 1]["role"], replay[hist + 1]["name"], replay[hist + 1]["toolCallId"]) == ("tool", "todo", replay[hist]["toolCalls"][0]["id"])
    assert (replay[hist + 2]["role"], replay[hist + 2]["content"]) == ("assistant", "加好了")
    assert "<final>" not in "\n".join(m["content"] for m in replay)


def test_native_compaction_transcript_and_rule_fallback():
    script = []
    for i in range(1, 4):
        script.append({"toolCalls": [{"name": "calculator", "arguments": {"expression": f"{i}+{i}"}}]})
        script.append(lambda m, i=i: f"答{i}={last_tool(m)}")
    seen = {}

    def summarizer(m):
        seen["transcript"] = m[1]["content"]
        return "要点：算过 1+1 2+2"

    script.append(summarizer)
    script.append("ok")
    llm = FakeLLM(script, native=True)
    agent = Agent(llm=llm, context=ContextOptions(max_history_messages=8, keep_recent_messages=4, max_history_chars=100_000))
    for i in range(1, 4):
        agent.run(user_id="u", session_id="s", input=f"算{i}+{i}")
    agent.run(user_id="u", session_id="s", input="问4")
    assert "calculator" in seen["transcript"]
    assert '"expression":"1+1"' in seen["transcript"]
    assert "答1=2" in seen["transcript"]

    llm2 = FakeLLM([{"toolCalls": [{"name": "calculator", "arguments": {"expression": "1+1"}}]}, "答1=2", "答2", RuntimeError("摘要接口挂了"), lambda m: m[1]["content"]], native=True)
    agent2 = Agent(llm=llm2, llm_retries=0, context=ContextOptions(max_history_messages=3, keep_recent_messages=1, max_history_chars=100_000))
    agent2.run(user_id="u", session_id="s", input="算1+1")
    agent2.run(user_id="u", session_id="s", input="问2")
    r = agent2.run(user_id="u", session_id="s", input="问3")
    assert "用户：算1+1" in r["answer"]
    assert "助手：答1=2" in r["answer"]
    assert not re.search(r"助手：\s*$", r["answer"], re.M)


def test_native_bad_arguments_blocked_then_retry():
    trace = MemoryTraceSink()
    llm = FakeLLM([{"toolCalls": [{"name": "calculator", "arguments": '{"expression": '}]}, {"toolCalls": [{"name": "calculator", "arguments": {"expression": "2*3"}}]}, lambda m: last_tool(m)], native=True)
    r = Agent(llm=llm, trace=trace).run(user_id="u", session_id="s", input="2*3")
    assert r["answer"] == "6"
    assert [x["reject_code"] for x in trace.records if x["status"] == "blocked"] == ["PARSE_ERROR"]
    assert len(trace.effects("tool")) == 1
    fb = llm.calls[1]
    assert "toolCalls" not in fb[-2]
    assert (fb[-1]["role"], fb[-1]["name"], fb[-1]["toolCallId"]) == ("tool", "parser", "parse-1")
    assert "不是合法 JSON" in fb[-1]["content"]
