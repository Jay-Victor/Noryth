import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withTransaction } from '../../src/main/db/tx'
import { allocateSeq } from '../../src/main/db/seq'
import { hashManifestRows, type ManifestRow } from '../../src/main/db/hash'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { openTestDb } from '../unit/db/support/db'
import { tempDir } from '../unit/helpers'

/**
 * PERF-M1-01（PHASE-11 §5.2 / DEV-PLAN §11.8）：
 * 30 章 / 720 拍 / 14 万字。打开 < 800ms、切章 P95 < 120ms，且章节列表不随正文线性变慢。
 *
 * 切章的口径 = 渲染层真正要的数据：章列表摘要 + 当前章的场景与拍
 * （`write.state()` 的主体）。正文不参与列表，所以摘要查询必须与总字数无关。
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]!
}

interface Baseline {
  dir: string
  chapterIds: string[]
  projectId: string
}

function seed(): Baseline {
  const dir = tempDir('noryth-perf-m1-')
  cleanups.push(dir.cleanup)
  for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
    mkdirSync(join(dir.path, sub), { recursive: true })
  }
  const { db, repos } = openTestDb(dir.path)
  cleanups.push(() => db.close())

  const project = repos.project.create({
    title: '黑漆匣子 · 30 章',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 150_000,
    embeddingModel: 'hash-bigram-v1',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  const character = repos.character.insert({
    id: 'chr_m1',
    projectId: project.id,
    name: '沈昼',
    cardJson: '{}'
  })
  const root = repos.outline.insert({ projectId: project.id, parentId: null, kind: 'main', ord: 0, title: '主线' })
  // 每拍 ~195 字 × 720 拍 ≈ 14 万字
  const body =
    '雨落在祠堂的瓦上，她把茶盏往他那边推了推，声音压得很低，像是怕被窗外的雨听见。他数着檐下的水滴，一下，两下，三下。'.repeat(3)
  const chapterIds: string[] = []

  withTransaction(db, () => {
    for (let chapterOrd = 1; chapterOrd <= 30; chapterOrd += 1) {
      const node = repos.outline.insert({
        projectId: project.id,
        parentId: root.id,
        kind: 'chapter',
        ord: chapterOrd,
        title: `第 ${chapterOrd} 章`
      })
      const chapter = repos.chapter.insert({
        projectId: project.id,
        outlineNodeId: node.id,
        ord: chapterOrd,
        status: 'drafting'
      })
      chapterIds.push(chapter.id)
      const scenes = Array.from({ length: 3 }, (_, index) =>
        repos.scene.insert({
          projectId: project.id,
          ord: index + 1,
          location: `地点 ${index + 1}`,
          participantsJson: JSON.stringify([character.id]),
          goal: '目标',
          exitJson: '{"op":"beats","cmp":">=","value":8}',
          maxBeats: 8
        })
      )
      for (const [index, scene] of scenes.entries()) repos.scene.linkToChapter(chapter.id, scene.id, index + 1)

      const manifest: ManifestRow[] = []
      for (const [sceneIndex, scene] of scenes.entries()) {
        for (let beatOrd = 1; beatOrd <= 8; beatOrd += 1) {
          manifest.push({
            sceneId: scene.id,
            sceneOrd: sceneIndex + 1,
            beatOrd,
            speakerType: beatOrd % 2 === 1 ? 'narrator' : 'character',
            speakerId: beatOrd % 2 === 1 ? 'narrator' : character.id,
            body
          })
        }
      }
      const revision = repos.revision.insert({
        chapterId: chapter.id,
        kind: 'final',
        contentHash: hashManifestRows(manifest),
        createdBy: 'doc_controller',
        note: 'perf'
      })
      const members: Array<{ beatId: string; sceneOrd: number; beatOrd: number }> = []
      for (const member of manifest) {
        const inserted = repos.beat.insert({
          chapterId: chapter.id,
          sceneId: member.sceneId,
          ord: (member.sceneOrd - 1) * 8 + member.beatOrd,
          seq: allocateSeq(db, project.id),
          speakerType: member.speakerType,
          speakerId: member.speakerId,
          intent: '拍',
          body: member.body,
          status: 'confirmed',
          createdRevisionId: revision.id,
          wordCount: [...member.body].length
        })
        members.push({ beatId: inserted.id, sceneOrd: member.sceneOrd, beatOrd: member.beatOrd })
      }
      repos.revision.insertMembers(
        revision.id,
        members.map((member) => ({ revisionId: revision.id, ...member }))
      )
      repos.chapter.setCurrentRevision(chapter.id, revision.id)
      repos.chapter.markFinalized(chapter.id, revision.id)
    }
  })

  return { dir: dir.path, chapterIds, projectId: project.id }
}

describe('PERF-M1-01：30 章规模基线', () => {
  it('打开 < 800ms、切章 P95 < 120ms、列表摘要与正文量无关', () => {
    const baseline = seed()

    // 打开（含迁移与 PRAGMA）：第二次打开等价冷启动
    const openStarted = Date.now()
    const reopened = openTestDb(baseline.dir)
    const openMs = Date.now() - openStarted
    cleanups.push(() => reopened.db.close())
    const repos = reopened.repos

    const switchTimes: number[] = []
    for (const chapterId of baseline.chapterIds) {
      const started = Date.now()
      // write.state() 的主体：章列表摘要 + 本章场景与拍
      repos.chapter.listSummaries(baseline.projectId)
      repos.scene.listByChapter(chapterId)
      repos.beat.listLiveByChapter(chapterId)
      switchTimes.push(Date.now() - started)
    }

    const summaryTimes: number[] = []
    for (let index = 0; index < 30; index += 1) {
      const started = Date.now()
      const rows = repos.chapter.listSummaries(baseline.projectId)
      summaryTimes.push(Date.now() - started)
      if (index === 0) {
        expect(rows).toHaveLength(30)
        expect(rows.reduce((sum, row) => sum + row.wordCount, 0)).toBeGreaterThan(120_000)
      }
    }

    const p95Switch = percentile(switchTimes, 95)
    const p95Summary = percentile(summaryTimes, 95)

    // eslint-disable-next-line no-console
    console.log(
      `PERF-M1-01 打开=${openMs}ms 切章P95=${p95Switch}ms 列表摘要P95=${p95Summary}ms ` +
        `RSS=${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)}MB`
    )

    expect(openMs).toBeLessThan(800)
    expect(p95Switch).toBeLessThan(120)
    expect(p95Summary).toBeLessThan(30)
  }, 180_000)
})
