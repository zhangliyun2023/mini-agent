/**
 * 表驱动状态机解释器（TS 版，语义与 adopt-ai-era 的 machine.example.mjs 一致）。
 * 表是产品定义；这是唯一解释器，被 runtime、生成器、契约投影、测试共用。
 *
 * - interpret(state, event, facts)：同格多行按表顺序取第一条 guard 命中；没有行 → unknown（UNMODELED），状态停留。
 * - guard 是对机器自维护 facts 的具名谓词——不读盘、不读外部响应。
 * - kind：allowed（可改状态）/ rejected（blocked，停留，带 reject_code）/ noop（停留，无副作用）。
 * - 一切在定义期校验：表里的笔误是启动错误，不是运行时静默 unknown。
 */

export type Kind = "allowed" | "rejected" | "noop";
export type Status = "allowed" | "blocked" | "noop" | "unknown";
export type Enforcement = "enforced" | "planned";

export interface StateDef {
  terminal?: boolean;
  /** 用户可见含义（字符串）或 false */
  ui?: string | false;
  /** modeled = 代码会写这个状态；unknown = 规格里有、代码从不写（诚实标注，豁免可达性） */
  kind?: "modeled" | "unknown";
  /** 机器起点，不是持久化字段的值 */
  virtual?: boolean;
  note?: string;
  meaning?: string;
}

export interface Transition<F> {
  id: string;
  from: string;
  event: string;
  guard?: string | string[];
  to: string;
  kind: Kind;
  reject_code?: string;
  effects?: Record<string, unknown>;
  invariants?: string[];
  p0?: boolean;
  allow?: string;
  forbid?: string;
  oracle?: string;
  note?: string;
  drive?: string;
  fixture?: string;
  covered_by?: string[];
  _facts?: F; // 仅用于类型推导
}

export interface Invariant {
  text: string;
  enforcement: Enforcement;
  evidence?: string[];
  note?: string;
}

export interface MachineDef<F = Record<string, unknown>> {
  feature: string;
  status?: string;
  anchor: string;
  note?: string | null;
  doc?: string;
  initial?: string;
  states: Record<string, StateDef>;
  events: readonly string[];
  guards?: Record<string, (facts: F) => boolean>;
  transitions: Transition<F>[];
  invariants?: Record<string, Invariant>;
}

export interface Verdict {
  status: Status;
  id: string | null;
  from: string;
  to: string;
  event: string;
  reason: string | null;
  effects: Record<string, unknown>;
  invariants: string[];
  oracle: string | null;
  allow?: string | null;
  forbid?: string | null;
}

const KINDS = new Set<Kind>(["allowed", "rejected", "noop"]);
const guardNames = (spec?: string | string[]) => ([] as string[]).concat(spec ?? []).map((g) => (g.startsWith("!") ? g.slice(1) : g));

