// #19 ⑥：按用户列会话，只收 ts 落在 [start, end) 内的转写行，按会话分组；三态覆盖分开。
import type { Coverage, TranscriptLine, TranscriptReader } from "./types.js";
import type { Window } from "./window.js";

export type CollectResult = {
  sessions: Array<{ sessionId: string; lines: TranscriptLine[] }>;
  /** full = 有区间内的行且全部读得出；partial = 有会话读不出（文件缺失 / 读不出 / 行没有可解析的 ts）；none = 一条都没有且没有读失败 */
  coverage: Coverage;
  /** 读不出的会话 id；非空时 coverage 至少 partial，不得冒充 none */
  unreadable: string[];
};

export function collectYesterday(reader: TranscriptReader, userId: string, window: Window): CollectResult {
  const start = window.start.getTime();
  const end = window.end.getTime();
  const sessions: CollectResult["sessions"] = [];
  const unreadable: string[] = [];
  for (const sessionId of reader.list(userId)) {
    const lines = reader.read(userId, sessionId);
    if (lines === null) {
      unreadable.push(sessionId);
      continue;
    }
    const stamps = lines.map((l) => Date.parse(l.ts));
    if (stamps.some((t) => Number.isNaN(t))) {
      // 有行读不出时间 → 无法判定它属不属于昨天，整个会话按读不出算（⑥：partial_read 写明覆盖范围）
      unreadable.push(sessionId);
      continue;
    }
    const picked = lines.filter((_, i) => stamps[i] >= start && stamps[i] < end);
    if (picked.length > 0) sessions.push({ sessionId, lines: picked });
  }
  const coverage: Coverage = unreadable.length > 0 ? "partial" : sessions.length > 0 ? "full" : "none";
  return { sessions, coverage, unreadable };
}
