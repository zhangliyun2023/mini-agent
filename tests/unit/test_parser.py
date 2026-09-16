import re

from mini_agent.protocol.parser import parse_assistant_output as parse


def test_think_and_tool_call_not_final():
    out = parse('<think>用户要算数，用 calculator</think>\n<tool_call>{"name":"calculator","arguments":{"expression":"2+3"}}</tool_call>')
    assert out["think"] == "用户要算数，用 calculator"
    assert out["toolCalls"] == [{"name": "calculator", "arguments": {"expression": "2+3"}}]
    assert "final" not in out


def test_only_final():
    out = parse("<think>不需要工具</think><final>你好！</final>")
    assert out["final"] == "你好！"
    assert out["toolCalls"] == []


def test_bare_text_is_final():
    out = parse("2 + 3 等于 5。")
    assert out["final"] == "2 + 3 等于 5。"
    assert out["toolCalls"] == []
    assert "think" not in out


def test_multiple_tool_calls_in_order():
    out = parse('<tool_call>{"name":"search","arguments":{"query":"a"}}</tool_call><tool_call>{"name":"search","arguments":{"query":"b"}}</tool_call>')
    assert [c["arguments"]["query"] for c in out["toolCalls"]] == ["a", "b"]


def test_bad_json_records_error_not_raise():
    out = parse('<tool_call>{"name":"search","arguments":{"query":</tool_call>')
    assert out["toolCalls"] == []
    assert len(out["errors"]) == 1
    assert "JSON" in out["errors"][0]


def test_tool_call_and_final_prefers_tool_call():
    out = parse('<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call><final>结果是 2</final>')
    assert len(out["toolCalls"]) == 1
    assert "final" not in out
    assert "final" in out["errors"][0]


def test_missing_name_is_error():
    out = parse('<tool_call>{"arguments":{}}</tool_call>')
    assert out["toolCalls"] == []
    assert "name" in out["errors"][0]


# 真实模型跑出来的偏差（2026-09-14 qwen3-max 实测）

def test_invoke_alias_recognized_with_warning():
    out = parse('<invoke>{"name":"search","arguments":{"query":"上海今天天气"}}</invoke>')
    assert out["toolCalls"] == [{"name": "search", "arguments": {"query": "上海今天天气"}}]
    assert "final" not in out
    assert "invoke" in out["warnings"][0]


def test_bare_json_call_is_error_not_final():
    out = parse('我来调用工具：{"name":"calculator","arguments":{"expression":"1+1"}}')
    assert "final" not in out
    assert out["toolCalls"] == []
    assert "tool_call" in out["errors"][0]


def test_wrapped_in_tool_code():
    out = parse('<tool_code><tool_call>{"name":"calculator","arguments":{"expression":"2"}}</tool_call></tool_code>')
    assert len(out["toolCalls"]) == 1


def test_function_parameter_variant():
    # 2026-09-15 live 暴露（#4）：原生模式下模型没走 tool_calls，直接吐 <function=NAME><parameter=K>V</parameter></function>
    out = parse("<think>算</think>\n<function=calculator>\n<parameter=expression>99*99</parameter>\n</function>")
    assert out["toolCalls"] == [{"name": "calculator", "arguments": {"expression": "99*99"}}]
    assert "final" not in out
    assert out["errors"] == []
    assert "function=" in out["warnings"][0]


def test_function_variant_multiple_params_and_blocks():
    out = parse("<function=todo><parameter=action>done</parameter><parameter=index>1</parameter></function><function=search><parameter=query>上海</parameter></function>")
    # 参数值是文本，数字按原生 function calling 的习惯还原成 number，否则过不了 Schema 校验
    assert out["toolCalls"] == [{"name": "todo", "arguments": {"action": "done", "index": 1}}, {"name": "search", "arguments": {"query": "上海"}}]


def test_incomplete_function_block_is_error():
    out = parse("<function=calculator>\n<parameter=expression>99*99</parameter>")
    assert "final" not in out
    assert out["toolCalls"] == []
    assert "tool_call" in out["errors"][0]


# 真实模型跑出来的偏差（2026-09-15 CLI 实测，用户 B 场景）

def test_closing_tag_written_as_open_tag_still_three_calls():
    out = parse(
        '<tool_call>{"name":"remember","arguments":{"key":"name","value":"老李"}}</tool_call>\n'
        '<tool_call>{"name":"remember","arguments":{"key":"city","value":"杭州"}}<tool_call>\n'
        '<tool_call>{"name":"search","arguments":{"query":"杭州 适合看书的安静地方 周末"}}</tool_call>'
    )
    assert out["errors"] == []
    assert [[c["name"], c["arguments"]] for c in out["toolCalls"]] == [
        ["remember", {"key": "name", "value": "老李"}],
        ["remember", {"key": "city", "value": "杭州"}],
        ["search", {"query": "杭州 适合看书的安静地方 周末"}],
    ]


def test_double_final_open_tag():
    assert parse("<final><final>好的，老李！</final>")["final"] == "好的，老李！"


def test_unclosed_final():
    out = parse("<think>x</think><final>你住在上海。")
    assert out["final"] == "你住在上海。"
    assert out["errors"] == []
