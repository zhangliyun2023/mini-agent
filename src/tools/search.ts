import type { ToolDefinition } from "./registry.js";

// mock 搜索：一小份本地语料，按关键词命中数排序。
// 真接搜索引擎时只换 handler，schema 与 compact 不动。
const CORPUS: Array<{ title: string; snippet: string }> = [
  { title: "上海今日天气", snippet: "上海 9 月 15 日多云转晴，24-30℃，东南风 3 级。" },
  { title: "北京今日天气", snippet: "北京 9 月 15 日晴，18-27℃，空气质量优。" },
  { title: "TypeScript 5.9 发布说明", snippet: "TypeScript 5.9 引入 --module node20、import defer 等特性。" },
  { title: "Node.js 24 LTS", snippet: "Node.js 24 于 2025 年 10 月进入 LTS，内置 fetch 与 WebSocket 稳定。" },
  { title: "Agent Loop 是什么", snippet: "Agent Loop：模型决定是否调用工具 → 执行 → 结果回填 context → 再判断，直到给出最终答案。" },
  { title: "上海地铁运营时间", snippet: "上海地铁大部分线路 5:30 首班、23:00 前后末班，节假日有延长。" },
  { title: "咖啡因半衰期", snippet: "成人体内咖啡因半衰期约 5 小时，下午 3 点后饮用可能影响睡眠。" },
];

export const searchTool: ToolDefinition = {
  name: "search",
  description: "搜索公开信息（天气、新闻、常识）。返回最多 3 条标题+摘要。",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "搜索关键词" } },
    required: ["query"],
  },
  handler: async ({ query }) => {
    const terms = String(query).split(/\s+/).filter(Boolean);
    const scored = CORPUS.map((doc) => ({
      doc,
      score: terms.filter((t) => (doc.title + doc.snippet).includes(t)).length,
    }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (scored.length === 0) return `没有找到与「${query}」相关的结果。`;
    return scored.map(({ doc }) => `- ${doc.title}：${doc.snippet}`).join("\n");
  },
  // 搜索结果本来就短，精简 = 原样；真接搜索引擎时这里改成只留 title+snippet
  compact: (raw) => raw,
};
