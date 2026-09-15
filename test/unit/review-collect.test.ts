import { describe, it, expect } from "vitest";
import { collectYesterday } from "../../src/review/collect.js";
import { yesterdayWindow } from "../../src/review/window.js";
import type { TranscriptLine, TranscriptReader } from "../../src/review/types.js";

// #19 ⑥：三态分开——full / partial / none；partial_read 不得冒充 no_chat。
// 夹具实现 TranscriptReader（R1 的真实存储另一分支实现，这里只依赖最小接口）。
type Fixture = Record<string, Record<string, TranscriptLine[] | null>>;
const fixture = (data: Fixture): TranscriptReader => ({
  list: (u) => Object.keys(data[u] ?? {}),
  read: (u, s) => (data[u] && s in data[u] ? data[u][s] : null),
});
let seq = 0;
const line = (sessionId: string, ts: string, role: TranscriptLine["role"] = "user", content = `m${++seq}`): TranscriptLine => ({
  ts,
  userId: "u1",
  sessionId,
  turn: 1,
  traceId: `t-${seq}`,
  role,
  content,
});

// 计划日期 2026-09-15、Asia/Shanghai：昨天 = 09-14 00:00+08 .. 09-15 00:00+08
const W = yesterdayWindow("2026-09-15", "Asia/Shanghai");

describe("collectYesterday(reader, userId, window)", () => {
  it("只收 ts 落在 [start, end) 内的行；区间外的行不带出来；有行且无读失败 → full", () => {
    const keep1 = line("s1", "2026-09-14T09:00:00+08:00", "user", "早上好");
    const keep2 = line("s1", "2026-09-14T09:00:05+08:00", "assistant", "早");
    const drop = line("s1", "2026-09-13T22:00:00+08:00", "user", "前天的");
    const r = collectYesterday(fixture({ u1: { s1: [drop, keep1, keep2] } }), "u1", W);
    expect(r.coverage).toBe("full");
    expect(r.unreadable).toEqual([]);
    expect(r.sessions).toEqual([{ sessionId: "s1", lines: [keep1, keep2] }]);
  });

  it("只选出有行落在区间内的会话：整段都在区间外的会话不出现在 sessions 里", () => {
    const yesterday = line("s-y", "2026-09-14T15:00:00+08:00");
    const older = line("s-old", "2026-09-10T15:00:00+08:00");
    const r = collectYesterday(fixture({ u1: { "s-old": [older], "s-y": [yesterday] } }), "u1", W);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["s-y"]);
    expect(r.coverage).toBe("full");
  });

  it("边界：今天凌晨 00:30 的行归今天不归昨天；昨天 00:30 与 23:30 归昨天；end 本身不含", () => {
    const today0030 = line("s1", "2026-09-15T00:30:00+08:00", "user", "今天的");
    const y0030 = line("s1", "2026-09-14T00:30:00+08:00", "user", "昨天凌晨");
    const y2330 = line("s1", "2026-09-14T23:30:00+08:00", "user", "昨天深夜");
    const endExact = line("s1", "2026-09-15T00:00:00+08:00", "user", "恰好 end");
    const r = collectYesterday(fixture({ u1: { s1: [y0030, y2330, endExact, today0030] } }), "u1", W);
    expect(r.sessions[0].lines.map((l) => l.content)).toEqual(["昨天凌晨", "昨天深夜"]);
  });

  it("某会话 read 返回 null（转写缺失 / 读不出）→ 计入 unreadable，coverage 至少 partial，其余会话照常取", () => {
    const ok = line("s-ok", "2026-09-14T10:00:00+08:00");
    const r = collectYesterday(fixture({ u1: { "s-ok": [ok], "s-broken": null } }), "u1", W);
    expect(r.coverage).toBe("partial");
    expect(r.unreadable).toEqual(["s-broken"]);
    expect(r.sessions).toEqual([{ sessionId: "s-ok", lines: [ok] }]);
  });

  it("有读不出的会话且一条区间内的行都没有 → 仍是 partial，不得冒充 none（partial_read ≠ no_chat）", () => {
    const r = collectYesterday(fixture({ u1: { "s-broken": null } }), "u1", W);
    expect(r.coverage).toBe("partial");
    expect(r.sessions).toEqual([]);
    expect(r.unreadable).toEqual(["s-broken"]);
  });

  it("行的 ts 缺失或解析不出 → 该会话读不出时间，计入 unreadable → partial", () => {
    const bad = { ...line("s-nots", "2026-09-14T10:00:00+08:00"), ts: "" } as TranscriptLine;
    const garbage = { ...line("s-garbage", "2026-09-14T10:00:00+08:00"), ts: "昨天下午" } as TranscriptLine;
    const good = line("s-good", "2026-09-14T10:00:00+08:00");
    const r = collectYesterday(fixture({ u1: { "s-nots": [bad], "s-garbage": [garbage], "s-good": [good] } }), "u1", W);
    expect(r.coverage).toBe("partial");
    expect(r.unreadable.sort()).toEqual(["s-garbage", "s-nots"]);
    expect(r.sessions.map((s) => s.sessionId)).toEqual(["s-good"]);
  });

  it("没有任何会话、或所有会话都没有区间内的行，且无读失败 → none，sessions 空", () => {
    expect(collectYesterday(fixture({}), "u1", W)).toEqual({ sessions: [], coverage: "none", unreadable: [] });
    const old = line("s1", "2026-09-01T10:00:00+08:00");
    expect(collectYesterday(fixture({ u1: { s1: [old] } }), "u1", W)).toEqual({ sessions: [], coverage: "none", unreadable: [] });
  });

  it("只取该用户的会话：别的用户昨天聊过不算", () => {
    const other = line("s-other", "2026-09-14T10:00:00+08:00");
    const r = collectYesterday(fixture({ u2: { "s-other": [other] } }), "u1", W);
    expect(r).toEqual({ sessions: [], coverage: "none", unreadable: [] });
  });
});
