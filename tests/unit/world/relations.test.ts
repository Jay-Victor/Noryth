import { describe, expect, it } from 'vitest'
import type { RelationshipEdgeRecord } from '../../../src/main/db/repos/world'
import {
  buildRelationGraph,
  layoutRing,
  RELATION_VIEW_HEIGHT,
  RELATION_VIEW_WIDTH
} from '../../../src/main/world/relations'

/**
 * 关系图（PHASE-14 M1-5 / UI-DESIGN §7.4）。
 *
 * 验收要证明的四件事：
 *   1. as-of 回放：两个 as_of 的边值不同（关闭的边在之后消失、新边在之后出现）；
 *   2. 单向 = 没有反向边（UI 画虚线），双向 = 同轴反向边存在；
 *   3. 确定性布局：同数据两次渲染坐标一致（容差 1px 由整数/两位小数保证）；
 *   4. 只给来源标识与「章 · 记忆/拍」标签，不含任何私有记忆正文。
 */

function edge(id: string, patch: Partial<RelationshipEdgeRecord> = {}): RelationshipEdgeRecord {
  return {
    id,
    projectId: 'prj',
    fromId: 'chr_shen',
    toId: 'chr_lin',
    axis: 'trust',
    value: 0.4,
    sinceSeq: 1,
    validToSeq: null,
    sourceType: 'memory',
    sourceId: `mem_${id}`,
    supersedesId: null,
    ...patch
  }
}

const CHARACTERS = [
  { id: 'chr_shen', name: '沈昼' },
  { id: 'chr_lin', name: '林砚' },
  { id: 'chr_mu', name: '穆掌柜' }
]

describe('关系图投影', () => {
  it('as-of 回放：同一对角色在两个 as_of 的边值不同', () => {
    const edges = [
      edge('rel_old', { value: 0.2, sinceSeq: 1, validToSeq: 20 }),
      edge('rel_new', { value: 0.85, sinceSeq: 20 })
    ]
    const early = buildRelationGraph({ asOf: 10, characters: CHARACTERS, edges })
    const late = buildRelationGraph({ asOf: 20, characters: CHARACTERS, edges })

    expect(early.edges.map((item) => item.id)).toEqual(['rel_old'])
    expect(early.edges[0]!.value).toBe(0.2)
    expect(late.edges.map((item) => item.id)).toEqual(['rel_new'])
    expect(late.edges[0]!.value).toBe(0.85)
    // 历史边仍在数据里（不是物理删除），只是 as_of 20 不再有效
    expect(early.counts.edges).toBe(1)
    expect(late.counts.edges).toBe(1)
  })

  it('单向 = 没有反向边；加一条反向边后双向', () => {
    const oneWay = buildRelationGraph({
      asOf: 30,
      characters: CHARACTERS,
      edges: [edge('rel_a', { value: 0.5 })]
    })
    expect(oneWay.edges[0]!.bidirectional).toBe(false)
    expect(oneWay.counts.oneWay).toBe(1)

    const twoWay = buildRelationGraph({
      asOf: 30,
      characters: CHARACTERS,
      edges: [edge('rel_a', { value: 0.5 }), edge('rel_b', { fromId: 'chr_lin', toId: 'chr_shen', value: -0.2 })]
    })
    expect(twoWay.edges.every((item) => item.bidirectional)).toBe(true)
    expect(twoWay.counts.oneWay).toBe(0)
  })

  it('三轴分色计数与宽度输入（|value| 由渲染层换算）', () => {
    const graph = buildRelationGraph({
      asOf: 30,
      characters: CHARACTERS,
      edges: [
        edge('rel_trust', { axis: 'trust', value: 0.6 }),
        edge('rel_intimacy', { axis: 'intimacy', value: -0.3 }),
        edge('rel_tension', { axis: 'tension', value: 0.9 })
      ]
    })
    expect(graph.counts.byAxis).toEqual({ trust: 1, intimacy: 1, tension: 1 })
    expect(graph.edges.map((item) => item.axis).sort()).toEqual(['intimacy', 'tension', 'trust'])
  })

  it('确定性布局：同数据两次调用逐字段一致，节点顺序按姓名', () => {
    const input = { asOf: 30, characters: CHARACTERS, edges: [edge('rel_a')] }
    const first = buildRelationGraph(input)
    const second = buildRelationGraph({ ...input, characters: [...CHARACTERS].reverse() })
    expect(second.nodes).toEqual(first.nodes)
    expect(second.edges).toEqual(first.edges)

    // 圆环坐标可预测：第一个节点在正上方
    const ring = layoutRing(3)
    expect(ring[0]!.x).toBe(RELATION_VIEW_WIDTH / 2)
    expect(ring[0]!.y).toBeCloseTo(RELATION_VIEW_HEIGHT / 2 - (RELATION_VIEW_HEIGHT / 2 - 56), 1)
    for (const node of first.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0)
      expect(node.x).toBeLessThanOrEqual(RELATION_VIEW_WIDTH)
      expect(node.y).toBeGreaterThanOrEqual(0)
      expect(node.y).toBeLessThanOrEqual(RELATION_VIEW_HEIGHT)
    }
  })

  it('聚焦角色：只保留该角色与直接相邻的角色', () => {
    const edges = [
      edge('rel_a', { fromId: 'chr_shen', toId: 'chr_lin' }),
      edge('rel_b', { fromId: 'chr_mu', toId: 'chr_lin', axis: 'tension', value: 0.3 })
    ]
    const focused = buildRelationGraph({ asOf: 30, characters: CHARACTERS, edges, focusId: 'chr_shen' })
    expect(focused.nodes.map((node) => node.name)).toEqual(['林砚', '沈昼'])
    expect(focused.edges.map((item) => item.id)).toEqual(['rel_a'])
  })

  it('不泄露私有记忆文本：只有来源标识与轴/值', () => {
    const graph = buildRelationGraph({ asOf: 30, characters: CHARACTERS, edges: [edge('rel_a', { sourceId: 'mem_secret' })] })
    const serialized = JSON.stringify(graph)
    expect(serialized).toContain('mem_secret')
    expect(serialized).not.toContain('账本')
    expect(Object.keys(graph.edges[0]!).sort()).toEqual(
      [
        'axis',
        'bidirectional',
        'fromId',
        'id',
        'sinceSeq',
        'sourceId',
        'sourceLabel',
        'sourceType',
        'toId',
        'validToSeq',
        'value'
      ].sort()
    )
  })
})
