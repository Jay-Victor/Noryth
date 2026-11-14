import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import fixtureFile from '../../../fixtures/m0-a/project.json'
import type { Repos } from '../../../../src/main/db/repos'
import type { Db } from '../../../../src/main/db/project-db'
import { allocateSeq } from '../../../../src/main/db/seq'
import { withTransaction } from '../../../../src/main/db/tx'
import { hashManifestRows, hashText } from '../../../../src/main/db/hash'
import type { ManifestBeatRow } from '../../../../src/main/db/revision'
import { OutboxPublisher } from '../../../../src/main/db/outbox'
import { chapterMirrorRelPath, renderChapterMarkdown } from '../../../../src/main/doc/mirror'
import { LATEST_SCHEMA_VERSION } from '../../../../src/main/db/migrations'
import { PROJECT_SUBDIRS } from '../../../../src/main/project/paths'

export type SpeakerType = 'character' | 'narrator'

export interface FixtureBeat {
  speakerType: SpeakerType
  speakerId: string
  body: string
}

export interface FixtureScene {
  id: string
  ord: number
  location: string
  participants: string[]
  goal: string
  entry: string
  exit: Record<string, unknown>
  beats: FixtureBeat[]
}

export interface FixtureChapter {
  id: string
  ord: number
  title: string
  scenes: FixtureScene[]
}

export interface FixtureFile {
  project: {
    title: string
    genre: string
    pov: 'first' | 'third_limited' | 'third_omniscient'
    targetWords: number
    embeddingModel: string
    embeddingDim: number
    defaultPreset: 'openai' | 'deepseek' | 'tongyi'
  }
  characters: Array<{ id: string; name: string; card: Record<string, unknown> }>
  chapters: FixtureChapter[]
}

export const fixture = fixtureFile as unknown as FixtureFile

export interface SeededChapter {
  id: string
  revisionId: string
  sceneIds: string[]
  seqStart: number
  seqEnd: number
}

export interface SeedResult {
  projectId: string
  chapterIds: string[]
  chapters: SeededChapter[]
  characterIds: string[]
}

export function prepareProjectDir(projectDir: string): void {
  for (const sub of PROJECT_SUBDIRS) mkdirSync(join(projectDir, sub), { recursive: true })
}

/**
 * 合成 fixture（PHASE-02 §2.1）：5 角色 / 2 章 / 每章 3 场 24 拍。
 * 每章一个基线 revision，写完 outbox 后发布 Markdown 镜像，供 verify/backup 使用。
 */
export function seedFixture(db: Db, repos: Repos, projectDir: string): SeedResult {
  prepareProjectDir(projectDir)
  const data = fixture
  const seeded = withTransaction(db, (): SeedResult => {
    const project = repos.project.create({
      title: data.project.title,
      genre: data.project.genre,
      pov: data.project.pov,
      targetWords: data.project.targetWords,
      embeddingModel: data.project.embeddingModel,
      embeddingDim: data.project.embeddingDim,
      defaultPreset: data.project.defaultPreset,
      schemaVersion: LATEST_SCHEMA_VERSION
    })

    for (const character of data.characters) {
      repos.character.insert({
        id: character.id,
        projectId: project.id,
        name: character.name,
        cardJson: JSON.stringify(character.card)
      })
    }

    const root = repos.outline.insert({
      id: 'out_main',
      projectId: project.id,
      parentId: null,
      kind: 'main',
      ord: 0,
      title: '主线：黑漆匣子'
    })

    const chapters: SeededChapter[] = []
    let sceneOrd = 0
    for (const chapter of data.chapters) {
      const node = repos.outline.insert({
        id: `out_${chapter.id}`,
        projectId: project.id,
        parentId: root.id,
        kind: 'chapter',
        ord: chapter.ord,
        title: chapter.title
      })
      const chapterRecord = repos.chapter.insert({
        id: chapter.id,
        projectId: project.id,
        outlineNodeId: node.id,
        ord: chapter.ord,
        status: 'drafting'
      })

      const manifest: ManifestBeatRow[] = []
      const seqById = new Map<string, number>()
      let seqStart = 0
      let seqEnd = 0
      for (const scene of chapter.scenes) {
        sceneOrd += 1
        repos.scene.insert({
          id: scene.id,
          projectId: project.id,
          ord: sceneOrd,
          location: scene.location,
          participantsJson: JSON.stringify(scene.participants),
          goal: scene.goal,
          entry: scene.entry,
          exitJson: JSON.stringify(scene.exit),
          status: 'open'
        })
        repos.scene.linkToChapter(chapter.id, scene.id, scene.ord)

        scene.beats.forEach((beat, index) => {
          const beatId = `bt_${chapter.ord}_${scene.ord}_${index + 1}`
          const seq = allocateSeq(db, project.id)
          if (seqStart === 0) seqStart = seq
          seqEnd = seq
          seqById.set(beatId, seq)
          manifest.push({
            beatId,
            sceneId: scene.id,
            sceneOrd: scene.ord,
            beatOrd: index + 1,
            speakerType: beat.speakerType,
            speakerId: beat.speakerId,
            body: beat.body
          })
        })
      }

      const revisionId = `rev_seed_${chapter.ord}`
      // revision 先插入（content_hash 已算好），beat 才能在 created_revision_id 上引用它。
      repos.revision.insert({
        id: revisionId,
        chapterId: chapter.id,
        parentRevisionId: null,
        kind: 'draft',
        contentHash: hashManifestRows(manifest),
        createdBy: 'author'
      })

      for (const member of manifest) {
        repos.beat.insert({
          id: member.beatId,
          chapterId: chapter.id,
          sceneId: member.sceneId,
          ord: member.beatOrd,
          seq: seqById.get(member.beatId)!,
          speakerType: member.speakerType,
          speakerId: member.speakerId,
          body: member.body,
          status: 'draft',
          createdRevisionId: revisionId,
          wordCount: [...member.body].length
        })
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
      repos.chapter.setCurrentRevision(chapterRecord.id, revisionId)

      const content = renderChapterMarkdown(db, { chapterId: chapter.id, revisionId })
      repos.outbox.enqueue({
        projectId: project.id,
        chapterId: chapter.id,
        revisionId,
        path: chapterMirrorRelPath(chapter.ord),
        expectedHash: hashText(content)
      })

      chapters.push({
        id: chapter.id,
        revisionId,
        sceneIds: chapter.scenes.map((scene) => scene.id),
        seqStart,
        seqEnd
      })
    }

    return {
      projectId: project.id,
      chapterIds: data.chapters.map((chapter) => chapter.id),
      chapters,
      characterIds: data.characters.map((character) => character.id)
    }
  })

  new OutboxPublisher({
    db,
    projectDir,
    render: (row) =>
      renderChapterMarkdown(db, { chapterId: row.chapterId!, revisionId: row.revisionId! })
  }).publishPending()

  return seeded
}
