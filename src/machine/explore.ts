import { interpret, type Machine } from "./interpreter.js";

// 模型层随机探索（S3.5 / B2）：只用表 + interpret，不跑 runtime。
// 带种子的随机游走：每步随机挑一个事件 + 一组随机 guard 取值（guard 的取值域 = 布尔），interpret 后检查通用不变量：
//   modeled-cell-never-unknown  表里列了行的格，不论 guard 怎么取都不得返回 unknown（否则是 guard 洞：只有守卫行、没有兜底）
//   stay-on-non-allowed         blocked / noop / unknown 必须停留在原状态
//   allowed-lands-modeled       allowed 必须命中一行且落在表里声明的状态
//   terminal-absorbing          到了终态，任何事件都出不去（本仓保留「终态无出边」，拍板①）
// 红了就 ddmin 把事件序列缩到最短复现；同一 seed 永远同一结果。

export interface Step<E extends string = string> {
  event: E;
  /** 这一步各 guard 的取值 */
  guards: Record<string, boolean>;
}

export interface Violation<S extends string = string, E extends string = string> {
  invariant: "modeled-cell-never-unknown" | "stay-on-non-allowed" | "allowed-lands-modeled" | "terminal-absorbing";
  message: string;
  /** 从 initial 起到出问题那一步（含）的序列，可直接回放 */
  steps: Step<E>[];
  state: S;
}

export interface ExploreOptions {
  seed: number;
  /** 随机游走条数 */
  walks?: number;
  /** 每条最多走几步 */
  maxSteps?: number;
}

export interface ExploreResult<S extends string = string, E extends string = string> {
  feature: string;
  seed: number;
  walks: number;
  stepsTaken: number;
  violations: Violation<S, E>[];
  /** 第一条违反经 ddmin 缩减后的最短复现；没有违反时为空 */
  minimal?: Violation<S, E>;
  rowsHit: string[];
  rowsNeverHit: string[];
}

/** mulberry32：够用的带种子 PRNG，同 seed 同序列 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** guard 的取值域是布尔：把表里的 guard 函数换成「查这一步的取值表」，其余不动 */
function probeMachine<S extends string, E extends string>(m: Machine<S, E, any>): Machine<S, E, Record<string, boolean>> {
  const guards = Object.fromEntries(Object.keys(m.guards).map((g) => [g, (f: Record<string, boolean>) => f[g] === true]));
  return { ...m, guards };
}

/** 回放一段序列：返回第一条违反（没有则 null）与终点状态、命中的行 */
export function replay<S extends string, E extends string>(m: Machine<S, E, any>, steps: Step<E>[]): { violation: Violation<S, E> | null; state: S; rowsHit: Set<string> } {
  const probe = probeMachine(m);
  let state: S = m.initial;
  const rowsHit = new Set<string>();
  const fail = (invariant: Violation["invariant"], message: string, i: number): Violation<S, E> => ({ invariant, message, steps: steps.slice(0, i + 1), state });
  for (const [i, step] of steps.entries()) {
    const t = interpret(probe, state, step.event, step.guards);
    if (t.row) rowsHit.add(t.row.id);
    const listed = m.cell(state, step.event);
    if (m.isTerminal(state)) {
      if (t.to !== state || t.status === "allowed") return { violation: fail("terminal-absorbing", `终态 ${state} 收到 ${step.event} 竟然 ${t.status} → ${t.to}`, i), state, rowsHit };
      continue;
    }
    if (t.status === "unknown" && !t.row && listed.length > 0) {
      return { violation: fail("modeled-cell-never-unknown", `(${state}, ${step.event}) 表里列了 ${listed.length} 行，guard 取值 ${JSON.stringify(step.guards)} 时却 unknown：只有守卫行、没有无守卫兜底`, i), state, rowsHit };
    }
    if (t.status !== "allowed" && t.to !== state) return { violation: fail("stay-on-non-allowed", `${t.status} 转移不该改状态：${state} → ${t.to}`, i), state, rowsHit };
    if (t.status === "allowed" && (!t.row || !m.states.includes(t.to))) return { violation: fail("allowed-lands-modeled", `allowed 却落在表外状态 ${t.to}`, i), state, rowsHit };
    state = t.to;
  }
  return { violation: null, state, rowsHit };
}

/** 经典 ddmin（Zeller）：在保持 test(sub)=true 的前提下把序列缩到 1-minimal */
export function ddmin<T>(input: T[], test: (sub: T[]) => boolean): T[] {
  let cur = input;
  let n = 2;
  while (cur.length >= 2) {
    const size = Math.ceil(cur.length / n);
    const chunks: T[][] = [];
    for (let i = 0; i < cur.length; i += size) chunks.push(cur.slice(i, i + size));
    let reduced = false;
    for (const chunk of chunks) {
      if (test(chunk)) { cur = chunk; n = 2; reduced = true; break; }
    }
    if (reduced) continue;
    if (n > 2 || chunks.length > 2) {
      for (const chunk of chunks) {
        const complement = cur.filter((x) => !chunk.includes(x));
        if (complement.length && test(complement)) { cur = complement; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (reduced) continue;
    if (n >= cur.length) break;
    n = Math.min(n * 2, cur.length);
  }
  return cur;
}

export function explore<S extends string, E extends string>(m: Machine<S, E, any>, opts: ExploreOptions): ExploreResult<S, E> {
  const rnd = prng(opts.seed);
  const walks = opts.walks ?? 200;
  const maxSteps = opts.maxSteps ?? 30;
  const guardNames = Object.keys(m.guards);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const randomStep = (): Step<E> => ({ event: pick(m.events), guards: Object.fromEntries(guardNames.map((g) => [g, rnd() < 0.5])) });

  const violations: Violation<S, E>[] = [];
  const rowsHit = new Set<string>();
  let stepsTaken = 0;
  for (let w = 0; w < walks; w++) {
    const steps: Step<E>[] = [];
    let state: S = m.initial;
    for (let i = 0; i < maxSteps; i++) {
      steps.push(randomStep());
      const r = replay(m, steps);
      stepsTaken++;
      r.rowsHit.forEach((id) => rowsHit.add(id));
      if (r.violation) { violations.push(r.violation); break; }
      // 到了终态：再随机探一步验证吸收（replay 里会查），然后结束这条游走
      if (m.isTerminal(r.state) && !m.isTerminal(state)) {
        steps.push(randomStep());
        const probe = replay(m, steps);
        stepsTaken++;
        if (probe.violation) violations.push(probe.violation);
        break;
      }
      state = r.state;
    }
  }
  let minimal: Violation<S, E> | undefined;
  if (violations.length) {
    const first = violations[0];
    const steps = ddmin(first.steps, (sub) => replay(m, sub).violation?.invariant === first.invariant);
    minimal = { ...replay(m, steps).violation!, steps };
  }
  const hit = m.rows.map((r) => r.id).filter((id) => rowsHit.has(id));
  return { feature: m.feature, seed: opts.seed, walks, stepsTaken, violations, minimal, rowsHit: hit, rowsNeverHit: m.rows.map((r) => r.id).filter((id) => !rowsHit.has(id)) };
}
