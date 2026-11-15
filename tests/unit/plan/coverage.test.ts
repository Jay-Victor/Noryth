import { describe, expect, it } from 'vitest'
import {
  MAINLINE_MAX_GAP,
  analyzeCoverage,
  coverageBlockers,
  filterCoverageByScope,
  type CoverageCharacter,
  type CoverageNode
} from '../../../src/main/plan/coverage'
import { parseBlueprintMeta, blueprintMetaJson } from '../../../src/shared/schema/blueprint'

/**
 * 覆盖检查（PHASE-15 M1-11 / §5.1）：4 类确定性规则。
 *
 * 关键约束：
 * - 只有「明确冲突」才阻断（关键事件无落点 / 角色无出场章 / POV 不存在或已归档）；
 * - 主线间隔只建议；
 * - `meta_json` 全空只给一条「未标注」建议，老项目升级不被卡。
 */

interface NodeSpec {
  id: string
  kind: 'main' | 'volume' | 'chapter'
  parentId: string | null
  ord?: number
  title?: string
  meta?: Record<string, unknown>
}

function node(spec: NodeSpec): CoverageNode {
  return {
    id: spec.id,
    parentId: spec.parentId,
    kind: spec.kind,
    ord: spec.ord ?? 0,
    title: spec.title ?? spec.id,
    metaJson: spec.meta === undefined ? '{}' : blueprintMetaJson(spec.meta as never)
  }
}

const characters: CoverageCharacter[] = [
  { id: 'chr_a', name: '沈昼', archived: false },
  { id: 'chr_b', name: '沈砚', archived: false },
  { id: 'chr_old', name: '老太爷', archived: true }
]

function base(): CoverageNode[] {
  return [
    node({ id: 'main', kind: 'main', parentId: null }),
    node({
      id: 'vol1',
      kind: 'volume',
      parentId: 'main',
      title: '第一卷',
      meta: { key_events: [{ id: 'ev1', text: '匣子失踪', chapter_node_id: 'ch1' }], character_ids: ['chr_a'] }
    }),
    node({ id: 'ch1', kind: 'chapter', parentId: 'vol1', ord: 0, title: '第一章', meta: { character_ids: ['chr_a'], mainline: true } }),
    node({ id: 'ch2', kind: 'chapter', parentId: 'vol1', ord: 1, title: '第二章' })
  ]
}

