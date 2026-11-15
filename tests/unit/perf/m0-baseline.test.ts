import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withTransaction } from '../../../src/main/db/tx'
import { allocateSeq } from '../../../src/main/db/seq'
import type { ManifestRow } from '../../../src/main/db/hash'
import { hashManifestRows } from '../../../src/main/db/hash'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { exportManuscript } from '../../../src/main/doc/export'
import { createHashEmbedder } from '../../../src/main/memory/embed/hash'
import { retrieveOwn } from '../../../src/main/memory/retrieve'
import { openTestDb } from '../db/support/db'
import { tempDir } from '../helpers'

/**
 * PERF-01 / J5 基线（DEV-PLAN §13.7）。
 *
 * 数据量按 M0 验收口径：30 章 / 720 拍 / 约 12 万字；检索额外灌 2,000 条记忆。
 * 20k 条记忆的 vec0 KNN 已在阶段 01 S1 实测（P95 33.64ms，ADR-0001），
 * 这里跑完整检索管线（向量 + 关键词 + RRF），记录 P50/P95。
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface Baseline {
  dir: string
  chapterIds: string[]
  characterId: string
  openMs: number
}

function seed(): Baseline {
  const dir = tempDir('noryth-perf-m0-')
  cleanups.push(dir.cleanup)
  for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
    mkdirSync(join(dir.path, sub), { recursive: true })
  }
  const started = Date.now()
  const { db, repos } = openTestDb(dir.path)
  cleanups.push(() => db.close())

  const project = repos.project.create({
    title: '黑漆匣子 · 性能基线',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 120_000,
    embeddingModel: 'hash-bigram-v1',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  const character = repos.character.insert({
    id: 'chr_perf',
    projectId: project.id,
    name: '沈昼',
    cardJson: JSON.stringify({ identity: '女子', want: '账本', taboo: '父亲' })
  })
  const root = repos.outline.insert({ projectId: project.id, parentId: null, kind: 'main', ord: 0, title: '主线' })
  const chapterIds: string[] = []
  // 每拍 ~240 字 × 720 拍 ≈ 14 万字，对齐 DEV-PLAN §13.7 的 30 章 / 12 万字
  const body = '雨落在祠堂的瓦上，她把茶盏往他那边推了推，声音压得很低，像是怕被窗外的雨听见。'.repeat(5)

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
          intent: `场景 ${member.sceneOrd} 第 ${member.beatOrd} 拍`,
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

  // 2,000 条角色记忆 + 向量 + 关键词索引
  const embedder = createHashEmbedder()
  const texts = Array.from({ length: 2_000 }, (_, index) => `记忆 ${index}：账本、匣子与祠堂的雨声`)
  const vectors = withTransaction(db, () => {
    const ids: string[] = []
    for (const [index, text] of texts.entries()) {
      const entry = repos.memory.insert({
        projectId: project.id,
        characterId: character.id,
        kind: index % 3 === 0 ? 'fact' : 'experience',
        text,
        learnedSeq: 1,
        sourceChapterId: chapterIds[0]!,
        sourceRevisionId: repos.chapter.get(chapterIds[0]!)!.finalRevisionId!,
        importance: 0.5,
        embeddingModel: 'hash-bigram-v1'
      })
      ids.push(entry.id)
      repos.memoryIndex.writeBigrams(entry.id, character.id, text)
    }
    return ids
  })
  void vectors
  void embedder

  return { dir: dir.path, chapterIds, characterId: character.id, openMs: Date.now() - started }
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]!
}

describe('PERF-01：M0 性能基线', () => {
  it('30 章打开、切章、检索、导出与内存占用达标', async () => {
    const baseline = seed()
    const { db, repos } = openTestDb(baseline.dir)
    cleanups.push(() => db.close())

    // 打开（含迁移与 PRAGMA）——这里第二次打开，等价冷启动
    const openStarted = Date.now()
    const reopened = openTestDb(baseline.dir)
    const openMs = Date.now() - openStarted
    cleanups.push(() => reopened.db.close())

    // 切章：连续读 30 章的 live 拍
    const switchTimes: number[] = []
    for (const chapterId of baseline.chapterIds) {
      const started = Date.now()
      repos.beat.listLiveByChapter(chapterId)
      switchTimes.push(Date.now() - started)
    }

    // 检索：2,000 条记忆，20 次查询
    const embedder = createHashEmbedder()
    const retrieveTimes: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const started = Date.now()
      await retrieveOwn(
        repos,
        embedder,
        { text: `账本 ${index} 匣子`, topK: 5 },
        { characterId: baseline.characterId, actorId: baseline.characterId, asOf: 10_000, projectId: repos.project.get()!.id }
      )
      retrieveTimes.push(Date.now() - started)
    }

    // 导出整本
    const exportStarted = Date.now()
    const exported = exportManuscript(repos, baseline.dir, { format: 'md', includeNotes: true })
    const exportMs = Date.now() - exportStarted

    const rssMb = process.memoryUsage().rss / 1024 / 1024
    const p50 = percentile(switchTimes, 50)
    const p95Switch = percentile(switchTimes, 95)
    const p50Retrieve = percentile(retrieveTimes, 50)
    const p95Retrieve = percentile(retrieveTimes, 95)

    // eslint-disable-next-line no-console
    console.log(
      `PERF-01 打开=${openMs}ms 切章P50=${p50}ms/P95=${p95Switch}ms ` +
        `检索P50=${p50Retrieve}ms/P95=${p95Retrieve}ms 导出=${exportMs}ms(${exported.words}字) RSS=${rssMb.toFixed(0)}MB`
    )

    expect(exported.chapters).toBe(30)
    expect(exported.words).toBeGreaterThan(120_000)
    expect(openMs).toBeLessThan(800)
    expect(p95Switch).toBeLessThan(120)
    expect(p95Retrieve).toBeLessThan(80)
    expect(exportMs).toBeLessThan(2_000)
    expect(rssMb).toBeLessThan(600)
    await embedder.dispose()
  }, 180_000)
})
