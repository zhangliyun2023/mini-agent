import { describe, it, expect } from "vitest";
import { present, type TranscriptLine } from "../../src/review/present.js";
import type { Consolidation, Highlight } from "../../src/review/types.js";

// #19 ⑤ 呈现门槛：纯函数，不碰存储、不碰模型。
// 断言只打用户可见契约：brief.text 精确文本 / brief 为 null / dropped 与 warnings 的内容。
const src = { sessionId: "w1", turn: 3 };
const line = (turn: number, role: TranscriptLine["role"], content: string): TranscriptLine => ({
  ts: `2026-09-14T1${turn}:00:00.000Z`, userId: "A", sessionId: "w1", turn, traceId: `t${turn}`, role, content,
});
const yesterday: TranscriptLine[] = [
  line(1, "user", "今天天气不错，聊聊天"),
  line(1, "assistant", "好呀，想聊什么"),
  line(2, "user", "帮我记一下：周一要把发票交给财务，不然报销要拖到下个月了"),
  line(2, "assistant", "记住了：周一交发票给财务"),
  line(3, "user", "PR #19 今晚合不完，明天继续"),
  line(3, "assistant", "好的，明天继续"),
];
const cons = (highlights: Highlight[], warnings: string[] = []): Consolidation => ({ entries: [], highlights, method: "llm", warnings });

describe("present：呈现门槛（#19 ⑤）", () => {
  it("有 due_today 的亮点 → brief 一条，文本带「今天到期：」前缀，不加寒暄", () => {
    const r = present(cons([{ text: "把发票交给财务", why_today: "due_today", source: src }]), yesterday);
    expect(r.brief).toEqual({ highlights: [{ text: "把发票交给财务", why_today: "due_today", source: src }], text: "今天到期：把发票交给财务" });
    expect(r.dropped).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("三种 why_today 各一条 → 每条一行、前缀各异、保持输入顺序", () => {
    const r = present(cons([
      { text: "PR #19 收尾合并", why_today: "unfinished", source: src },
      { text: "把发票交给财务", why_today: "due_today", source: { sessionId: "w1", turn: 2 } },
      { text: "去健身房", why_today: "planned_today", source: src },
    ]), yesterday);
    expect(r.brief?.text).toBe("昨天没收尾：PR #19 收尾合并\n今天到期：把发票交给财务\n你说过今天要：去健身房");
    expect(r.brief?.highlights.map((h) => h.why_today)).toEqual(["unfinished", "due_today", "planned_today"]);
  });

  it("只有闲聊：highlights 为空 → brief 为 null，不丢不警", () => {
    const r = present(cons([]), yesterday);
    expect(r).toEqual({ brief: null, dropped: [], warnings: [] });
  });

  it("亮点都没有合法 why_today（缺失 / 表外值）→ 全部丢弃并记 reason，brief 为 null", () => {
    const bad = [
      { text: "聊了天气", source: src } as unknown as Highlight,
      { text: "聊了天气", why_today: "chitchat", source: src } as unknown as Highlight,
    ];
    const r = present(cons(bad), yesterday);
    expect(r.brief).toBeNull();
    expect(r.dropped.map((d) => d.reason)).toEqual(["missing_why_today", "invalid_why_today:chitchat"]);
    expect(r.dropped.map((d) => d.highlight)).toEqual(bad);
  });

  it("缺 source（没有 / 不是 {sessionId, turn}）→ 丢弃并记 reason，其余保留", () => {
    const noSource = { text: "去健身房", why_today: "planned_today" } as unknown as Highlight;
    const badSource = { text: "去健身房", why_today: "planned_today", source: { sessionId: "w1" } } as unknown as Highlight;
    const r = present(cons([noSource, badSource, { text: "把发票交给财务", why_today: "due_today", source: src }]), yesterday);
    expect(r.dropped).toEqual([{ highlight: noSource, reason: "missing_source" }, { highlight: badSource, reason: "missing_source" }]);
    expect(r.brief?.text).toBe("今天到期：把发票交给财务");
  });

  it("不复述原话：亮点与昨天某行逐字重合（去空白后相等）→ 过滤并 warning，其余保留", () => {
    const copied: Highlight = { text: "记住了：周一交发票 给财务 ", why_today: "due_today", source: { sessionId: "w1", turn: 2 } };
    const r = present(cons([copied, { text: "把发票交给财务", why_today: "due_today", source: src }]), yesterday);
    expect(r.brief?.text).toBe("今天到期：把发票交给财务");
    expect(r.dropped).toEqual([{ highlight: copied, reason: "verbatim" }]);
    expect(r.warnings).toEqual(["亮点「记住了：周一交发票 给财务 」与昨天 w1 第 2 轮 assistant 的原话逐字重合，已过滤"]);
  });

  it("不复述原话：亮点是某行 ≥ 20 字的连续子串 → 过滤；< 20 字的子串放行", () => {
    const long: Highlight = { text: "周一要把发票交给财务，不然报销要拖到下个月", why_today: "due_today", source: { sessionId: "w1", turn: 2 } };
    const short: Highlight = { text: "PR #19 今晚合不完", why_today: "unfinished", source: src };
    const r = present(cons([long, short]), yesterday);
    expect(r.brief?.text).toBe("昨天没收尾：PR #19 今晚合不完");
    expect(r.dropped).toEqual([{ highlight: long, reason: "verbatim" }]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("与昨天 w1 第 2 轮 user 的原话逐字重合");
  });

  it("所有亮点都被门槛拦下 → brief 为 null，dropped 与 warnings 仍如实记录；上游 warnings 原样带出", () => {
    const copied: Highlight = { text: "好的，明天继续", why_today: "unfinished", source: src };
    const r = present(cons([copied], ["upstream: rule fallback"]), yesterday);
    expect(r.brief).toBeNull();
    expect(r.dropped).toEqual([{ highlight: copied, reason: "verbatim" }]);
    expect(r.warnings[0]).toBe("upstream: rule fallback");
    expect(r.warnings).toHaveLength(2);
  });
});