describe('覆盖检查 4 类规则', () => {
  it('规则 1：关键事件有章落点 → 通过；没有落点 / 落点不在本卷 → 阻断', () => {
    const ok = analyzeCoverage({ nodes: base(), characters })
    expect(ok.filter((gap) => gap.code === 'key_event_unlanded')).toHaveLength(0)

    const nodes = base()
    nodes[1] = node({
      id: 'vol1',
      kind: 'volume',
      parentId: 'main',
      title: '第一卷',
      meta: { key_events: [{ id: 'ev1', text: '匣子失踪' }], character_ids: ['chr_a'] }
    })
    const missing = analyzeCoverage({ nodes, characters }).filter((gap) => gap.code === 'key_event_unlanded')
    expect(missing).toHaveLength(1)
    expect(missing[0]!.severity).toBe('error')
    expect(missing[0]!.node_id).toBe('vol1')

    const outside = base()
    outside.push(node({ id: 'vol2', kind: 'volume', parentId: 'main', ord: 1, title: '第二卷' }))
    outside.push(node({ id: 'ch9', kind: 'chapter', parentId: 'vol2', ord: 0, title: '第九章' }))
    outside[1] = node({
      id: 'vol1',
      kind: 'volume',
      parentId: 'main',
      title: '第一卷',
      meta: { key_events: [{ id: 'ev1', text: '匣子失踪', chapter_node_id: 'ch9' }], character_ids: ['chr_a'] }
    })
    const wrongVolume = analyzeCoverage({ nodes: outside, characters }).filter(
      (gap) => gap.code === 'key_event_unlanded'
    )
    expect(wrongVolume).toHaveLength(1)
    expect(wrongVolume[0]!.message).toContain('不在本卷内')
  })

  it('规则 2：卷纲角色没有任何出场章 → 阻断（带 character_id 便于定位角色卡）', () => {
    const nodes = base()
    nodes[1] = node({
      id: 'vol1',
      kind: 'volume',
      parentId: 'main',
      title: '第一卷',
      meta: { key_events: [{ id: 'ev1', text: '匣子失踪', chapter_node_id: 'ch1' }], character_ids: ['chr_a', 'chr_b'] }
    })
    const gaps = analyzeCoverage({ nodes, characters }).filter((gap) => gap.code === 'character_uncast')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.severity).toBe('error')
    expect(gaps[0]!.character_id).toBe('chr_b')
  })

  it('规则 3：主线推进间隔 > 5 章只给建议，不阻断', () => {
    const nodes: CoverageNode[] = [
      node({ id: 'main', kind: 'main', parentId: null }),
      node({ id: 'vol1', kind: 'volume', parentId: 'main', title: '第一卷' })
    ]
    for (let index = 0; index < MAINLINE_MAX_GAP + 3; index += 1) {
      nodes.push(
        node({
          id: `ch${index}`,
          kind: 'chapter',
          parentId: 'vol1',
          ord: index,
          title: `第 ${index + 1} 章`,
          meta: index === 0 ? { mainline: true } : {}
        })
      )
    }
    nodes.push(
      node({
        id: 'ch_last',
        kind: 'chapter',
        parentId: 'vol1',
        ord: MAINLINE_MAX_GAP + 2,
        title: '末章',
        meta: { mainline: true }
      })
    )
    const gaps = analyzeCoverage({ nodes, characters }).filter((gap) => gap.code === 'mainline_gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.severity).toBe('warn')
    expect(gaps[0]!.message).toContain(`断了 ${MAINLINE_MAX_GAP + 2} 章`)
    expect(coverageBlockers(gaps)).toEqual([])
  })

  it('规则 4：章纲 POV 不在角色表 / 已归档 → 阻断', () => {
    const nodes = base()
    nodes[2] = node({
      id: 'ch1',
      kind: 'chapter',
      parentId: 'vol1',
      ord: 0,
      title: '第一章',
      meta: { character_ids: ['chr_a'], pov_character_id: 'chr_ghost' }
    })
    const unknown = analyzeCoverage({ nodes, characters }).filter((gap) => gap.code === 'pov_missing')
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.severity).toBe('error')
    expect(unknown[0]!.message).toContain('不在角色表')

    const archived = base()
    archived[2] = node({
      id: 'ch1',
      kind: 'chapter',
      parentId: 'vol1',
      ord: 0,
      title: '第一章',
      meta: { character_ids: ['chr_a'], pov_character_id: 'chr_old' }
    })
    const gaps = analyzeCoverage({ nodes: archived, characters }).filter((gap) => gap.code === 'pov_missing')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.message).toContain('已归档')
  })

  it('meta 全空：只给一条「未标注」建议，不禁 G1（老项目升级不被卡）', () => {
    const nodes: CoverageNode[] = [
      node({ id: 'main', kind: 'main', parentId: null }),
      node({ id: 'vol1', kind: 'volume', parentId: 'main', title: '第一卷' }),
      node({ id: 'ch1', kind: 'chapter', parentId: 'vol1', ord: 0, title: '第一章' }),
      node({ id: 'ch2', kind: 'chapter', parentId: 'vol1', ord: 1, title: '第二章' })
    ]
    const gaps = analyzeCoverage({ nodes, characters })
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.code).toBe('meta_unannotated')
    expect(gaps[0]!.severity).toBe('warn')
    expect(gaps[0]!.message).toContain('3 个卷/章')
    expect(coverageBlockers(gaps)).toEqual([])
  })

  it('scope 过滤：volume / chapter / project', () => {
    const nodes = base()
    nodes[2] = node({
      id: 'ch1',
      kind: 'chapter',
      parentId: 'vol1',
      ord: 0,
      title: '第一章',
      meta: { character_ids: ['chr_a'], pov_character_id: 'chr_ghost' }
    })
    nodes[1] = node({
      id: 'vol1',
      kind: 'volume',
      parentId: 'main',
      title: '第一卷',
      meta: { key_events: [{ id: 'ev1', text: '匣子失踪' }], character_ids: ['chr_a'] }
    })
    const gaps = analyzeCoverage({ nodes, characters })
    expect(filterCoverageByScope(gaps, 'volume', nodes).every((gap) => gap.node_id === 'vol1')).toBe(true)
    expect(filterCoverageByScope(gaps, 'chapter', nodes).every((gap) => gap.node_id === 'ch1')).toBe(true)
    expect(filterCoverageByScope(gaps, 'project', nodes)).toHaveLength(gaps.length)
  })
})

describe('meta_json 归一化', () => {
  it('只保留已知字段；非法 JSON / 数组 / 缺 id 的事件都丢弃', () => {
    expect(parseBlueprintMeta('not json')).toEqual({})
    expect(parseBlueprintMeta('[1,2,3]')).toEqual({})
    expect(
      parseBlueprintMeta(
        JSON.stringify({
          key_events: [{ id: 'ev1', text: '有落点', chapter_node_id: 'ch1' }, { text: '没有 id' }],
          character_ids: ['chr_a', 42],
          pov_character_id: 'chr_a',
          mainline: true,
          unknown: '丢弃'
        })
      )
    ).toEqual({
      key_events: [{ id: 'ev1', text: '有落点', chapter_node_id: 'ch1' }],
      character_ids: ['chr_a'],
      pov_character_id: 'chr_a',
      mainline: true
    })
  })

  it('序列化只写已知字段（未知字段永远不落库）', () => {
    const json = blueprintMetaJson({ mainline: true } as never)
    expect(JSON.parse(json)).toEqual({ mainline: true })
  })
})
