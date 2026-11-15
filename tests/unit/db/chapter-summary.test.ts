import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { withTransaction } from '../../../src/main/db/tx'
import { allocateSeq } from '../../../src/main/db/seq'
import { hashManifestRows } from '../../../src/main/db/hash'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { openTestDb } from './support/db'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/**
 * 章节列表摘要（PHASE-11 M1-9）：
 * 列表只发计数，不读正文；superseded 不进计数，作者手改算已确认。
 */
describe('chapter.listSummaries', () => {
  it('30 章摘要：计数正确、不读正文、superseded 不计入', () => {
    const dir = tempDir('noryth-chapter-summary-')
    cleanups.push(dir.cleanup)
    mkdirSync(join(dir.path, 'manuscript'), { recursive: true })
    const { db, repos } = openTestDb(dir.path)
    cleanups.push(() => db.close())

    const project = repos.project.create({
      title: '摘要',
      genre: '悬疑',
      pov: 'third_limited',
      targetWords: 100_000,
      embeddingModel: 'hash-bigram-v1',
      embeddingDim: 512,
      defaultPreset: 'deepseek',
      schemaVersion: LATEST_SCHEMA_VERSION
    })
    const character = repos.character.insert({
      id: 'chr_summary',
      projectId: project.id,
      name: '沈昼',
      cardJson: '{}'
    })
    const root = repos.outline.insert({ projectId: project.id, parentId: null, kind: 'main', ord: 0, title: '主线' })

    const chapterIds: string[] = []
    withTransaction(db, () => {
      for (let ord = 1; ord <= 30; ord += 1) {
        const node = repos.outline.insert({
          projectId: project.id,
          parentId: root.id,
          kind: 'chapter',
          ord,
          title: `第 ${ord} 章`
        })
        const chapter = repos.chapter.insert({
          projectId: project.id,
          outlineNodeId: node.id,
          ord,
          status: ord === 1 ? 'drafting' : 'planned'
        })
        chapterIds.push(chapter.id)

        const scenes = Array.from({ length: 2 }, (_, index) =>
          repos.scene.insert({
            projectId: project.id,
            ord: index + 1,
            location: '地点',
            participantsJson: JSON.stringify([character.id]),
            goal: '目标',
            exitJson: '{"op":"beats","cmp":">=","value":4}',
            maxBeats: 4
          })
        )
        for (const [index, scene] of scenes.entries()) repos.scene.linkToChapter(chapter.id, scene.id, index + 1)

        const members = scenes.flatMap((scene, sceneIndex) =>
          Array.from({ length: 4 }, (_, beatIndex) => ({
            sceneId: scene.id,
            sceneOrd: sceneIndex + 1,
            beatOrd: beatIndex + 1,
            speakerType: 'narrator' as const,
            speakerId: 'narrator',
            body: `第 ${ord} 章第 ${sceneIndex + 1} 场第 ${beatIndex + 1} 拍正文`
          }))
        )
        const revision = repos.revision.insert({
          chapterId: chapter.id,
          kind: 'draft',
          contentHash: hashManifestRows(members),
          createdBy: 'doc_controller',
          note: null
        })
        const inserted: Array<{ beatId: string; sceneOrd: number; beatOrd: number }> = []
        for (const member of members) {
          const beat = repos.beat.insert({
            chapterId: chapter.id,
            sceneId: member.sceneId,
            ord: (member.sceneOrd - 1) * 4 + member.beatOrd,
            seq: allocateSeq(db, project.id),
            speakerType: 'narrator',
            speakerId: 'narrator',
            intent: '拍',
            body: member.body,
            status: 'confirmed',
            createdRevisionId: revision.id,
            wordCount: [...member.body].length
          })
          inserted.push({ beatId: beat.id, sceneOrd: member.sceneOrd, beatOrd: member.beatOrd })
        }
        repos.revision.insertMembers(
          revision.id,
          inserted.map((member) => ({ revisionId: revision.id, ...member }))
        )
        repos.chapter.setCurrentRevision(chapter.id, revision.id)
      }
    })

    // 第 1 章：1 拍作者手改、1 拍 superseded、加 1 拍待确认。
    const firstChapterBeats = repos.beat.listLiveByChapter(chapterIds[0]!)
    repos.beat.setStatus(firstChapterBeats[0]!.id, 'author_edited')
    repos.beat.setStatus(firstChapterBeats[1]!.id, 'superseded')
    repos.beat.setStatus(firstChapterBeats[2]!.id, 'waiting_for_human')

    const summaries = repos.chapter.listSummaries(project.id)
    expect(summaries).toHaveLength(30)
    expect(summaries[0]).toMatchObject({
      ord: 1,
      title: '第 1 章',
      status: 'drafting',
      sceneCount: 2,
      beatCount: 7, // 8 - 1 superseded
      confirmedCount: 6 // 7 拍里 1 拍待确认；author_edited 计入已确认
    })
    expect(summaries[0]!.wordCount).toBeGreaterThan(0)
    expect(summaries[29]!.title).toBe('第 30 章')

    // 结构不变量：摘要行没有正文/依据字段（列表不发正文）。
    for (const summary of summaries) {
      expect(Object.keys(summary).sort()).toEqual(
        ['beatCount', 'confirmedCount', 'finalized', 'id', 'invalidatedAt', 'ord', 'sceneCount', 'status', 'title', 'wordCount'].sort()
      )
    }
  })
})
