/**
 * P2 · 事实库：三态真假 + 槽位。
 *
 * 规则来自 01 §5 / 02-schema.sql：
 * - `truth ∈ {-1,0,1}`：1 真 / 0 未知 / -1 假（谎言）。三态不是布尔。
 * - 单值谓词（card='single'）同槽位只能有一个当前值；换值 = 旧行 supersede，不覆盖。
 * - 多值谓词（card='multi'）同谓词可以并存，槽位键带宾语 id。
 * - `fact.card` 必须与 `predicate_spec.cardinality` 一致（触发器守，这里提前判定）。
 *
 * slot_key 必须与 schema 的生成列逐字节一致，否则唯一索引和设定锁会对不上：
 *   single: subject_id || '|' || predicate || '|'
 *   multi : subject_id || '|' || predicate || '|' || json_extract(object_json,'$.id')
 * SQLite 的 `||` 会把 REAL 的 1.0 写成 "1.0"，JS 是 "1"。所以这里只接受字符串 id，
 * 从根上避开数字格式分叉（与 h01 的陷阱同源）。
 */
import { canonicalJson } from './hash.js';
import type { Cardinality, Truth } from './types.js';

export interface ActiveFactState {
  id: string;
  slotKey: string;
  objectJson: string;
  truth: Truth;
  secrecy: number;
  validFrom: string;
}

export type FactPlan =
  | { ok: true; action: 'insert'; slotKey: string }
  | { ok: true; action: 'same'; slotKey: string; factId: string }
  | {
      ok: true;
      action: 'supersede';
      slotKey: string;
      supersededId: string;
      supersededValidTo: string;
    }
  | { ok: false; code: 'fact_locked' | 'time_conflict' | 'invalid_object'; message: string };

/** 与 schema 的生成列逐字节一致的槽位键。multi 的 object 必须带字符串 id。 */
export function slotKeyOf(
  subjectId: string,
  predicate: string,
  object: unknown,
  cardinality: Cardinality,
): string {
  if (cardinality === 'single') return `${subjectId}|${predicate}|`;
  const id = objectIdOf(object);
  return `${subjectId}|${predicate}|${id ?? ''}`;
}

/** 多值谓词的宾语 id；只接受非空字符串（见文件头）。 */
export function objectIdOf(object: unknown): string | null {
  if (typeof object !== 'object' || object === null || Array.isArray(object)) return null;
  const id = (object as Record<string, unknown>).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * 一次断言该做什么。`existing` 只放同槽位的当前有效行（valid_to IS NULL）。
 * 单值槽位最多一行；多值槽位同 id 最多一行。
 */
export function planFactAssert(input: {
  subjectId: string;
  predicate: string;
  cardinality: Cardinality;
  object: unknown;
  truth: Truth;
  secrecy: number;
  validFrom: string;
  existing: readonly ActiveFactState[];
  locked: boolean;
}): FactPlan {
  if (input.cardinality === 'multi' && objectIdOf(input.object) === null) {
    return {
      ok: false,
      code: 'invalid_object',
      message: '多值谓词的宾语必须是带字符串 id 的对象：{"id":"..."}',
    };
  }
  const slotKey = slotKeyOf(input.subjectId, input.predicate, input.object, input.cardinality);
  const objectJson = canonicalJson(input.object);
  const sameSlot = input.existing.filter((row) => row.slotKey === slotKey);
  const identical = sameSlot.find(
    (row) =>
      row.objectJson === objectJson && row.truth === input.truth && row.secrecy === input.secrecy,
  );
  if (identical) return { ok: true, action: 'same', slotKey, factId: identical.id };

  // 锁优先于时间判定：锁住的槽位任何写入都拒绝，报错要指向"锁定"而不是"时间倒退"。
  if (input.locked) {
    return {
      ok: false,
      code: 'fact_locked',
      message: `槽位 ${slotKey} 已被作者锁定：换 ID 写同一槽位同样会被拒绝`,
    };
  }

  // 同值不同元数据（truth/secrecy）= 纠正，走 supersede；不能原地改写。
  const current = sameSlot[0];
  if (current && input.validFrom <= current.validFrom) {
    return {
      ok: false,
      code: 'time_conflict',
      message: `新值的 valid_from (${input.validFrom}) 必须晚于旧值 (${current.validFrom})`,
    };
  }
  if (current) {
    return {
      ok: true,
      action: 'supersede',
      slotKey,
      supersededId: current.id,
      supersededValidTo: input.validFrom,
    };
  }
  return { ok: true, action: 'insert', slotKey };
}

export interface ClaimLike {
  subject: string;
  predicate: string;
  object: unknown;
}

export interface LockedSlot {
  slotKey: string;
  scope: string;
}

/**
 * 设定冲突（03 §8 第 2 类）：claim 落在被锁定的槽位上，且宾语与当前锁定值不同。
 * 只看 fact 作用域的锁；relation/entity/world/timeline 的锁由各自命令层处理。
 */
export function settingConflictOf(
  claim: ClaimLike,
  resolvedSubjectId: string,
  cardinality: Cardinality,
  activeObjectJson: string | null,
  locks: readonly LockedSlot[],
): { slotKey: string; message: string } | null {
  const slotKey = slotKeyOf(resolvedSubjectId, claim.predicate, claim.object, cardinality);
  const locked = locks.find((lock) => lock.scope === 'fact' && lock.slotKey === slotKey);
  if (!locked) return null;
  const objectJson = canonicalJson(claim.object);
  if (activeObjectJson !== null && activeObjectJson === objectJson) return null;
  return {
    slotKey,
    message: `claim 与锁定事实冲突：${claim.subject}·${claim.predicate}（槽位 ${slotKey}）`,
  };
}

/** 事实三态的中文标签；CLI 与报告共用，避免两处各写一套。 */
export function truthLabel(truth: Truth): string {
  return truth === 1 ? '真' : truth === -1 ? '假' : '未知';
}
