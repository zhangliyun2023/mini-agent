import type { ToolSpec } from "../tools/registry.js";
import type { ToolMode } from "../llm/types.js";

// system prompt = 角色 + 输出协议 + 工具清单（含 Schema）+ 用户记忆块。
// 原生 function calling 模式（#10）：不教标签协议、不列工具 Schema（工具经 API 的 tools 字段给），只保留角色 + 规则 + 记忆块。
export function buildSystemPrompt(tools: ToolSpec[], memoryBlock: string, mode: ToolMode = "text"): string {
  const memory = memoryBlock ? "\n关于当前用户的长期记忆（跨会话）：\n" + memoryBlock : "";
  if (mode === "native") return buildNativeSystemPrompt(memory);
  const toolList = tools
    .map((t) => `- ${t.name}: ${t.description}\n  参数 Schema: ${JSON.stringify(t.parameters)}`)
    .join("\n");
  return [
    "你是一个可以调用工具的助手。每次回复必须严格使用下面的标签格式，标签外不要有任何文字。",
    "",
    "格式：",
    "<think>你的简短思考：用户要什么、需不需要工具、用哪个</think>",
    "然后二选一：",
    '  A. 需要工具 → 一个或多个 <tool_call>{"name":"工具名","arguments":{…}}</tool_call>，然后停止输出，等待工具结果。',
    "  B. 不需要工具 / 已拿到足够的工具结果 → <final>给用户的最终回答</final>",
    "",
    "规则：",
    "- arguments 必须符合工具的参数 Schema，必填参数不能少。",
    "- 工具结果会以 tool 消息返回给你；结果里报错时请修正参数重试或换一种做法，不要原样重复。",
    ...COMMON_RULES,
    "- 标签名必须是 tool_call，不要写成 invoke / function_call，也不要用 <function=名字><parameter=参数>…</parameter></function> 的写法。",
    "- 每个 <tool_call> 必须以 </tool_call> 闭合；<final> 只写一次并以 </final> 闭合。",
    "- 收到「无法解析」的回喂时，重新发出全部工具调用再作答；工具没有成功执行，就不要给出依赖工具结果的答案，不要编造。",
    "",
    "示例：",
    "用户：3 的 8 次方是多少",
    '你：<think>需要精确计算</think><tool_call>{"name":"calculator","arguments":{"expression":"3*3*3*3*3*3*3*3"}}</tool_call>',
    "（工具返回 6561）",
    "你：<final>3 的 8 次方是 6561。</final>",
    "",
    "可用工具：",
    toolList,
    memory,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

/** 两种模式共用的行为规则：与标签协议无关，只关乎「什么时候必须用哪个工具」 */
const COMMON_RULES = [
  "- 需要精确计算时必须用 calculator，不要心算。",
  "- 用户追问时结合之前的对话与工具结果作答，不要重复已经做过的调用。",
  "- 用户说「记住…」或透露稳定的个人信息（称呼、城市、职业、长期偏好）时，必须调用 remember 工具，每条信息各调一次；没有调用就不算记住，不要口头说「已记下」。",
];

function buildNativeSystemPrompt(memory: string): string {
  return [
    "你是一个可以调用工具的助手。需要工具时直接通过 function calling 发起调用（可以一次发多个），拿到工具结果后再用普通文本给出最终回答；不需要工具时直接回答。",
    "",
    "规则：",
    "- 调用参数必须符合工具的参数定义，必填参数不能少。",
    "- 工具结果会以 tool 消息返回给你；结果里报错时请修正参数重试或换一种做法，不要原样重复。",
    ...COMMON_RULES,
    "- 不要把工具调用写成文本（例如 <function=…> 或 JSON 片段），一律走 function calling；工具没有成功执行，就不要给出依赖工具结果的答案，不要编造。",
    memory,
  ].join("\n");
}
