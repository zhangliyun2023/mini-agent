import { describe, it, expect } from "vitest";
import { parseAssistantOutput } from "../../src/protocol/parser.js";

describe("解析模型输出：思考 / 工具调用 / 最终答案", () => {
  it("同时含 think 与 tool_call 时，提取思考与工具调用，且不视为最终答案", () => {
    const out = parseAssistantOutput(
      `<think>用户要算数，用 calculator</think>\n<tool_call>{"name":"calculator","arguments":{"expression":"2+3"}}</tool_call>`,
    );
    expect(out.think).toBe("用户要算数，用 calculator");
    expect(out.toolCalls).toEqual([{ name: "calculator", arguments: { expression: "2+3" } }]);
    expect(out.final).toBeUndefined();
  });

  it("只有 final 时，返回最终答案，工具调用为空", () => {
    const out = parseAssistantOutput(`<think>不需要工具</think><final>你好！</final>`);
    expect(out.final).toBe("你好！");
    expect(out.toolCalls).toEqual([]);
  });

  it("模型没守协议、裸文本输出时，整段当作最终答案（容错）", () => {
    const out = parseAssistantOutput("2 + 3 等于 5。");
    expect(out.final).toBe("2 + 3 等于 5。");
    expect(out.toolCalls).toEqual([]);
    expect(out.think).toBeUndefined();
  });

  it("一次输出多个 tool_call 时按顺序全部提取", () => {
    const out = parseAssistantOutput(
      `<tool_call>{"name":"search","arguments":{"query":"a"}}</tool_call><tool_call>{"name":"search","arguments":{"query":"b"}}</tool_call>`,
    );
    expect(out.toolCalls.map((c) => c.arguments.query)).toEqual(["a", "b"]);
  });

  it("tool_call 里 JSON 坏掉时，记录解析错误而不是抛异常，供 runtime 回喂模型", () => {
    const out = parseAssistantOutput(`<tool_call>{"name":"search","arguments":{"query":</tool_call>`);
    expect(out.toolCalls).toEqual([]);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0]).toMatch(/JSON/);
  });

  it("既有 tool_call 又有 final 时，以工具调用为准（final 被忽略并记警告）", () => {
    const out = parseAssistantOutput(
      `<tool_call>{"name":"calculator","arguments":{"expression":"1+1"}}</tool_call><final>结果是 2</final>`,
    );
    expect(out.toolCalls.length).toBe(1);
    expect(out.final).toBeUndefined();
    expect(out.errors[0]).toMatch(/final/);
  });

  it("tool_call 缺 name 字段时视为错误", () => {
    const out = parseAssistantOutput(`<tool_call>{"arguments":{}}</tool_call>`);
    expect(out.toolCalls).toEqual([]);
    expect(out.errors[0]).toMatch(/name/);
  });
});

describe("真实模型跑出来的偏差（2026-09-14 qwen3-max 实测）", () => {
  it("模型用 <invoke> / <function_call> 代替 <tool_call> 时照样识别，并记一条 warning", () => {
    const out = parseAssistantOutput(`<invoke>{"name":"search","arguments":{"query":"上海今天天气"}}</invoke>`);
    expect(out.toolCalls).toEqual([{ name: "search", arguments: { query: "上海今天天气" } }]);
    expect(out.final).toBeUndefined();
    expect(out.warnings[0]).toMatch(/invoke/);
  });

  it("裸文本里带着像工具调用的 JSON（有 name 和 arguments）时，不当最终答案，而是记解析错误回喂", () => {
    const out = parseAssistantOutput(`我来调用工具：{"name":"calculator","arguments":{"expression":"1+1"}}`);
    expect(out.final).toBeUndefined();
    expect(out.toolCalls).toEqual([]);
    expect(out.errors[0]).toMatch(/tool_call/);
  });

  it("外层多套一层 <tool_code> 不影响", () => {
    const out = parseAssistantOutput(`<tool_code><tool_call>{"name":"calculator","arguments":{"expression":"2"}}</tool_call></tool_code>`);
    expect(out.toolCalls.length).toBe(1);
  });

  // 2026-09-15 live 暴露（#4）：原生模式下模型没走 tool_calls，直接吐 <function=NAME><parameter=K>V</parameter></function>
  it("模型输出 <function=NAME><parameter=K>V</parameter></function> 变体时识别为工具调用，并记一条 warning", () => {
    const out = parseAssistantOutput(`<think>算</think>\n<function=calculator>\n<parameter=expression>99*99</parameter>\n</function>`);
    expect(out.toolCalls).toEqual([{ name: "calculator", arguments: { expression: "99*99" } }]);
    expect(out.final).toBeUndefined();
    expect(out.errors).toEqual([]);
    expect(out.warnings[0]).toMatch(/function=/);
  });

  it("<function=…> 变体带多个参数时全部提取；连续两个 function 块是两次调用", () => {
    const out = parseAssistantOutput(
      `<function=todo><parameter=action>done</parameter><parameter=index>1</parameter></function><function=search><parameter=query>上海</parameter></function>`,
    );
    // 参数值是文本，数字按原生 function calling 的习惯还原成 number，否则过不了 Schema 校验
    expect(out.toolCalls).toEqual([
      { name: "todo", arguments: { action: "done", index: 1 } },
      { name: "search", arguments: { query: "上海" } },
    ]);
  });

  it("<function=…> 块不完整（缺 </function>）时不当最终答案，记解析错误回喂", () => {
    const out = parseAssistantOutput(`<function=calculator>\n<parameter=expression>99*99</parameter>`);
    expect(out.final).toBeUndefined();
    expect(out.toolCalls).toEqual([]);
    expect(out.errors[0]).toMatch(/tool_call/);
  });
});

