// #19 ②：「昨天」= 任务时区的昨日 00:00 到今日 00:00，按计划日期算，不按执行时刻。
// 只用 Intl.DateTimeFormat（标准库），不引时区库。

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 某一瞬间在 tz 里的墙钟时间各字段 */
function wallClock(instant: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const { type, value } of fmt.formatToParts(instant)) if (type !== "literal") p[type] = Number(value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** tz 里 y-m-d 当地 00:00 对应的 UTC 瞬间（m 从 1 起；d 可以为 0 / 负数，由 Date.UTC 归一化以跨月跨年） */
function zonedMidnight(y: number, m: number, d: number, tz: string): Date {
  const wanted = Date.UTC(y, m - 1, d);
  // 先把「当地墙钟 = wanted」当作 UTC 猜一次，再按实际偏移修正；迭代两次以覆盖夏令时切换日
  let t = wanted;
  for (let i = 0; i < 2; i++) t = wanted - (wallClock(new Date(t), tz) - t);
  return new Date(t);
}

export type Window = { start: Date; end: Date };

/**
 * 计划日期 date（今天）在 tz 里的「昨天」：[前一天 00:00, 当天 00:00)。
 * 坏日期字符串、不存在的日期、不存在的时区都抛。
 */
export function yesterdayWindow(date: string, tz: string): Window {
  const m = DATE_RE.exec(date);
  if (!m) throw new Error(`计划日期必须是 YYYY-MM-DD：${date}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) !== date) throw new Error(`不存在的日期：${date}`);
  // 不存在的时区：Intl 构造时抛 RangeError，直接向上抛
  new Intl.DateTimeFormat("en-US", { timeZone: tz });
  return { start: zonedMidnight(y, mo, d - 1, tz), end: zonedMidnight(y, mo, d, tz) };
}
