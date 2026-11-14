import { AppError } from '../../shared/domain/app-error'
import type { Envelope, EnvelopeMeta, EnvelopeTraceItem, FinalAnswer, GroundingItem } from '../../shared/schema/envelope'
import { EnvelopeSchema } from '../../shared/schema/envelope'
import type { TurnRefRegistry } from '../tools/turn-refs'
import type { SpeakerType } from '../db/repos/beat'

/**
 * 信封校验（PRD §4.6 / DEV-PLAN §7.2 / §6.6）。
 *
 * 能强校验的只有「结构」：schema、speaker 归属、字数、grounding 子集。
 * 「body 里替别人说话」「语义越界」是概率问题，交审批与作者抽检，
 * 本文件不宣称能 100% 拦截。
 */

export interface EnvelopeExpectation {
  turnId: string
  speakerType: SpeakerType
  speakerId: string
  /** 分镜给的每拍字数上限；null 表示不限制。 */
  maxWords: number | null
  turnRefs: TurnRefRegistry
  /** 检索空、上下文裁剪、工具降级等真实降级源。 */
  degradedSources: string[]
  model: string
  tokensIn: number | null
  tokensOut: number | null
}

export interface EnvelopeValidation {
  envelope: Envelope
  notes: string[]
  wordCount: number
}

const WORD_TOLERANCE = 1.3
const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g

/** 引用归一化：NFKC + 去所有空白 + 去零宽字符；不做同义改写容忍。 */
export function normalizeQuote(text: string): string {
  return text.normalize('NFKC').replace(ZERO_WIDTH, '').replace(/\s+/g, '')
}

export function countWords(body: string): number {
  return [...body].length
}

function speakerMatches(expectation: EnvelopeExpectation, envelope: Envelope): boolean {
  return envelope.speaker.id === expectation.speakerId && envelope.speaker.type === expectation.speakerType
}

function dedupeGrounding(items: readonly GroundingItem[], notes: string[]): GroundingItem[] {
  const seen = new Set<string>()
  const output: GroundingItem[] = []
  for (const item of items) {
    const key = `${item.type}:${item.id}`
    if (seen.has(key)) {
      notes.push(`grounding_duplicate:${key}`)
      continue
    }
    seen.add(key)
    output.push(item)
  }
  return output
}

/**
 * 校验 grounding 子集（DEV-PLAN §6.6 V1–V5）。
 * - 越界引用 → grounding_not_returned
 * - quote 改写 → grounding_quote_mismatch
 * - 重复 → 去重（不算失败）
 */
export function validateGrounding(
  items: readonly GroundingItem[],
  turnRefs: TurnRefRegistry
): { grounding: GroundingItem[]; notes: string[] } {
  const notes: string[] = []
  if (items.length > 8) {
    throw new AppError('invalid_grounding', 'grounding 超过 8 条', { count: items.length })
  }
  const deduped = dedupeGrounding(items, notes)
  for (const item of deduped) {
    if (!turnRefs.has(item.type, item.id)) {
      throw new AppError('grounding_not_returned', 'grounding 引用了本轮未返回的依据', {
        type: item.type,
        id: item.id
      })
    }
    const source = turnRefs.quoteOf(item.type, item.id) ?? ''
    const quote = normalizeQuote(item.quote)
    if (quote.length === 0 || !normalizeQuote(source).includes(quote)) {
      throw new AppError('grounding_quote_mismatch', 'grounding.quote 不是引用原文的子串', {
        type: item.type,
        id: item.id
      })
    }
  }
  return { grounding: deduped, notes }
}

/** 模型只交 body + grounding + 可选 meta；运行时补齐 turn_id / speaker / trace / meta。 */
export function assembleEnvelope(
  draft: FinalAnswer,
  expectation: EnvelopeExpectation,
  trace: EnvelopeTraceItem[]
): Envelope {
  const meta: EnvelopeMeta = {
    model: draft.meta?.model ?? expectation.model,
    degraded: draft.meta?.degraded ?? false,
    tokens_in: draft.meta?.tokens_in ?? expectation.tokensIn,
    tokens_out: draft.meta?.tokens_out ?? expectation.tokensOut
  }
  return EnvelopeSchema.parse({
    turn_id: expectation.turnId,
    speaker: { type: expectation.speakerType, id: expectation.speakerId },
    trace: trace.slice(-40),
    body: draft.body,
    grounding: draft.grounding,
    meta
  })
}

export function validateEnvelope(candidate: unknown, expectation: EnvelopeExpectation): EnvelopeValidation {
  const parsed = EnvelopeSchema.safeParse(candidate)
  if (!parsed.success) {
    throw new AppError('schema_invalid', '信封不符合 schema', {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    })
  }
  const envelope = parsed.data
  const notes: string[] = []

  if (!speakerMatches(expectation, envelope)) {
    throw new AppError('schema_invalid', 'speaker 与分镜不一致', {
      expected: { type: expectation.speakerType, id: expectation.speakerId },
      actual: envelope.speaker
    })
  }

  if (envelope.body.trim().length === 0) {
    throw new AppError('schema_invalid', 'body 为空', { turnId: envelope.turn_id })
  }

  const wordCount = countWords(envelope.body)
  if (expectation.maxWords !== null) {
    const limit = Math.ceil(expectation.maxWords * WORD_TOLERANCE)
    if (wordCount > limit) {
      throw new AppError('schema_invalid', 'body 超过字数上限', {
        wordCount,
        maxWords: expectation.maxWords,
        limit
      })
    }
  }

  const grounding = validateGrounding(envelope.grounding, expectation.turnRefs)
  notes.push(...grounding.notes)

  // meta.degraded 必须如实：任一降级源为真，就强制为 true（DEV-PLAN §7.2）。
  if (expectation.degradedSources.length > 0 && !envelope.meta.degraded) {
    envelope.meta.degraded = true
    notes.push('degraded_forced')
  }

  return {
    envelope: { ...envelope, grounding: grounding.grounding },
    notes,
    wordCount
  }
}
