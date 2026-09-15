import { describe, it, expect } from "vitest";
import { yesterdayWindow } from "../../src/review/window.js";

// #19 ②：「昨天」= 任务时区的昨日 00:00 到今日 00:00，按计划日期算，不是「过去 24 小时」。
// 断言只打在返回的 start / end 的 ISO 值上（用户可见契约）。
const iso = (w: { start: Date; end: Date }) => [w.start.toISOString(), w.end.toISOString()];

describe("yesterdayWindow(date, tz)", () => {
  it("UTC：计划日期 2026-09-15 → [2026-09-14T00:00Z, 2026-09-15T00:00Z)", () => {
    expect(iso(yesterdayWindow("2026-09-15", "UTC"))).toEqual(["2026-09-14T00:00:00.000Z", "2026-09-15T00:00:00.000Z"]);
  });

  it("Asia/Shanghai：同一计划日期的区间整体早 8 小时（前一天 16:00Z 起）", () => {
    expect(iso(yesterdayWindow("2026-09-15", "Asia/Shanghai"))).toEqual(["2026-09-13T16:00:00.000Z", "2026-09-14T16:00:00.000Z"]);
  });

  it("Shanghai 与 UTC 同一 date 区间不同：start 相差恰好 8 小时，两者长度都是 24 小时", () => {
    const sh = yesterdayWindow("2026-09-15", "Asia/Shanghai");
    const utc = yesterdayWindow("2026-09-15", "UTC");
    expect(utc.start.getTime() - sh.start.getTime()).toBe(8 * 3600_000);
    expect(sh.end.getTime() - sh.start.getTime()).toBe(24 * 3600_000);
    expect(utc.end.getTime() - utc.start.getTime()).toBe(24 * 3600_000);
  });

  it("Shanghai 凌晨 00:30 的消息归今天不归昨天；昨天 23:30 与昨天 00:30 都在区间内", () => {
    const w = yesterdayWindow("2026-09-15", "Asia/Shanghai");
    const inWin = (s: string) => Date.parse(s) >= w.start.getTime() && Date.parse(s) < w.end.getTime();
    expect(inWin("2026-09-15T00:30:00+08:00")).toBe(false);
    expect(inWin("2026-09-14T23:30:00+08:00")).toBe(true);
    expect(inWin("2026-09-14T00:30:00+08:00")).toBe(true);
    expect(inWin("2026-09-13T23:59:59+08:00")).toBe(false);
  });

  it("跨月：2026-03-01 的昨天是 2026-02-28（UTC 与 Shanghai 各自正确）", () => {
    expect(iso(yesterdayWindow("2026-03-01", "UTC"))).toEqual(["2026-02-28T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
    expect(iso(yesterdayWindow("2026-03-01", "Asia/Shanghai"))).toEqual(["2026-02-27T16:00:00.000Z", "2026-02-28T16:00:00.000Z"]);
  });

  it("跨年：2027-01-01 的昨天是 2026-12-31", () => {
    expect(iso(yesterdayWindow("2027-01-01", "UTC"))).toEqual(["2026-12-31T00:00:00.000Z", "2027-01-01T00:00:00.000Z"]);
    expect(iso(yesterdayWindow("2027-01-01", "Asia/Shanghai"))).toEqual(["2026-12-30T16:00:00.000Z", "2026-12-31T16:00:00.000Z"]);
  });

  it("夏令时切换日（America/New_York 2026-03-08）：区间按当地墙钟 00:00 取，长度是 23 小时而不是 24", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT；昨天 = 03-08 00:00 EST (05:00Z)，今天 = 03-09 00:00 EDT (04:00Z)
    expect(iso(yesterdayWindow("2026-03-09", "America/New_York"))).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
  });

  it("坏输入直接抛：不是 YYYY-MM-DD、不存在的日期、不存在的时区", () => {
    expect(() => yesterdayWindow("2026/09/15", "UTC")).toThrow();
    expect(() => yesterdayWindow("2026-02-30", "UTC")).toThrow();
    expect(() => yesterdayWindow("2026-09-15", "Mars/Olympus")).toThrow();
  });
});
