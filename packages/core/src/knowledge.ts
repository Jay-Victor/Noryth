/**
 * A3 · 知识边界：前置过滤，不是提示词禁令。
 *
 * 没有 cognition 行 = 不知道 = 不进提示词。这是唯一正确的顺序：
 * 先过滤，再拼装；未授权内容不得先送入模型再要求它别提。
 */
import type { Attitude, Percept } from './types.js';

export interface KnowledgeFact {
  id: string;
  object: unknown;
  secrecy: number;
  /** 该事实对谁脱敏（secrecy >= 3 时生效）。 */
  redactFor?: ReadonlySet<string>;
  [extra: string]: unknown;
}

export interface CognitionRecord {
  characterId: string;
  factId: string;
  learnedSeq: number;
  attitude: Attitude;
  certainty: number;
  percept?: Percept;
}

export type VisibleFact = KnowledgeFact & { redacted?: true };

/**
 * 规则：f ∈ result ⇔ ∃c ∈ cognition: c.characterId = charId ∧ c.factId = f.id。
 * secrecy >= 3 且该角色在 redactFor 里 → object 换成"（未知）"。
 */
export function visibleFacts(
  facts: readonly KnowledgeFact[],
  charId: string,
  cognition: readonly CognitionRecord[],
): VisibleFact[] {
  const known = new Set<string>();
  for (const c of cognition) {
    if (c.characterId === charId) known.add(c.factId);
  }
  const out: VisibleFact[] = [];
  for (const f of facts) {
    if (!known.has(f.id)) continue;
    if (f.secrecy >= 3 && f.redactFor && f.redactFor.has(charId)) {
      out.push({ ...f, object: '（未知）', redacted: true });
    } else {
      out.push(f);
    }
  }
  return out;
}

export type AudienceMode = 'public' | 'whisper' | 'soliloquy' | 'narrator_reader';

/**
 * 感知 = 消息级受众集合，不是"同场即可感知"。
 * 旁白默认零感知：它写的是场面，不产生任何角色的获知记录。
 */
export function buildAudience(
  present: readonly string[],
  actor: string,
  mode: AudienceMode = 'public',
  privateTo: readonly string[] = [],
): string[] {
  const presentSet = new Set(present);
  const sorted = (values: Iterable<string>): string[] => [...values].sort();
  if (mode === 'public') {
    presentSet.delete(actor);
    return sorted(presentSet);
  }
  if (mode === 'whisper') {
    const privateSet = new Set(privateTo);
    privateSet.delete(actor);
    return sorted(privateSet);
  }
  if (mode === 'soliloquy' || mode === 'narrator_reader') {
    return [];
  }
  presentSet.delete(actor);
  return sorted(presentSet);
}

/**
 * 写入获知记录。同一角色同一事实只保留最早一条（O(n) 查重，规模小）。
 * 这里只负责"谁被告知了什么"，不写库——提交由命令层完成。
 */
export function addCognition(
  cognition: CognitionRecord[],
  audience: readonly string[],
  factId: string,
  seq: number,
  attitude: Attitude = 'knows',
  certainty = 1.0,
): void {
  const remaining = new Set(audience);
  for (const c of cognition) {
    if (remaining.has(c.characterId) && c.factId === factId) {
      remaining.delete(c.characterId);
    }
  }
  for (const characterId of remaining) {
    cognition.push({ characterId, factId, learnedSeq: seq, attitude, certainty });
  }
}
