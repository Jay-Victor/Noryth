import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateSeq } from '../../../src/main/db/seq'
import { withTransaction } from '../../../src/main/db/tx'
import { hashManifestRows, hashText } from '../../../src/main/db/hash'
import type { ManifestBeatRow } from '../../../src/main/db/revision'
import { chapterMirrorRelPath, renderChapterMarkdown } from '../../../src/main/doc/mirror'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { openTestDb } from './support/db'
import { publishOutbox } from './support/outbox'
import { makeService, tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface LargeProject {
  dir: string
  projectId: string
  characters: number
  beats: number
}

/** 30 章 / 每章 3 场 24 拍 / 约 12 万字（PHASE-02 §6 性能验收）。 */
function seedLargeProject(): LargeProject {
  const dir = tempDir('noryth-30ch-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const { db, repos } = handle
  for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
    mkdirSync(join(dir.path, sub), { recursive: true })
  }

  let characters = 0
  let beats = 0
  let chars = 0
  const projectId = withTransaction(db, () => {
    const project = repos.project.create({
      title: '三十章合成项目',
      genre: '悬疑',
      pov: 'third_limited',
      targetWords: 120000,
      embeddingModel: 'bge-small-zh-v1.5',
      embeddingDim: 512,
      defaultPreset: 'deepseek',
      schemaVersion: LATEST_SCHEMA_VERSION
    })
    const root = repos.outline.insert({
      projectId: project.id,
      parentId: null,
      kind: 'main',
      ord: 0,
      title: '主线'
    })
    for (let index = 1; index <= 3; index += 1) {
      repos.character.insert({
        id: `chr_${index}`,
        projectId: project.id,
        name: `角色${index}`,
        cardJson: '{}'
      })
      characters += 1
    }

    for (let chapterOrd = 1; chapterOrd <= 30; chapterOrd += 1) {
      const chapterId = `ch_${String(chapterOrd).padStart(3, '0')}`
      const node = repos.outline.insert({
        id: `out_${chapterId}`,
        projectId: project.id,
        parentId: root.id,
        kind: 'chapter',
        ord: chapterOrd,
        title: `第${chapterOrd}章`
      })
      repos.chapter.insert({
        id: chapterId,
        projectId: project.id,
        outlineNodeId: node.id,
        ord: chapterOrd,
        status: 'drafting'
      })

      const manifest: ManifestBeatRow[] = []
      for (let sceneOrd = 1; sceneOrd <= 3; sceneOrd += 1) {
        const sceneId = `scn_${String(chapterOrd).padStart(3, '0')}_${sceneOrd}`
        repos.scene.insert({
          id: sceneId,
          projectId: project.id,
          ord: (chapterOrd - 1) * 3 + sceneOrd,
          location: `场景${sceneOrd}`,
          participantsJson: '["chr_1"]',
          goal: '推进',
          exitJson: '{}',
          status: 'open'
        })
        repos.scene.linkToChapter(chapterId, sceneId, sceneOrd)
        for (let beatOrd = 1; beatOrd <= 8; beatOrd += 1) {
          const beatId = `bt_${chapterOrd}_${sceneOrd}_${beatOrd}`
          const body = `第${chapterOrd}章第${sceneOrd}场第${beatOrd}拍：${'雨'.repeat(160)}`
          chars += body.length
          manifest.push({
            beatId,
            sceneId,
            sceneOrd,
            beatOrd,
            speakerType: 'narrator',
            speakerId: 'narrator',
            body
          })
        }
      }

      const revisionId = `rev_${chapterId}`
      repos.revision.insert({
        id: revisionId,
        chapterId,
        parentRevisionId: null,
        kind: 'draft',
        contentHash: hashManifestRows(manifest),
        createdBy: 'author'
      })
      for (const member of manifest) {
        const seq = allocateSeq(db, project.id)
        repos.beat.insert({
          id: member.beatId,
          chapterId,
          sceneId: member.sceneId,
          ord: member.beatOrd,
          seq,
          speakerType: 'narrator',
          speakerId: 'narrator',
          body: member.body,
          status: 'draft',
          createdRevisionId: revisionId,
          wordCount: member.body.length
        })
        beats += 1
      }
      repos.revision.insertMembers(
        revisionId,
        manifest.map((member) => ({
          revisionId,
          beatId: member.beatId,
          sceneOrd: member.sceneOrd,
          beatOrd: member.beatOrd
        }))
      )
      repos.chapter.setCurrentRevision(chapterId, revisionId)

      const content = renderChapterMarkdown(db, { chapterId, revisionId })
      repos.outbox.enqueue({
        projectId: project.id,
        chapterId,
        revisionId,
        path: chapterMirrorRelPath(chapterOrd),
        expectedHash: hashText(content)
      })
    }

    return project.id
  })

  const report = publishOutbox(db, dir.path)
  expect(report.published).toHaveLength(30)
  expect(chars).toBeGreaterThanOrEqual(120000)

  return { dir: dir.path, projectId, characters, beats }
}

describe('30 章项目性能', () => {
  it('打开项目（含迁移检查与 verify）< 800ms', () => {
    const large = seedLargeProject()
    const userData = tempDir('noryth-30ch-userdata-')
    cleanups.push(userData.cleanup)
    const { service } = makeService(userData.path)
    try {
      const start = performance.now()
      const opened = service.open({ path: large.dir })
      const elapsed = performance.now() - start

      expect(opened.project.id).toBe(large.projectId)
      expect(opened.project.chapterCount).toBe(0)
      expect(large.beats).toBe(720)
      expect(large.characters).toBe(3)
      expect(service.verifyCurrent()!.ok).toBe(true)
      expect(elapsed, `project open took ${elapsed.toFixed(1)}ms`).toBeLessThan(800)
    } finally {
      service.dispose()
    }
  })
})
