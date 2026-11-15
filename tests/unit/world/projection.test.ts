import { describe, expect, it } from 'vitest'
import type {
  CharacterBeliefRecord,
  RelationshipEdgeRecord,
  WorldFactRecord
} from '../../../src/main/db/repos/world'
import { projectWorld } from '../../../src/main/world/projection'

/**
 * as-of 投影（PHASE-13 M1-3 / PRD §7.2）：
 * - 同一份数据两个 as_of 返回不同事实 / 信念 / 边；
 * - 事实与信念分开，允许矛盾；
 * - 「还不存在」（valid_from 在 as_of 之后）与「读者未知」（reveal_seq 未到 / 秘密）
 *   分开计数，不混为一谈。
 */

function fact(id: string, patch: Partial<WorldFactRecord>): WorldFactRecord {
  return {
    id,
    projectId: 'prj',
    subject: '账本',
    predicate: '位置',
    object: '祠堂',
    singleValue: 1,
    truth: 'objective',
    visibility: 'public',
    knownByJson: '[]',
    revealSeq: null,
    validFromSeq: 0,
    validToSeq: null,
    sourceType: 'author',
    sourceId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch
  }
}

function belief(id: string, patch: Partial<CharacterBeliefRecord>): CharacterBeliefRecord {
  return {
    id,
    projectId: 'prj',
    characterId: 'chr_lin',
    factId: null,
    beliefText: '账本在祠堂',
    confidence: 0.6,
    learnedSeq: 1,
    sourceType: 'inference',
    sourceId: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...patch
  }
}

function edge(id: string, patch: Partial<RelationshipEdgeRecord>): RelationshipEdgeRecord {
  return {
    id,
    projectId: 'prj',
    fromId: 'chr_lin',
    toId: 'chr_shen',
    axis: 'trust',
    value: 0.4,
    sinceSeq: 0,
    validToSeq: null,
    sourceType: 'event',
    sourceId: null,
    supersedesId: null,
    ...patch
  }
}

const facts = [
  // 第 1 章产生，读者第 5 序看到
  fact('wf_old', { object: '祠堂', validFromSeq: 5, revealSeq: 5 }),
  // 第 1 章产生，但第 100 序才揭示（旧事实、读者未知）
  fact('wf_late_reveal', { subject: '沈老太爷', predicate: '秘密', object: '早夭的名字', validFromSeq: 5, revealSeq: 100 }),
  // 第 100 序才产生（as_of=30 时还不存在）
  fact('wf_future', { object: '夹层', validFromSeq: 100, revealSeq: 100 }),
  // 秘密事实：永不进读者视图
  fact('wf_secret', { subject: '林砚', predicate: '身份', object: '账房学徒', visibility: 'secret', validFromSeq: 1, knownByJson: '["chr_lin"]' }),
  // 声称：与事实并存，不合并
  fact('wf_claim', { subject: '账本', predicate: '归属', object: '林家', truth: 'claim', validFromSeq: 5 })
]

const beliefs = [
  belief('bel_early', { learnedSeq: 10 }),
  belief('bel_late', { beliefText: '账本被沈家拿走了', learnedSeq: 40 }),
  belief('bel_off', { status: 'inactive', learnedSeq: 5 })
]

const edges = [
  edge('rel_early', { sinceSeq: 2 }),
  edge('rel_closed', { sinceSeq: 2, validToSeq: 20 }),
  edge('rel_late', { sinceSeq: 50 })
]

describe('世界状态 as-of 投影', () => {
  it('两个 as_of 返回不同事实 / 信念 / 边', () => {
    const at30 = projectWorld({ asOf: 30, facts, beliefs, edges })
    const at100 = projectWorld({ asOf: 100, facts, beliefs, edges })

    expect(at30.facts.map((item) => item.id).sort()).toEqual(['wf_claim', 'wf_late_reveal', 'wf_old', 'wf_secret'])
    expect(at30.counts.futureFacts).toBe(1)
    expect(at30.counts.facts).toBe(4)
    expect(at30.counts.objective).toBe(3)
    expect(at30.counts.claim).toBe(1)

    // 第 100 序：新事实出现，旧事实仍在（多值/不同谓词）
    expect(at100.facts.map((item) => item.id).sort()).toEqual(['wf_claim', 'wf_future', 'wf_late_reveal', 'wf_old', 'wf_secret'])
    expect(at100.counts.futureFacts).toBe(0)

    // 信念按学习序截断；软失效的不出现
    expect(at30.beliefs.map((item) => item.id)).toEqual(['bel_early'])
    expect(at100.beliefs.map((item) => item.id).sort()).toEqual(['bel_early', 'bel_late'])

    // 关系边按 since/valid_to 截断
    expect(at30.edges.map((item) => item.id)).toEqual(['rel_early'])
    expect(at100.edges.map((item) => item.id).sort()).toEqual(['rel_early', 'rel_late'])
  })

  it('读者已知只由 reveal_seq 决定：旧事实未揭示 ≠ 不存在', () => {
    const at30 = projectWorld({ asOf: 30, facts, beliefs, edges })
    const lateReveal = at30.facts.find((item) => item.id === 'wf_late_reveal')!
    // 事实存在（审批/记忆能看），但读者不知道。
    expect(lateReveal.readerKnown).toBe(false)
    expect(lateReveal.pendingReveal).toBe(true)

    const future = at30.facts.find((item) => item.id === 'wf_future')
    // 还不存在：不在 facts 里，只在 futureFacts 计数里。
    expect(future).toBeUndefined()
    expect(at30.counts.futureFacts).toBe(1)

    const secret = at30.facts.find((item) => item.id === 'wf_secret')!
    expect(secret.readerKnown).toBe(false)
    expect(secret.pendingReveal).toBe(false) // 秘密不是「公开待揭示」
    expect(at30.counts.readerKnown).toBe(1) // 只有 wf_old 已揭示
    expect(at30.counts.notYetRevealed).toBe(3)
  })

  it('事实有效期用自身 valid_from/to 判，与叙事阅读顺序无关', () => {
    const closed = projectWorld({
      asOf: 10,
      facts: [fact('wf_closed', { validFromSeq: 2, validToSeq: 8 })],
      beliefs: [],
      edges: []
    })
    expect(closed.facts).toHaveLength(0)
    expect(closed.counts.futureFacts).toBe(0)
    const open = projectWorld({
      asOf: 7,
      facts: [fact('wf_closed', { validFromSeq: 2, validToSeq: 8 })],
      beliefs: [],
      edges: []
    })
    expect(open.facts).toHaveLength(1)
  })

  it('同一输入两次调用结果完全一致（排序确定）', () => {
    const first = projectWorld({ asOf: 30, facts, beliefs, edges })
    const second = projectWorld({ asOf: 30, facts: [...facts].reverse(), beliefs: [...beliefs].reverse(), edges: [...edges].reverse() })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('as_of 低于 0 或非整数时按 0 处理', () => {
    const projected = projectWorld({ asOf: -5, facts, beliefs, edges })
    expect(projected.asOf).toBe(0)
    expect(projected.facts).toHaveLength(0)
    expect(projected.counts.futureFacts).toBe(5)
  })
})
