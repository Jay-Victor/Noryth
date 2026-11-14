import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { verifyDatabase } from '../../../src/main/db/verify'
import { hashFile } from '../../../src/main/db/hash'
import { publishPendingMirrors } from '../../../src/main/doc/publish'
import { seedSlice } from '../../../src/main/slice/seed'
import { openSliceWorld, sliceFixture } from '../../support/slice-world'

describe('切片 fixture（V1：一条命令可重建）', () => {
  it('1 项目 / 1 章 / 1 场景 / 2 拍 / 5 角色；db.verify 绿', () => {
    const w = openSliceWorld()
    try {
      expect(sliceFixture.characters).toHaveLength(5)
      expect(sliceFixture.beats).toHaveLength(2)
      expect(w.repos.chapter.listByProject(w.projectId)).toHaveLength(1)
      expect(w.repos.scene.listByProject(w.projectId)).toHaveLength(1)
      expect(w.repos.character.list(w.projectId)).toHaveLength(5)

      const beats = w.repos.beat.listByChapter(w.chapterId)
      expect(beats).toHaveLength(2)
      for (const beat of beats) {
        expect(beat.status).toBe('proposed')
        expect(beat.seq).toBeNull()
        expect(beat.body).toBe('')
      }
      expect(w.repos.revision.countMembers('rev_slice_base')).toBe(2)
      expect(w.repos.memory.listByCharacter('chr_lin')).toHaveLength(2)
      expect(w.repos.world.listByProject(w.projectId)).toHaveLength(1)

      const report = verifyDatabase(w.handle.db, { projectDir: w.dir })
      expect(report.ok, JSON.stringify(report.issues)).toBe(true)
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    } finally {
      w.cleanup()
    }
  })

  it('重复 seed 幂等：seeded=false，不重复插角色/记忆/拍', () => {
    const w = openSliceWorld()
    try {
      const again = seedSlice(w.handle.db, w.repos, sliceFixture)
      expect(again.seeded).toBe(false)
      expect(w.repos.beat.listByChapter(w.chapterId)).toHaveLength(2)
      expect(w.repos.revision.listByChapter(w.chapterId)).toHaveLength(1)
      expect(w.repos.character.list(w.projectId)).toHaveLength(5)
      expect(w.repos.memory.listByCharacter('chr_lin')).toHaveLength(2)
    } finally {
      w.cleanup()
    }
  })

  it('基线镜像可发布，hash 与 outbox 一致', () => {
    const w = openSliceWorld()
    try {
      const report = publishPendingMirrors(w.handle.db, w.dir)
      expect(report.failed).toEqual([])
      const file = join(w.dir, 'manuscript', 'ch-001.md')
      expect(existsSync(file)).toBe(true)
      const latest = w.repos.outbox.latestForChapter(w.chapterId)!
      expect(latest.publishedAt).not.toBeNull()
      expect(hashFile(file)).toBe(latest.expectedHash)
    } finally {
      w.cleanup()
    }
  })
})
