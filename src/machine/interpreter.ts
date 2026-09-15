// 通用状态表解释器：数据表 + 一个解释器，语义与 docs/product/SPEC-state-machines.md §2 D2 一致。
//   - 定义期校验：状态/事件/守卫存在、终态无出边、同格 guard 顺序合法
//   - interpret：同格多行按 guard 顺序取首条命中；未列 (state, event) = unknown，永不抛
//   - enumerate：全表逐格列出（含未列格），供契约与对账
//   - reachable：从某状态出发沿 allowed 行 BFS，给出可达状态/行与不可达项
//   - toContract：同一张表永远产出同一份 JSON（无时间戳、无函数），漂移测试对它

/** 行级：表里怎么写 */
export type Kind = "allowed" | "rejected" | "noop" | "unknown";
/** 判定级：interpret 怎么答。rejected 行命中 → blocked */
export type Verdict = "allowed" | "blocked" | "noop" | "unknown";

export interface Row<S extends string = string, E extends string = string> {
  /** 行的显式 id（`t-llm-ok` 风格），定义期查重；trace 记录与答案卷都用它，改 reason 不会漂 */
  id: string;
  from: S;
  event: E;
  to: S;
  kind: Kind;
  /** 守卫名，需在 machine.guards 里有对应函数；同格多行按定义顺序取首条命中 */
  guard?: string;
  /** rejected 行必填：被拦下的机器可读原因（如 PARSE_ERROR），进 trace 的 reject_code */
  reject_code?: string;
  reason?: string;
  priority?: "P0" | "P1" | "P2";
  /** 手写测试位置：`test/unit/<file>::<测试名>` */
  covered_by?: string[];
  /** 该转移允许触发的副作用种类（只作文档与对账，不参与解释） */
  effects?: string[];
}

export interface Invariant {
  id: string;
  text: string;
  priority: "P0" | "P1";
  status: "enforced" | "planned";
  /** enforced 时必填：`<file>::<symbol>`，契约测试会到盘上找 */
  evidence?: string[];
  /** planned 时必填：为什么还没 enforced、现在靠什么观察 */
  note?: string;
}

export interface MachineDef<S extends string, E extends string, F = unknown> {
  feature: string;
  /** 规格锚点，如 docs/SPEC.md#实现决策 → 循环 */
  anchor: string;
  initial: S;
  states: readonly S[];
  terminal: readonly S[];
  events: readonly E[];
  guards?: Record<string, (facts: F) => boolean>;
  rows: Row<S, E>[];
  invariants?: Invariant[];
}

export interface Machine<S extends string, E extends string, F = unknown> extends MachineDef<S, E, F> {
  readonly guards: Record<string, (facts: F) => boolean>;
  readonly invariants: Invariant[];
  isTerminal(state: S): boolean;
  /** 某格 (state, event) 的全部行，按定义顺序 */
  cell(state: S, event: E): Row<S, E>[];
}

export interface Interpretation<S extends string, E extends string> {
  status: Verdict;
  from: S;
  to: S;
  event: E;
  reason?: string;
  /** blocked 时 = 行的 reject_code */
  reject_code?: string;
  /** 命中的行；unknown 且未列时为空 */
  row?: Row<S, E>;
}

export interface Cell<S extends string, E extends string> {
  from: S;
  event: E;
  rows: Row<S, E>[];
  /** 表里至少列了一行（含 kind:'unknown' 的诚实声明） */
  listed: boolean;
}

export interface Reachability<S extends string, E extends string> {
  states: S[];
  rows: Row<S, E>[];
  unreachableStates: S[];
  unreachableRows: Row<S, E>[];
}

export class MachineDefinitionError extends Error {}

/** 可读的格签名 `from --EVENT[guard]--> to`：只作文档与报错，不是行的身份（身份是 row.id） */
export function rowSignature(row: Row): string {
  return `${row.from} --${row.event}${row.guard ? `[${row.guard}]` : ""}--> ${row.to}`;
}

