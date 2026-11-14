import { describe, expect, it } from 'vitest'
import { checkIsolation, ensureNamespaces } from '../../../src/main/memory/namespace'
import { openSliceWorld } from '../../support/slice-world'

describe('记忆命名空间与隔离自检', () => {
  it('5 私有 + 1 公共；跨角色探针 0 命中；孤儿条目会让自检失败', () => {
    const w = openSliceWorld()
    try {
      const characters = w.repos.character.list(w.projectId)
      expect(characters.length).toBe(5)
      const chapter = w.repos.chapter.get(w.chapterId)!
      const revisionId = chapter.currentRevisionId!
      const beatId = w.beatIds[0]!

      for (const character of characters.slice(0, 3)) {
        w.repos.memory.insert({
          projectId: w.projectId,
          characterId: character.id,
          kind: 'experience',
          text: `${character.name} 的一段记忆`,
          learnedSeq: 1,
          sourceChapterId: w.chapterId,
          sourceRevisionId: revisionId,
          sourceBeatId: beatId,
          embeddingModel: 'bge-small-zh-v1.5'
        })
      }

      const created = ensureNamespaces(w.repos, w.projectId)
      expect(created.namespaces.filter((item) => item.kind === 'private')).toHaveLength(5)
      expect(created.namespaces.filter((item) => item.kind === 'public')).toHaveLength(1)
      expect(created.isolationVerified).toBe(true)

      const report = checkIsolation(
        w.repos,
        w.projectId,
        characters.map((character) => character.id)
      )
      expect(report.crossCharacterHits).toBe(0)
      expect(report.orphanEntries).toBe(0)
      expect(report.verified).toBe(true)

      // 只给前两个角色建库：第三个角色的记忆是孤儿，自检必须失败。
      const partial = checkIsolation(w.repos, w.projectId, characters.slice(0, 2).map((character) => character.id))
      expect(partial.orphanEntries).toBeGreaterThan(0)
      expect(partial.verified).toBe(false)
    } finally {
      w.cleanup()
    }
  })

  it('重复建库幂等：不重复插入命名空间', () => {
    const w = openSliceWorld()
    try {
      const first = ensureNamespaces(w.repos, w.projectId)
      const second = ensureNamespaces(w.repos, w.projectId)
      expect(first.namespaces).toHaveLength(6)
      expect(second.namespaces).toHaveLength(6)
      expect(second.created).toBe(0)
      expect(w.repos.namespace.listByProject(w.projectId)).toHaveLength(6)
    } finally {
      w.cleanup()
    }
  })
})