export function defineMachine<F = Record<string, unknown>>(def: MachineDef<F>) {
  const { feature, status = "active", anchor, note = null, doc, states, events, guards = {}, transitions, invariants = {}, initial } = def;
  if (!feature || !anchor) throw new Error("machine 必须有 feature 与 anchor");
  const stateNames = Object.keys(states);
  if (!stateNames.length) throw new Error("machine 至少一个状态");
  const eventSet = new Set(events);
  const ids = new Set<string>();
  for (const t of transitions) {
    if (!t.id) throw new Error(`${feature}: 转移缺 id`);
    if (ids.has(t.id)) throw new Error(`${feature}: 重复的转移 id ${t.id}`);
    ids.add(t.id);
    if (!states[t.from]) throw new Error(`${feature}/${t.id}: 未知状态 from=${t.from}`);
    if (!states[t.to]) throw new Error(`${feature}/${t.id}: 未知状态 to=${t.to}`);
    if (!eventSet.has(t.event)) throw new Error(`${feature}/${t.id}: 未知事件 ${t.event}`);
    if (!KINDS.has(t.kind)) throw new Error(`${feature}/${t.id}: kind 无效 ${t.kind}`);
    for (const g of guardNames(t.guard)) if (typeof guards[g] !== "function") throw new Error(`${feature}/${t.id}: 未知 guard ${g}`);
    for (const inv of t.invariants ?? []) if (!invariants[inv]) throw new Error(`${feature}/${t.id}: 未知不变量 ${inv}`);
    if (t.kind !== "allowed" && t.to !== t.from) throw new Error(`${feature}/${t.id}: ${t.kind} 转移必须停留在原状态`);
  }
  for (const [id, inv] of Object.entries(invariants)) {
    if (inv.enforcement !== "enforced" && inv.enforcement !== "planned") throw new Error(`${feature}/${id}: 不变量缺 enforcement`);
    if (inv.enforcement === "enforced" && !inv.evidence?.length) throw new Error(`${feature}/${id}: enforced 不变量必须有 evidence`);
    if (inv.enforcement === "planned" && !inv.note) throw new Error(`${feature}/${id}: planned 不变量必须写 note`);
  }
  const byCell = new Map<string, Transition<F>[]>();
  for (const t of transitions) {
    const k = `${t.from} ${t.event}`;
    if (!byCell.has(k)) byCell.set(k, []);
    byCell.get(k)!.push(t);
  }
  const guardHolds = (spec: string | string[] | undefined, facts: F) => {
    for (const g of ([] as string[]).concat(spec ?? [])) {
      const neg = g.startsWith("!");
      const v = !!guards[neg ? g.slice(1) : g](facts);
      if (neg ? v : !v) return false;
    }
    return true;
  };

  function interpret(state: string, event: string, facts: F = {} as F): Verdict {
    if (!states[state]) throw new Error(`${feature}: 未知状态 ${state}`);
    if (!eventSet.has(event)) throw new Error(`${feature}: 未知事件 ${event}`);
    const hit = (byCell.get(`${state} ${event}`) ?? []).find((t) => guardHolds(t.guard, facts));
    if (!hit) return { status: "unknown", id: null, from: state, to: state, event, reason: "UNMODELED", effects: {}, invariants: [], oracle: "未知转移必须可观测，不得静默吞掉。" };
    const st: Status = hit.kind === "allowed" ? "allowed" : hit.kind === "rejected" ? "blocked" : "noop";
    return { status: st, id: hit.id, from: state, to: hit.to, event, reason: hit.reject_code ?? null, effects: hit.effects ?? {}, invariants: hit.invariants ?? [], oracle: hit.oracle ?? null, allow: hit.allow ?? null, forbid: hit.forbid ?? null };
  }

  function enumerate() {
    const grid: Array<{ from: string; event: string; status: "modeled" | "unknown"; rows: Array<{ id: string; kind: Kind; guard: string | string[] | null; to: string }> }> = [];
    for (const s of stateNames)
      for (const e of events) {
        const rows = byCell.get(`${s} ${e}`) ?? [];
        grid.push({ from: s, event: e, status: rows.length ? "modeled" : "unknown", rows: rows.map((r) => ({ id: r.id, kind: r.kind, guard: r.guard ?? null, to: r.to })) });
      }
    return grid;
  }

  function reachable(start: string = initial ?? stateNames[0]) {
    const seen = new Set([start]);
    const rows = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const s = queue.shift()!;
      for (const t of transitions) {
        if (t.from !== s) continue;
        rows.add(t.id);
        if (t.kind === "allowed" && !seen.has(t.to)) {
          seen.add(t.to);
          queue.push(t.to);
        }
      }
    }
    const unreachable = new Set(stateNames.filter((s) => !seen.has(s) && (states[s].kind ?? "modeled") === "modeled"));
    return { states: seen, rows, unreachable };
  }

  /** 契约 JSON：确定性，同表同输出；盘上文件与它不一致即漂移 */
  function toContract() {
    const c: Record<string, unknown> & { states: Record<string, unknown>; transitions: unknown[]; invariants: unknown[] } = {
      feature, status, anchor, generated_by: "contracts/machine.ts", note, ...(doc ? { doc } : {}),
      initial: initial ?? stateNames[0], machine_events: [...events], states: {}, transitions: [], invariants: [],
    };
    for (const [name, st] of Object.entries(states))
      c.states[name] = { kind: st.kind ?? "modeled", terminal: !!st.terminal, ui: st.ui !== undefined ? !!st.ui : false, meaning: typeof st.ui === "string" ? st.ui : st.meaning ?? null, ...(st.virtual ? { virtual: true } : {}), ...(st.note ? { note: st.note } : {}) };
    for (const t of transitions) {
      const out: Record<string, unknown> = { id: t.id, kind: t.kind, event: t.event, from: t.from, to: t.kind === "allowed" ? t.to : null, p0: !!t.p0 };
      if (t.guard) out.guard = Array.isArray(t.guard) ? t.guard.join(" && ") : t.guard;
      for (const k of ["reject_code", "effects", "invariants", "allow", "forbid", "note", "covered_by", "drive", "fixture"] as const) {
        const v = t[k];
        if (v !== undefined && !(Array.isArray(v) && v.length === 0)) out[k] = v;
      }
      c.transitions.push(out);
    }
    for (const [id, inv] of Object.entries(invariants))
      c.invariants.push({ id, enforcement: inv.enforcement, text: inv.text, ...(inv.evidence ? { evidence: inv.evidence } : {}), ...(inv.note ? { note: inv.note } : {}) });
    return c;
  }

  return { feature, states, events, initial: initial ?? stateNames[0], transitions, invariants, interpret, enumerate, reachable, toContract };
}

export type Machine<F = Record<string, unknown>> = ReturnType<typeof defineMachine<F>>;