export function defineMachine<S extends string, E extends string, F = unknown>(def: MachineDef<S, E, F>): Machine<S, E, F> {
  const fail = (msg: string) => {
    throw new MachineDefinitionError(`[${def.feature}] ${msg}`);
  };
  const guards = def.guards ?? {};
  if (def.states.length === 0) fail("states 不能为空");
  if (def.events.length === 0) fail("events 不能为空");
  if (new Set(def.states).size !== def.states.length) fail("states 有重复");
  if (new Set(def.events).size !== def.events.length) fail("events 有重复");
  if (!def.states.includes(def.initial)) fail(`initial "${def.initial}" 不在 states 里`);
  for (const t of def.terminal) if (!def.states.includes(t)) fail(`terminal "${t}" 不在 states 里`);
  if (def.terminal.includes(def.initial)) fail("initial 不能是终态");

  const seenGuardless = new Set<string>();
  const seenGuards = new Set<string>();
  const seenIds = new Set<string>();
  for (const row of def.rows) {
    const id = rowSignature(row);
    if (typeof row.id !== "string" || !row.id.trim()) fail(`行 ${id}：缺少显式 id`);
    if (seenIds.has(row.id)) fail(`行 ${id}：id "${row.id}" 重复`);
    seenIds.add(row.id);
    if (!def.states.includes(row.from)) fail(`行 ${id}：from 不在 states 里`);
    if (!def.states.includes(row.to)) fail(`行 ${id}：to 不在 states 里`);
    if (!def.events.includes(row.event)) fail(`行 ${id}：event 不在 events 里`);
    if (def.terminal.includes(row.from)) fail(`行 ${id}：终态不能有出边`);
    if (row.guard !== undefined && typeof guards[row.guard] !== "function") fail(`行 ${id}：guard "${row.guard}" 未定义`);
    if (row.kind !== "allowed" && row.to !== row.from) fail(`行 ${id}：${row.kind} 行不能改变状态（to 必须等于 from）`);
    if (row.kind === "rejected" && !row.reject_code) fail(`行 ${id}：rejected 行必须带 reject_code`);
    const cellKey = `${row.from}|${row.event}`;
    if (seenGuardless.has(cellKey)) fail(`行 ${id}：同格已有无守卫行在前，此行永远不可达`);
    if (row.guard === undefined) seenGuardless.add(cellKey);
    else {
      const gk = `${cellKey}|${row.guard}`;
      if (seenGuards.has(gk)) fail(`行 ${id}：同格重复守卫 "${row.guard}"`);
      seenGuards.add(gk);
    }
    for (const c of row.covered_by ?? []) if (!/^[^:]+::.+$/.test(c)) fail(`行 ${id}：covered_by "${c}" 应为 <file>::<测试名>`);
  }
  for (const inv of def.invariants ?? []) {
    if (inv.status === "enforced" && !(inv.evidence && inv.evidence.length)) fail(`不变量 ${inv.id}：enforced 必须带 evidence`);
    if (inv.status === "planned" && !(inv.note && inv.note.trim())) fail(`不变量 ${inv.id}：planned 必须带 note（为什么还没 enforced、现在靠什么观察）`);
    for (const e of inv.evidence ?? []) if (!/^[^:]+::.+$/.test(e)) fail(`不变量 ${inv.id}：evidence "${e}" 应为 <file>::<symbol>`);
  }

  const terminal = new Set<S>(def.terminal);
  return {
    ...def,
    guards,
    invariants: def.invariants ?? [],
    isTerminal: (s) => terminal.has(s),
    cell: (s, e) => def.rows.filter((r) => r.from === s && r.event === e),
  };
}

/** 解释一次 (state, event)。永不抛：未列组合、守卫全不命中、甚至状态/事件名不在表里都返回 unknown。 */
export function interpret<S extends string, E extends string, F>(m: Machine<S, E, F>, state: S, event: E, facts: F): Interpretation<S, E> {
  if (!m.states.includes(state)) return { status: "unknown", from: state, to: state, event, reason: `状态 "${state}" 不在表里` };
  if (!m.events.includes(event)) return { status: "unknown", from: state, to: state, event, reason: `事件 "${event}" 不在表里` };
  const rows = m.cell(state, event);
  for (const row of rows) {
    if (row.guard === undefined || m.guards[row.guard](facts)) {
      return { status: row.kind === "rejected" ? "blocked" : row.kind, from: state, to: row.to, event, reason: row.reason, reject_code: row.reject_code, row };
    }
  }
  return {
    status: "unknown",
    from: state,
    to: state,
    event,
    reason: rows.length ? `(${state}, ${event}) 有 ${rows.length} 行但守卫均未命中` : `(${state}, ${event}) 未在表里列出`,
  };
}

