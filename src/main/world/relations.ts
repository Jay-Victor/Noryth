import type { RelationshipEdgeRecord } from '../db/repos/world'
import { edgeValidAt } from './projection'

/**
 * 关系图（PHASE-14 M1-5 / UI-DESIGN §7.4 关系图）。
 *
 * 纯函数：给定 as_of、角色与关系边，产出节点 + 边 + 确定性圆环布局。
 *   - 节点 = active 角色；边 = as-of 有效的关系边（`since_seq <= as_of < valid_to_seq`）；
 *   - 宽度 = |value|，虚线 = 单向（同轴没有反向边）；
 *   - 不包含任何记忆文本：边只有轴、值、来源标识；来源面板按 source_type/source_id
 *     回到章 / 拍 / 记忆条目，私有原文不经过这里。
 *
 * 布局固定为圆环（同数据同坐标，容差 1px）：不做力导向、不做拖拽持久化，
 * 这样 E2E 才能断言「两次渲染坐标一致」。
 */

export const RELATION_VIEW_WIDTH = 640
export const RELATION_VIEW_HEIGHT = 360
const RING_MARGIN = 56

export type RelationAxis = 'trust' | 'intimacy' | 'tension'
const AXES: readonly RelationAxis[] = ['trust', 'intimacy', 'tension']

export interface RelationCharacter {
  id: string
  name: string
}

export interface RelationNodeView {
  id: string
  name: string
  x: number
  y: number
}

export interface RelationEdgeView {
  id: string
  fromId: string
  toId: string
  axis: RelationAxis
  value: number
  sinceSeq: number
  validToSeq: number | null
  sourceType: string
  sourceId: string | null
  /** 来源的人话标签（章标题 · 记忆 / 拍）；不包含任何记忆正文。 */
  sourceLabel: string
  bidirectional: boolean
}

export interface RelationGraphView {
  asOf: number
  nodes: RelationNodeView[]
  edges: RelationEdgeView[]
  counts: {
    nodes: number
    edges: number
    byAxis: Record<RelationAxis, number>
    oneWay: number
  }
}

export interface RelationGraphInput {
  asOf: number
  characters: readonly RelationCharacter[]
  edges: readonly RelationshipEdgeRecord[]
  /** 聚焦某角色邻域（>50 角色时用）：只保留该角色与直接相邻的角色。 */
  focusId?: string | null
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/** 确定性圆环：第 i 个节点在 -π/2 + 2πi/n，按传入顺序（调用方先排序）。 */
export function layoutRing(count: number, width = RELATION_VIEW_WIDTH, height = RELATION_VIEW_HEIGHT): Array<{ x: number; y: number }> {
  if (count <= 0) return []
  const centerX = width / 2
  const centerY = height / 2
  if (count === 1) return [{ x: round(centerX), y: round(centerY) }]
  const radiusX = Math.max(0, centerX - RING_MARGIN)
  const radiusY = Math.max(0, centerY - RING_MARGIN)
  return Array.from({ length: count }, (_, index) => {
    const angle = (Math.PI * 2 * index) / count - Math.PI / 2
    return { x: round(centerX + radiusX * Math.cos(angle)), y: round(centerY + radiusY * Math.sin(angle)) }
  })
}

function axisOf(value: string): RelationAxis {
  return value === 'intimacy' || value === 'tension' ? value : 'trust'
}

/**
 * as-of 关系图。排序固定 `(name, id)` 决定节点顺序与坐标，`(fromId, toId, axis, id)`
 * 决定边顺序——同一输入两次调用逐字节一致。
 */
export function buildRelationGraph(input: RelationGraphInput): RelationGraphView {
  const asOf = Math.max(0, Math.trunc(input.asOf))
  const valid = input.edges.filter((edge) => edgeValidAt(edge, asOf))

  const characters = [...input.characters].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  )
  const known = new Set(characters.map((character) => character.id))
  const focusId = input.focusId ?? null
  const inScope = new Set<string>()
  if (focusId !== null && focusId.length > 0 && known.has(focusId)) {
    inScope.add(focusId)
    for (const edge of valid) {
      if (edge.fromId === focusId) inScope.add(edge.toId)
      if (edge.toId === focusId) inScope.add(edge.fromId)
    }
  }
  const nodesSource =
    inScope.size > 0 ? characters.filter((character) => inScope.has(character.id)) : characters

  const positions = layoutRing(nodesSource.length)
  const nodes: RelationNodeView[] = nodesSource.map((character, index) => ({
    id: character.id,
    name: character.name,
    x: positions[index]!.x,
    y: positions[index]!.y
  }))
  const nodeIds = new Set(nodes.map((node) => node.id))

  const direction = new Set(valid.map((edge) => `${edge.fromId}>${edge.toId}|${axisOf(edge.axis)}`))
  const edges: RelationEdgeView[] = valid
    .filter((edge) => nodeIds.has(edge.fromId) && nodeIds.has(edge.toId))
    .map((edge) => {
      const axis = axisOf(edge.axis)
      return {
        id: edge.id,
        fromId: edge.fromId,
        toId: edge.toId,
        axis,
        value: edge.value,
        sinceSeq: edge.sinceSeq,
        validToSeq: edge.validToSeq,
        sourceType: edge.sourceType,
        sourceId: edge.sourceId,
        sourceLabel: '',
        bidirectional: direction.has(`${edge.toId}>${edge.fromId}|${axis}`)
      }
    })
    .sort(
      (left, right) =>
        left.fromId.localeCompare(right.fromId) ||
        left.toId.localeCompare(right.toId) ||
        left.axis.localeCompare(right.axis) ||
        left.id.localeCompare(right.id)
    )

  const byAxis: Record<RelationAxis, number> = { trust: 0, intimacy: 0, tension: 0 }
  for (const edge of edges) byAxis[edge.axis] += 1

  return {
    asOf,
    nodes,
    edges,
    counts: {
      nodes: nodes.length,
      edges: edges.length,
      byAxis,
      oneWay: edges.filter((edge) => !edge.bidirectional).length
    }
  }
}

export { AXES as RELATION_AXES }
