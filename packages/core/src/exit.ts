/**
 * A5 · 收束条件求值：六个算子，够用且好测。
 *
 * 为什么不用"模型觉得差不多了"：同源模型自评会通胀，永远"差不多了"；
 * 结果是永不结束，或只能靠 60 拍硬截断，而截断处 100% 需要人工收尾。
 */

export type Cmp = '<' | '>' | '<=' | '>=' | '==';

export type ExitExpr =
  | { op: 'fact'; subject: string; predicate: string; object: unknown }
  | { op: 'rel'; from: string; to: string; axis: string; cmp: Cmp; value: number }
  | { op: 'beats'; cmp: Cmp; value: number }
  | { op: 'all'; of: ExitExpr[] }
  | { op: 'any'; of: ExitExpr[] }
  | { op: 'not'; of: ExitExpr };

export interface SceneEvalState {
  /** 当前有效的 (subject, predicate) → 值。 */
  facts: ReadonlyMap<string, unknown>;
  /** (from, to, axis) → 关系值。 */
  rels: ReadonlyMap<string, number>;
  beats: number;
}

/** Python 的 == 对 JSON 值做结构相等；JS 的 === 不行，这里补上。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>).sort();
    const bk = Object.keys(b as Record<string, unknown>).sort();
    if (ak.length !== bk.length || ak.some((k, i) => k !== bk[i])) return false;
    return ak.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function compare(value: number, cmp: Cmp, target: number): boolean {
  switch (cmp) {
    case '<':
      return value < target;
    case '>':
      return value > target;
    case '<=':
      return value <= target;
    case '>=':
      return value >= target;
    case '==':
      return value === target;
    default:
      throw new Error(`unknown cmp ${String(cmp)}`);
  }
}

export function factKey(subject: string, predicate: string): string {
  return `${subject}\u0000${predicate}`;
}

export function relKey(from: string, to: string, axis: string): string {
  return `${from}\u0000${to}\u0000${axis}`;
}

/**
 * 每拍评估；满足 → 进 closing（再写 1 拍收束旁白）→ closed。
 * 未知算子抛错（不静默 false）；rel 轴缺失按 0；fact 用严格相等。
 */
export function evalExit(expr: ExitExpr, state: SceneEvalState): boolean {
  switch (expr.op) {
    case 'fact':
      return deepEqual(state.facts.get(factKey(expr.subject, expr.predicate)), expr.object);
    case 'rel':
      return compare(
        state.rels.get(relKey(expr.from, expr.to, expr.axis)) ?? 0,
        expr.cmp,
        expr.value,
      );
    case 'beats':
      return compare(state.beats, expr.cmp, expr.value);
    case 'all':
      return expr.of.every((e) => evalExit(e, state));
    case 'any':
      return expr.of.some((e) => evalExit(e, state));
    case 'not':
      return !evalExit(expr.of, state);
    default: {
      const unknown = expr as { op?: unknown };
      throw new Error(`unknown op ${String(unknown.op)}`);
    }
  }
}
