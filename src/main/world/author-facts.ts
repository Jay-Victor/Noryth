import { AppError } from '../../shared/domain/app-error'

/**
 * 作者世界事实的参数组装与校验（PHASE-13 M1-18）。
 *
 * 边界（DEV-PLAN §10.2 / PHASE-13 §5.2）：
 * - 这里**只**做参数归一化与校验，不写 SQL、不碰数据库；
 * - 真正的写入在 `memory/apply.ts` 的 `applyAuthorFact`——世界状态仍然只有一个写入者（R2）；
 * - 作者可以写 objective（作者权限），台词/模型不能（抽取规则在阶段 09，不改）。
 */

export interface AuthorFactContext {
  projectId: string
  /** 当前项目叙事序水位；valid_from_seq / reveal_seq 都不得超过它。 */
  seqHead: number
  characterIds: ReadonlySet<string>
}

export interface AuthorFactDraft {
  subject: string
  predicate: string
  object: string
  truth: 'objective' | 'claim'
  visibility: 'public' | 'secret'
  knownBy?: readonly string[]
  revealSeq?: number | null
  /** 省略时取当前水位：作者新写的事实从「现在」开始有效。 */
  validFromSeq?: number
}

export interface AuthorFactInput {
  projectId: string
  subject: string
  predicate: string
  object: string
  truth: 'objective' | 'claim'
  visibility: 'public' | 'secret'
  knownByJson: string
  revealSeq: number | null
  validFromSeq: number
  singleValue: 0 | 1
}

/**
 * 多值谓词：换宾语并存，不关旧值（DEV-PLAN §10.3）。
 * 其余谓词按单值槽处理（与 `world_fact.single_value` 的默认值 1 一致）。
 */
export const MULTI_VALUE_PREDICATES: ReadonlySet<string> = new Set([
  '喜欢',
  '讨厌',
  '认识',
  '知道',
  '记得',
  '去过',
  '参与',
  '擅长',
  '习惯',
  '口味',
  '朋友',
  '敌人',
  '持有',
  '拥有',
  '情绪'
])

export const AUTHOR_FACT_LIMITS = {
  subject: 60,
  predicate: 40,
  object: 200,
  knownBy: 24
} as const

export function singleValueFor(predicate: string): 0 | 1 {
  return MULTI_VALUE_PREDICATES.has(predicate.trim()) ? 0 : 1
}

function clean(value: string, field: string, max: number): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw new AppError('invalid_args', `${field}不能为空`, { field })
  }
  if ([...trimmed].length > max) {
    throw new AppError('invalid_args', `${field}超过 ${max} 字`, { field, max })
  }
  return trimmed
}

function seqWithin(value: number, field: string, seqHead: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError('invalid_args', `${field}必须是非负整数`, { field, value })
  }
  if (value > seqHead) {
    throw new AppError('invalid_args', `${field} ${value} 超过当前叙事序 ${seqHead}`, {
      field,
      value,
      seqHead
    })
  }
  return value
}

/**
 * 作者新增事实：归一化 + 校验。返回可直接交给 `applyAuthorFact` 的输入。
 *
 * 故意不接受 `single_value`：单值/多值由谓词登记表决定，调用方（UI/测试）不能绕过。
 */
export function buildAuthorFactInput(draft: AuthorFactDraft, ctx: AuthorFactContext): AuthorFactInput {
  const subject = clean(draft.subject, '主体', AUTHOR_FACT_LIMITS.subject)
  const predicate = clean(draft.predicate, '谓词', AUTHOR_FACT_LIMITS.predicate)
  const object = clean(draft.object, '宾语', AUTHOR_FACT_LIMITS.object)

  const knownBy: string[] = []
  for (const id of draft.knownBy ?? []) {
    const trimmed = id.trim()
    if (trimmed.length === 0 || knownBy.includes(trimmed)) continue
    if (!ctx.characterIds.has(trimmed)) {
      throw new AppError('invalid_args', `知情者 ${trimmed} 不在本项目`, { characterId: trimmed })
    }
    knownBy.push(trimmed)
  }
  if (knownBy.length > AUTHOR_FACT_LIMITS.knownBy) {
    throw new AppError('invalid_args', `知情者超过 ${AUTHOR_FACT_LIMITS.knownBy} 人`, {
      max: AUTHOR_FACT_LIMITS.knownBy
    })
  }

  const validFromSeq = seqWithin(draft.validFromSeq ?? ctx.seqHead, 'valid_from_seq', ctx.seqHead)
  const revealSeq =
    draft.revealSeq === undefined || draft.revealSeq === null
      ? null
      : seqWithin(draft.revealSeq, 'reveal_seq', ctx.seqHead)

  // 秘密事实不自动揭示：给了 reveal_seq 也只在它之后进读者视图，这个语义由投影负责；
  // 这里只需要保证「秘密 + reveal_seq」不是「立刻公开」的误用。
  if (draft.visibility === 'secret' && revealSeq !== null && revealSeq <= validFromSeq) {
    throw new AppError('invalid_args', '秘密事实的揭示序必须晚于生效序', { revealSeq, validFromSeq })
  }

  return {
    projectId: ctx.projectId,
    subject,
    predicate,
    object,
    truth: draft.truth,
    visibility: draft.visibility,
    knownByJson: JSON.stringify(knownBy),
    revealSeq,
    validFromSeq,
    singleValue: singleValueFor(predicate)
  }
}

export interface AuthorFactCloseInput {
  projectId: string
  factId: string
  seq: number
  reason: string | null
}

export interface AuthorFactRecordLike {
  id: string
  projectId: string
  validFromSeq: number
  validToSeq: number | null
}

/** 作者关闭事实：只算关闭序，不写库；已关闭的返回 duplicate 由调用方处理。 */
export function buildAuthorFactCloseInput(
  draft: { factId: string; reason?: string | null },
  ctx: { projectId: string; seqHead: number; fact: AuthorFactRecordLike | null }
): { input: AuthorFactCloseInput; alreadyClosed: boolean } {
  const factId = draft.factId.trim()
  if (factId.length === 0) throw new AppError('invalid_args', '缺事实 id')
  const fact = ctx.fact
  if (!fact || fact.projectId !== ctx.projectId) {
    throw new AppError('invalid_args', '事实不存在', { factId })
  }
  const reason = draft.reason?.trim() ?? ''
  if (reason.length > 200) throw new AppError('invalid_args', '关闭原因超过 200 字', { factId })
  // 关闭序不得早于生效序，否则会出现 valid_to < valid_from 的空区间行。
  const seq = Math.max(ctx.seqHead, fact.validFromSeq)
  return {
    input: { projectId: ctx.projectId, factId, seq, reason: reason.length > 0 ? reason : null },
    alreadyClosed: fact.validToSeq !== null
  }
}
