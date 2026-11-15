import { describe, expect, it } from 'vitest'
import { classifyProposal } from '../../../src/main/memory/classify'

/**
 * H1 事实/信念/声称三分（DEV-PLAN §10.2）。
 *
 * 代码级规则：台词证据 → 只能 belief 或 world_fact(truth='claim')；
 * 旁白 → 可以 objective；缺角色 / 缺三元组 → 丢弃。
 */

const base = { characterId: 'chr_1', payload: {}, authorConfirmed: false } as const

describe('classifyProposal', () => {
  it('台词把 objective 写成事实 → 降级为 claim 并留痕', () => {
    const result = classifyProposal({
      ...base,
      kind: 'world_fact',
      speakerType: 'character',
      payload: { subject: '账本', predicate: '位置', object: '祠堂', truth: 'objective', visibility: 'secret' }
    })
    expect(result.ok).toBe(true)
    expect(result.truth).toBe('claim')
    expect(result.downgrades).toContain('dialogue_objective_to_claim')
  })

  it('旁白证据可以产 objective；作者确认也保留 objective', () => {
    const narration = classifyProposal({
      ...base,
      kind: 'world_fact',
      speakerType: 'narrator',
      payload: { subject: '雨', predicate: '强度', object: '大了', truth: 'objective' }
    })
    expect(narration.truth).toBe('objective')
    expect(narration.downgrades).toEqual([])

    const author = classifyProposal({
      ...base,
      kind: 'world_fact',
      speakerType: 'character',
      authorConfirmed: true,
      payload: { subject: '账本', predicate: '位置', object: '祠堂', truth: 'objective' }
    })
    expect(author.truth).toBe('objective')
  })

  it('台词提出 claim → 原样保留（不是降级）', () => {
    const result = classifyProposal({
      ...base,
      kind: 'world_fact',
      speakerType: 'character',
      payload: { subject: '账本', predicate: '位置', object: '祠堂', truth: 'claim', known_by: ['chr_1'] }
    })
    expect(result.truth).toBe('claim')
    expect(result.downgrades).toEqual([])
    expect(result.payload.visibility).toBe('secret')
  })

  it('缺角色身份 / 缺三元组 → 丢弃', () => {
    expect(
      classifyProposal({ ...base, characterId: null, kind: 'experience', speakerType: 'narrator' }).drop
    ).toBe('missing_character')
    expect(
      classifyProposal({
        ...base,
        kind: 'world_fact',
        speakerType: 'narrator',
        payload: { subject: '账本' }
      }).drop
    ).toBe('world_fact_payload')
  })

  it('关系提案缺目标/轴/值 → 降级为经历，不猜边', () => {
    const result = classifyProposal({
      ...base,
      kind: 'relationship',
      speakerType: 'character',
      payload: { to_id: 'chr_2' }
    })
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('experience')
    expect(result.downgrades).toContain('relationship_payload_to_experience')
  })

  it('信念置信度夹在 0–1；关系轴与值夹紧', () => {
    const belief = classifyProposal({
      ...base,
      kind: 'belief',
      speakerType: 'character',
      payload: { confidence: 9 }
    })
    expect(belief.payload.confidence).toBe(1)

    const relation = classifyProposal({
      ...base,
      kind: 'relationship',
      speakerType: 'character',
      payload: { to_id: 'chr_2', axis: 'unknown', value: -5 }
    })
    expect(relation.payload.axis).toBe('trust')
    expect(relation.payload.value).toBe(-1)
  })
})
