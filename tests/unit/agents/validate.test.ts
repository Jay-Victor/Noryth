import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import type { FinalAnswer } from '../../../src/shared/schema/envelope'
import { TurnRefRegistry } from '../../../src/main/tools/turn-refs'
import type { EnvelopeExpectation } from '../../../src/main/agents/validate'
import { assembleEnvelope, countWords, normalizeQuote, validateEnvelope } from '../../../src/main/agents/validate'

const QUOTE = '父亲书房有一只上锁的黑漆匣子'

function refs(): TurnRefRegistry {
  const registry = new TurnRefRegistry()
  registry.register([
    { type: 'memory', id: 'mem_1', quote: QUOTE },
    { type: 'fact', id: 'wf_1', quote: '黑漆匣子 位置 祠堂供桌下面' }
  ])
  return registry
}

function expectation(patch: Partial<EnvelopeExpectation> = {}): EnvelopeExpectation {
  return {
    turnId: 'turn_1',
    speakerType: 'character',
    speakerId: 'chr_lin',
    maxWords: 120,
    turnRefs: refs(),
    degradedSources: [],
    model: 'deepseek-flash',
    tokensIn: 10,
    tokensOut: 20,
    ...patch
  }
}

function draft(patch: Partial<FinalAnswer> = {}): FinalAnswer {
  return { body: '她把茶盏推过去，低声问起匣子。', grounding: [], ...patch }
}

function envelopeOf(answer: FinalAnswer, exp = expectation()) {
  return assembleEnvelope(answer, exp, [])
}

describe('信封与 grounding 校验（DEV-PLAN §7.2 / §6.6）', () => {
  it('合法信封：speaker / 字数 / grounding 子集全部通过', () => {
    const result = validateEnvelope(
      envelopeOf(
        draft({
          grounding: [{ type: 'memory', id: 'mem_1', quote: '书房有一只上锁的黑漆匣子' }]
        })
      ),
      expectation()
    )
    expect(result.wordCount).toBe(countWords(draft().body))
    expect(result.envelope.turn_id).toBe('turn_1')
    expect(result.envelope.speaker).toEqual({ type: 'character', id: 'chr_lin' })
    expect(result.envelope.grounding).toHaveLength(1)
  })

  it('quote 归一化（NFKC + 去空白）后匹配；改写即拒绝', () => {
    expect(normalizeQuote(' 黑漆　匣子 ')).toBe('黑漆匣子')
    const exp = expectation()
    const spaced = validateEnvelope(
      envelopeOf(draft({ grounding: [{ type: 'memory', id: 'mem_1', quote: '上锁 的 黑漆匣子' }] }), exp),
      exp
    )
    expect(spaced.envelope.grounding).toHaveLength(1)

    expect(() =>
      validateEnvelope(
        envelopeOf(
          draft({ grounding: [{ type: 'memory', id: 'mem_1', quote: '父亲书房有一只黑漆匣子' }] }),
          expectation()
        ),
        expectation()
      )
    ).toThrowError(AppError)

    try {
      validateEnvelope(
        envelopeOf(
          draft({ grounding: [{ type: 'memory', id: 'mem_1', quote: '父亲书房有一只黑漆匣子' }] }),
          expectation()
        ),
        expectation()
      )
    } catch (error) {
      expect((error as AppError).code).toBe('grounding_quote_mismatch')
    }
  })

  it('伪造 grounding ID → grounding_not_returned', () => {
    try {
      validateEnvelope(
        envelopeOf(
          draft({ grounding: [{ type: 'memory', id: 'mem_forged', quote: QUOTE }] }),
          expectation()
        ),
        expectation()
      )
      throw new Error('应当拒绝')
    } catch (error) {
      expect((error as AppError).code).toBe('grounding_not_returned')
      expect((error as AppError).details).toMatchObject({ id: 'mem_forged' })
    }
  })

  it('重复 (type,id) 去重但不算失败', () => {
    const result = validateEnvelope(
      envelopeOf(
        draft({
          grounding: [
            { type: 'memory', id: 'mem_1', quote: QUOTE },
            { type: 'memory', id: 'mem_1', quote: '黑漆匣子' }
          ]
        })
      ),
      expectation()
    )
    expect(result.envelope.grounding).toHaveLength(1)
    expect(result.notes).toContain('grounding_duplicate:memory:mem_1')
  })

  it('speaker 与分镜不一致 → schema_invalid', () => {
    const wrong = {
      ...envelopeOf(draft()),
      speaker: { type: 'character', id: 'chr_shen' }
    }
    try {
      validateEnvelope(wrong, expectation())
      throw new Error('应当拒绝')
    } catch (error) {
      expect((error as AppError).code).toBe('schema_invalid')
    }
  })

  it('字数超过 max_words × 1.3 → schema_invalid；null 不限制', () => {
    const long = '雨'.repeat(157)
    expect(() =>
      validateEnvelope(envelopeOf(draft({ body: long })), expectation({ maxWords: 120 }))
    ).toThrowError(/字数上限/)

    expect(() =>
      validateEnvelope(envelopeOf(draft({ body: long })), expectation({ maxWords: null }))
    ).not.toThrow()
    // 恰好 156 字（120 × 1.3）可以
    expect(() =>
      validateEnvelope(envelopeOf(draft({ body: '雨'.repeat(156) })), expectation({ maxWords: 120 }))
    ).not.toThrow()
  })

  it('meta.degraded 在真实降级源下被强制为 true', () => {
    const result = validateEnvelope(
      envelopeOf(draft({ meta: { degraded: false } }), expectation({ degradedSources: ['context_trimmed'] })),
      expectation({ degradedSources: ['context_trimmed'] })
    )
    expect(result.envelope.meta.degraded).toBe(true)
    expect(result.notes).toContain('degraded_forced')
  })

  it('trace 超过 40 条时截断到 40，不整封拒绝', () => {
    const trace = Array.from({ length: 45 }, (_, index) => ({ type: 'thought' as const, text: `想法 ${index}` }))
    const envelope = assembleEnvelope(draft(), expectation(), trace)
    expect(envelope.trace).toHaveLength(40)
    const first = envelope.trace[0]
    expect(first?.type === 'thought' ? first.text : '').toBe('想法 5')
  })

  it('非 schema 输入 → schema_invalid', () => {
    try {
      validateEnvelope({ body: 'x' }, expectation())
      throw new Error('应当拒绝')
    } catch (error) {
      expect((error as AppError).code).toBe('schema_invalid')
    }
  })
})
