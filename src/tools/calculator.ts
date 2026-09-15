import type { ToolDefinition } from "./registry.js";

// 不用 eval：只放行数字、四则、括号、小数点、空格，再用 Function 求值。
// 白名单先于求值，"process.exit()" 这种进不来。
const SAFE_RE = /^[\d\s+\-*/().%]+$/;

export function evaluate(expression: string): number {
  const expr = expression.trim();
  if (!expr || !SAFE_RE.test(expr)) throw new Error(`只支持数字与 + - * / % ( ) 的算式，收到：${expression}`);
  const value = new Function(`"use strict"; return (${expr});`)();
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`算式无法求值：${expression}`);
  return value;
}

export const calculatorTool: ToolDefinition = {
  name: "calculator",
  description: "计算一个算术表达式，支持 + - * / % ** 和括号。需要精确数值时必须用它，不要心算。",
  parameters: {
    type: "object",
    properties: { expression: { type: "string", description: "算式，例如 (2+3)*4" } },
    required: ["expression"],
  },
  handler: async ({ expression }) => String(evaluate(expression)),
};
