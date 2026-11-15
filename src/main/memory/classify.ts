import type { ProposalKind } from '../db/repos/memory-proposal'

/**
 * 事实 / 信念 / 声称三分（PHASE-09 H1 / DEV-PLAN §10.2）。
 *
 * 规则是代码，不是提示词：
 *   - 角色台词只允许 `belief`，或 `world_fact(truth='claim')`；
 *   - 只有旁白叙述（或作者手写）才能产出 `world_fact(truth='objective')`；
 *   - 缺角色身份的 `experience/fact/relationship/cognition/belief` 直接丢弃；
 *   - 缺三元组的 `world_fact` 直接丢弃。
 *
 * 降级不是丢弃：模型把台词写成 objective 事实时，服务端把它改成 claim
 * 并在提案上留 `downgraded`，作者仍能看到「角色声称……」这条。
 */

export type SpeakerType = 'character' | 'narrator'

export interface ClassificationInput {
  kind: ProposalKind
  characterId: string | null
  payload: Record<string, unknown>
  speakerType: SpeakerType
  /** 作者在世界状态里显式新增时为 true；抽取路径永远 false。 */
  authorConfirmed?: boolean
}

export type ClassificationDrop =
  | 'missing_character'
  | 'world_fact_payload'
  | 'empty_text'

export interface Classification {
  ok: boolean
  drop: ClassificationDrop | null
  kind: ProposalKind
  truth: 'objective' | 'claim' | null
  /** 服务端改写过的字段（给 UI 显示「已降级」）。 */
  downgrades: string[]
  payload: Record<string, unknown>
}

const MEMORY_KINDS: readonly ProposalKind[] = ['experience', 'fact', 'relationship', 'cognition']

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function classifyProposal(input: ClassificationInput): Classification {
  const payload: Record<string, unknown> = { ...input.payload }
  const downgrades: string[] = []

  if (input.kind === 'world_fact') {
    const subject = asString(payload.subject)
    const predicate = asString(payload.predicate)
    const object = asString(payload.object)
    if (subject === null || predicate === null || object === null) {
      return { ok: false, drop: 'world_fact_payload', kind: input.kind, truth: null, downgrades, payload }
    }
    // 台词不能写客观事实：原文来自角色拍 → 只能成为「声称」。
    let truth: 'objective' | 'claim' = payload.truth === 'objective' ? 'objective' : 'claim'
    if (truth === 'objective' && input.speakerType === 'character' && input.authorConfirmed !== true) {
      truth = 'claim'
      downgrades.push('dialogue_objective_to_claim')
    }
    const knownBy = Array.isArray(payload.known_by)
      ? payload.known_by.filter((value): value is string => typeof value === 'string')
      : []
    const visibility =
      payload.visibility === 'public' || payload.visibility === 'secret'
        ? payload.visibility
        : knownBy.length > 0
          ? 'secret'
          : 'public'
    const singleValue = asNumber(payload.single_value)
    const revealSeq = asNumber(payload.reveal_seq)
    return {
      ok: true,
      drop: null,
      kind: input.kind,
      truth,
      downgrades,
      payload: {
        ...payload,
        subject,
        predicate,
        object,
        truth,
        visibility,
        known_by: knownBy,
        single_value: singleValue === null ? 1 : singleValue === 0 ? 0 : 1,
        reveal_seq: revealSeq === null ? null : Math.trunc(revealSeq)
      }
    }
  }

  if (MEMORY_KINDS.includes(input.kind) || input.kind === 'belief') {
    if (input.characterId === null || input.characterId.trim().length === 0) {
      return { ok: false, drop: 'missing_character', kind: input.kind, truth: null, downgrades, payload }
    }
    if (input.kind === 'belief') {
      const confidence = asNumber(payload.confidence)
      return {
        ok: true,
        drop: null,
        kind: 'belief',
        truth: null,
        downgrades,
        payload: {
          ...payload,
          confidence: confidence === null ? 0.6 : Math.min(1, Math.max(0, confidence))
        }
      }
    }
    if (input.kind === 'relationship') {
      const toId = asString(payload.to_id)
      const axis = asString(payload.axis)
      const value = asNumber(payload.value)
      if (toId === null || axis === null || value === null) {
        // 关系提案缺结构化字段：退化成经历，不猜边。
        downgrades.push('relationship_payload_to_experience')
        return {
          ok: true,
          drop: null,
          kind: 'experience',
          truth: null,
          downgrades,
          payload
        }
      }
      return {
        ok: true,
        drop: null,
        kind: 'relationship',
        truth: null,
        downgrades,
        payload: {
          ...payload,
          to_id: toId,
          axis: axis === 'trust' || axis === 'intimacy' || axis === 'tension' ? axis : 'trust',
          value: Math.min(1, Math.max(-1, value))
        }
      }
    }
    return { ok: true, drop: null, kind: input.kind, truth: null, downgrades, payload }
  }

  return { ok: false, drop: 'empty_text', kind: input.kind, truth: null, downgrades, payload }
}

/** UI 文案：提案上的降级原因。唯一真源在 shared，main 与 renderer 共用。 */
export { MEMORY_DOWNGRADE_LABELS as CLASSIFICATION_LABELS } from '../../shared/schema/memory'
