import { interpret, type Machine, type Row } from "./interpreter.js";

// 自动 E2E 的前半段（docs/product/SPEC-state-machines.md §5）：
// 从表 + runner 协议 BFS 出所有到终态的事件路径，每条路径 = 期望转移序列（答案卷）+ 走过的行。
// 不让 LLM 写用例：路径→FakeLLM 脚本的绑定在测试侧完成（test/unit/generator.test.ts）。

export interface RunnerProtocol<S extends string, E extends string, F> {
  initialFacts(): F;
  advance(facts: F, event: E): F;
  /** runner 在某状态、上一事件之后可能发出的事件 */
  next(state: S, last: E | undefined): E[];
}

export interface GeneratedPath<S extends string, E extends string> {
  id: string;
  events: E[];
  /** 答案卷：行 id 序列，非 allowed 追加 ` [status]`；与 MemoryTraceSink.sequence() 同格式 */
  expected: string[];
  /** 纯行 id 序列（不带 status），与 contracts/journeys.json 的 expect 同格式 */
  rowIds: string[];
  rows: Row<S, E>[];
  terminal: S;
}

export interface Gap<S extends string, E extends string> {
  state: S;
  event: E;
  after: E[];
  reason?: string;
}

export interface GenerationResult<S extends string, E extends string> {
  paths: GeneratedPath<S, E>[];
  /** runner 会发出、但表没列（或守卫全不命中）的组合——表与代码漂了 */
  gaps: Gap<S, E>[];
  /** 生成路径走过的行 id（去重，按定义顺序） */
  rowsUsed: string[];
}

export function generatePaths<S extends string, E extends string, F>(
  m: Machine<S, E, F>,
  protocol: RunnerProtocol<S, E, F>,
  opts: { maxDepth?: number } = {},
): GenerationResult<S, E> {
  const maxDepth = opts.maxDepth ?? 64;
  const paths: GeneratedPath<S, E>[] = [];
  const gaps: Gap<S, E>[] = [];
  const used = new Set<string>();

  interface Node { state: S; facts: F; last: E | undefined; events: E[]; expected: string[]; rows: Row<S, E>[] }
  const queue: Node[] = [{ state: m.initial, facts: protocol.initialFacts(), last: undefined, events: [], expected: [], rows: [] }];
  const toPath = (n: Node): GeneratedPath<S, E> => ({ id: n.events.join(" > "), events: n.events, expected: n.expected, rowIds: n.rows.map((r) => r.id), rows: n.rows, terminal: n.state });

  while (queue.length) {
    const n = queue.shift()!;
    if (m.isTerminal(n.state)) {
      paths.push(toPath(n));
      continue;
    }
    if (n.events.length >= maxDepth) throw new Error(`路径超过 ${maxDepth} 步仍未到终态：${n.events.join(" > ")}`);
    const candidates = protocol.next(n.state, n.last);
    if (candidates.length === 0) throw new Error(`runner 协议在非终态 ${n.state}（上一事件 ${n.last}）没有可发出的事件`);
    for (const event of candidates) {
      const facts = protocol.advance(n.facts, event);
      const t = interpret(m, n.state, event, facts);
      if (t.status === "unknown") {
        gaps.push({ state: n.state, event, after: n.events, reason: t.reason });
        continue;
      }
      if (t.row) used.add(t.row.id);
      queue.push({
        state: t.to,
        facts,
        last: event,
        events: [...n.events, event],
        expected: [...n.expected, `${t.row!.id}${t.status === "allowed" ? "" : ` [${t.status}]`}`],
        rows: t.row ? [...n.rows, t.row] : n.rows,
      });
    }
  }
  return { paths, gaps, rowsUsed: m.rows.map((r) => r.id).filter((id) => used.has(id)) };
}
