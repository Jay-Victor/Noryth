import type { BlueprintOp, ImpactResult } from '../../shared/schema/blueprint'
import type { ChapterRecord } from '../db/repos/chapter'
import type { MemoryEntryRecord } from '../db/repos/memory'
import type { OutlineNodeRecord } from '../db/repos/outline'
import type { RelationshipEdgeRecord } from '../db/repos/world'

/**
 * 影响分析（PHASE-15 M1-8 / §5.2）。
 *
 * 两条路径，缺一不可：
 *   1. outline 子树 → 章 → `memory_entry.source_chapter_id`
 *   2. 角色卡 → 该角色发言的 live 拍 → 章 / 记忆 → 以该记忆为来源的关系边
 *
 * 只读：不写库、不改正文。结果进 `blueprint_change.impact_json`，
 * 作者确认后 `plan/change.ts` 才真正应用并给受影响章标 `invalidated_at`。
 */

export interface ImpactSourceData {
  nodes: readonly OutlineNodeRecord[]
  chapters: readonly ChapterRecord[]
  memories: readonly MemoryEntryRecord[]
  /** 全部边（含已关闭），由调用方按 `validToSeq === null` 过滤。 */
  edges: readonly RelationshipEdgeRecord[]
  /** 章 → live 拍发言人（只在角色卡变更时需要，懒加载）。 */
  speakersByChapter?: ReadonlyMap<string, readonly string[]>
  now: string
}

export interface ImpactRequest {
  ops?: readonly BlueprintOp[]
  /** 角色卡变更只关心「谁」，卡片内容不参与影响面计算。 */
  characterId?: string
}

export function chapterTitleOf(nodes: readonly OutlineNodeRecord[], chapter: ChapterRecord): string {
  return nodes.find((node) => node.id === chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`
}

function subtreeIds(nodes: readonly OutlineNodeRecord[], roots: readonly string[]): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const list = childrenOf.get(node.parentId)
    if (list === undefined) childrenOf.set(node.parentId, [node.id])
    else list.push(node.id)
  }
  const result = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const id = queue.shift()!
    if (result.has(id)) continue
    result.add(id)
    for (const child of childrenOf.get(id) ?? []) queue.push(child)
  }
  return result
}

/** 纯函数：给定数据快照，算出影响面。测试直接喂数据，不经数据库。 */
export function computeImpact(data: ImpactSourceData, request: ImpactRequest): ImpactResult {
  const affectedNodeIds = new Set<string>()
  for (const op of request.ops ?? []) {
    if (op.op === 'add') continue
    for (const id of subtreeIds(data.nodes, [op.node_id])) affectedNodeIds.add(id)
  }

  const chapterIds = new Set<string>()
  for (const chapter of data.chapters) {
    if (affectedNodeIds.has(chapter.outlineNodeId)) chapterIds.add(chapter.id)
  }
  const changedCharacter = request.characterId ?? null
  if (changedCharacter !== null && data.speakersByChapter !== undefined) {
    for (const [chapterId, speakers] of data.speakersByChapter) {
      if (speakers.includes(changedCharacter)) chapterIds.add(chapterId)
    }
  }

  const memories = data.memories.filter(
    (memory) =>
      chapterIds.has(memory.sourceChapterId) ||
      (changedCharacter !== null && memory.characterId === changedCharacter)
  )
  const memoryIds = new Set(memories.map((memory) => memory.id))

  const edges = data.edges.filter((edge) => {
    if (edge.validToSeq !== null) return false
    if (changedCharacter !== null && (edge.fromId === changedCharacter || edge.toId === changedCharacter)) {
      return true
    }
    return edge.sourceType === 'memory' && edge.sourceId !== null && memoryIds.has(edge.sourceId)
  })

  const affectedChapters = data.chapters
    .filter((chapter) => chapterIds.has(chapter.id))
    .sort((left, right) => left.ord - right.ord)
    .map((chapter) => ({
      id: chapter.id,
      ord: chapter.ord,
      title: chapterTitleOf(data.nodes, chapter),
      status: chapter.status
    }))

  return {
    analyzed: true,
    analyzed_at: data.now,
    chapters: affectedChapters,
    memory_entries: memories
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((memory) => ({ id: memory.id, character_id: memory.characterId, text: memory.text })),
    relationships: edges
      .slice()
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((edge) => ({ id: edge.id, from_id: edge.fromId, to_id: edge.toId, axis: edge.axis })),
    counts: {
      chapters: affectedChapters.length,
      memory_entries: memories.length,
      relationships: edges.length
    }
  }
}

/** summary 字段：UI 与变更记录共用（不解析 ops 的差异内容）。 */
export function summarizeOps(ops: readonly BlueprintOp[], characterCards = 0): {
  added: number
  updated: number
  removed: number
  characterCards: number
} {
  let added = 0
  let updated = 0
  let removed = 0
  for (const op of ops) {
    if (op.op === 'add') added += 1
    else if (op.op === 'update') updated += 1
    else removed += 1
  }
  return { added, updated, removed, characterCards }
}
