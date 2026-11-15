import { describe, expect, it } from 'vitest'
import { computeImpact, summarizeOps } from '../../../src/main/plan/impact'
import { openPlanWorld, seedPostG1, type PlanTestWorld } from '../../support/plan-world'

/**
 * 影响分析（PHASE-15 M1-8 / §5.2）：两条路径都要覆盖。
 *   1. outline 子树 → 章 → 记忆（source_chapter_id）
 *   2. 角色卡 → 该角色发言的 live 拍 → 章 / 记忆 → 以记忆为来源的关系边
 */

describe('影响分析', () => {
  const created: PlanTestWorld[] = []
  const world = (): { world: PlanTestWorld; post: ReturnType<typeof seedPostG1> } => {
    const item = openPlanWorld()
    created.push(item)
    return { world: item, post: seedPostG1(item) }
  }
  const cleanup = (): void => {
    while (created.length > 0) created.pop()!.cleanup()
  }

  it('卷子树改动影响卷下所有章与该章记忆，不碰别的卷', () => {
    const { world: w, post } = world()
    try {
      const impact = computeImpact(
        {
          nodes: w.repos.outline.listByProject(w.projectId),
          chapters: w.repos.chapter.listByProject(w.projectId),
          memories: w.repos.memory.listByProject(w.projectId, { status: 'active' }),
          edges: w.repos.relationship.listByProject(w.projectId),
          now: '2026-11-15T00:00:00.000Z'
        },
        { ops: [{ op: 'update', node_id: post.volumeId, title: '第一卷（改）' }] }
      )
      expect(impact.analyzed).toBe(true)
      expect(impact.counts.chapters).toBe(2)
      expect(impact.chapters.map((chapter) => chapter.ord)).toEqual([1, 2])
      expect(impact.memory_entries.map((memory) => memory.id)).toEqual([post.memoryOnChapter1])
      // 边来源是「第 1 章的记忆」→ 受影响
      expect(impact.relationships.map((edge) => edge.id)).toEqual([post.edgeOnMemory])
    } finally {
      cleanup()
    }
  })

  it('只改一条主线标题时影响整棵树；改与内容无关的节点不影响任何章', () => {
    const { world: w, post } = world()
    try {
      const data = {
        nodes: w.repos.outline.listByProject(w.projectId),
        chapters: w.repos.chapter.listByProject(w.projectId),
        memories: w.repos.memory.listByProject(w.projectId, { status: 'active' }),
        edges: w.repos.relationship.listByProject(w.projectId),
        now: '2026-11-15T00:00:00.000Z'
      }
      const main = computeImpact(data, { ops: [{ op: 'update', node_id: post.mainId, title: '主线（改）' }] })
      expect(main.counts.chapters).toBe(2)

      const unknownSubtree = computeImpact(data, {
        ops: [{ op: 'update', node_id: post.chapter2NodeId, title: '第二章（改）' }]
      })
      // 第 2 章没有记忆、没有边：章受影响，但记忆/边不动。
      expect(unknownSubtree.counts.chapters).toBe(1)
      expect(unknownSubtree.chapters[0]!.id).toBe(post.chapter2Id)
      expect(unknownSubtree.counts.memory_entries).toBe(0)
      expect(unknownSubtree.counts.relationships).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('角色卡变更：该角色发言的章 + 该角色的记忆 + 相关关系边', () => {
    const { world: w, post } = world()
    try {
      const impact = computeImpact(
        {
          nodes: w.repos.outline.listByProject(w.projectId),
          chapters: w.repos.chapter.listByProject(w.projectId),
          memories: w.repos.memory.listByProject(w.projectId, { status: 'active' }),
          edges: w.repos.relationship.listByProject(w.projectId),
          speakersByChapter: new Map(
            w.repos.chapter
              .listByProject(w.projectId)
              .map((chapter) => [chapter.id, w.repos.beat.listLiveByChapter(chapter.id).map((beat) => beat.speakerId)])
          ),
          now: '2026-11-15T00:00:00.000Z'
        },
        { characterId: post.characterId }
      )
      expect(impact.counts.chapters).toBe(1)
      expect(impact.chapters[0]!.id).toBe(post.chapter1Id)
      expect(impact.memory_entries.map((memory) => memory.id)).toEqual([post.memoryOnChapter1])
      expect(impact.relationships.map((edge) => edge.id)).toEqual([post.edgeOnMemory])
    } finally {
      cleanup()
    }
  })

  it('没有内容的变更不影响任何对象（但仍是「已分析」）', () => {
    const { world: w } = world()
    try {
      const impact = computeImpact(
        {
          nodes: w.repos.outline.listByProject(w.projectId),
          chapters: w.repos.chapter.listByProject(w.projectId),
          memories: w.repos.memory.listByProject(w.projectId, { status: 'active' }),
          edges: w.repos.relationship.listByProject(w.projectId),
          now: '2026-11-15T00:00:00.000Z'
        },
        {}
      )
      expect(impact.analyzed).toBe(true)
      expect(impact.counts).toEqual({ chapters: 0, memory_entries: 0, relationships: 0 })
    } finally {
      cleanup()
    }
  })

  it('已关闭的边不计入影响面；新增 op 不影响现有章', () => {
    const { world: w, post } = world()
    try {
      w.repos.relationship.closeValidity(post.edgeOnMemory, 1)
      const data = {
        nodes: w.repos.outline.listByProject(w.projectId),
        chapters: w.repos.chapter.listByProject(w.projectId),
        memories: w.repos.memory.listByProject(w.projectId, { status: 'active' }),
        edges: w.repos.relationship.listByProject(w.projectId),
        now: '2026-11-15T00:00:00.000Z'
      }
      const impact = computeImpact(data, { ops: [{ op: 'update', node_id: post.chapter1NodeId, title: '改' }] })
      expect(impact.counts.relationships).toBe(0)

      const added = computeImpact(data, {
        ops: [
          { op: 'add', parent_id: post.volumeId, kind: 'chapter', ord: 5, title: '第三章' }
        ]
      })
      expect(added.counts.chapters).toBe(0)
    } finally {
      cleanup()
    }
  })

  it('summarizeOps 只数 op 类型；角色卡单独计数', () => {
    expect(
      summarizeOps([
        { op: 'add', parent_id: null, kind: 'main', ord: 0, title: '主线' },
        { op: 'update', node_id: 'out_1', title: '改' },
        { op: 'remove', node_id: 'out_2' }
      ], 1)
    ).toEqual({ added: 1, updated: 1, removed: 1, characterCards: 1 })
  })
})
