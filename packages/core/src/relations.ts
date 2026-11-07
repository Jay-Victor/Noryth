/**
 * P2 · 关系轴：单拍突变 = 要求理由，没有理由就钳制到阈值。
 *
 * 03 §8 第 3 类冲突。P1 在 beat.commit 与 relation.set 各写了一份同样的逻辑；
 * P2 收成一处，避免两条写入路径对同一次突变得出不同结论。
 */
import { PARAMS } from './params.js';

const DEFAULT_THRESHOLD = PARAMS['consistency.relation_jump_threshold'];

export interface RelationAdjustment {
  /** 实际落库的值。 */
  value: number;
  /** 请求值与旧值的差是否超过阈值。 */
  jumped: boolean;
  /** 是否被钳制（超阈值且没有理由）。 */
  clamped: boolean;
  /** 落库的理由；钳制时写入自动说明，绝不静默通过。 */
  reason: string | null;
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function adjustRelation(input: {
  oldValue: number;
  requested: number;
  reason: string;
  threshold?: number;
}): RelationAdjustment {
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;
  const oldValue = clamp(input.oldValue, -1, 1);
  const requested = clamp(input.requested, -1, 1);
  const delta = Math.abs(requested - oldValue);
  const reason = input.reason.trim();
  if (delta <= threshold) {
    return { value: requested, jumped: false, clamped: false, reason: reason.length > 0 ? reason : null };
  }
  if (reason.length > 0) {
    return { value: requested, jumped: true, clamped: false, reason };
  }
  const direction = Math.sign(requested - oldValue);
  return {
    value: clamp(oldValue + direction * threshold, -1, 1),
    jumped: true,
    clamped: true,
    reason: '（无理由，自动钳制到阈值）',
  };
}