/** 全表逐格：状态 × 事件，含未列格。顺序 = 定义顺序，保证确定性。 */
export function enumerate<S extends string, E extends string, F>(m: Machine<S, E, F>): Cell<S, E>[] {
  const cells: Cell<S, E>[] = [];
  for (const from of m.states) {
    for (const event of m.events) {
      const rows = m.cell(from, event);
      cells.push({ from, event, rows, listed: rows.length > 0 });
    }
  }
  return cells;
}

/** 从 from（默认 initial）沿 allowed 行 BFS。非 allowed 行只要其 from 可达就算可达行。 */
export function reachable<S extends string, E extends string, F>(m: Machine<S, E, F>, from: S = m.initial): Reachability<S, E> {
  const seen = new Set<S>([from]);
  const queue: S[] = [from];
  while (queue.length) {
    const s = queue.shift()!;
    for (const row of m.rows) {
      if (row.from !== s || row.kind !== "allowed") continue;
      if (!seen.has(row.to)) {
        seen.add(row.to);
        queue.push(row.to);
      }
    }
  }
  const states = m.states.filter((s) => seen.has(s));
  const rows = m.rows.filter((r) => seen.has(r.from));
  return {
    states,
    rows,
    unreachableStates: m.states.filter((s) => !seen.has(s)),
    unreachableRows: m.rows.filter((r) => !seen.has(r.from)),
  };
}

export interface Contract {
  feature: string;
  anchor: string;
  initial: string;
  states: string[];
  terminal: string[];
  events: string[];
  guards: string[];
  rows: Array<{
    id: string;
    signature: string;
    from: string;
    event: string;
    guard: string | null;
    to: string;
    kind: Kind;
    reject_code: string | null;
    reason: string | null;
    priority: string | null;
    covered_by: string[];
    effects: string[];
  }>;
  invariants: Array<{ id: string; text: string; priority: string; status: string; evidence: string[]; note: string | null }>;
  cells: { total: number; listed: number; declared_unknown: string[]; unlisted: string[] };
  reachable: { states: string[]; unreachable_states: string[]; unreachable_rows: string[] };
}

/** 契约 = 表的纯数据投影。同表同输出；函数（guard）只留名字。 */
export function toContract<S extends string, E extends string, F>(m: Machine<S, E, F>): Contract {
  const cells = enumerate(m);
  const r = reachable(m);
  return {
    feature: m.feature,
    anchor: m.anchor,
    initial: m.initial,
    states: [...m.states],
    terminal: [...m.terminal],
    events: [...m.events],
    guards: Object.keys(m.guards),
    rows: m.rows.map((row) => ({
      id: row.id,
      signature: rowSignature(row),
      from: row.from,
      event: row.event,
      guard: row.guard ?? null,
      to: row.to,
      kind: row.kind,
      reject_code: row.reject_code ?? null,
      reason: row.reason ?? null,
      priority: row.priority ?? null,
      covered_by: [...(row.covered_by ?? [])],
      effects: [...(row.effects ?? [])],
    })),
    invariants: m.invariants.map((i) => ({ id: i.id, text: i.text, priority: i.priority, status: i.status, evidence: [...(i.evidence ?? [])], note: i.note ?? null })),
    cells: {
      total: cells.length,
      listed: cells.filter((c) => c.listed).length,
      declared_unknown: m.rows.filter((row) => row.kind === "unknown").map(rowSignature),
      unlisted: cells.filter((c) => !c.listed).map((c) => `${c.from} + ${c.event}`),
    },
    reachable: {
      states: r.states,
      unreachable_states: r.unreachableStates,
      unreachable_rows: r.unreachableRows.map(rowSignature),
    },
  };
}

export function renderContract(m: Machine<any, any, any>): string {
  return JSON.stringify(toContract(m), null, 2) + "\n";
}
