import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { withTransaction } from '../db/tx'
import { hashManifestRows, hashText } from '../db/hash'
import type { ManifestBeatRow } from '../db/revision'
import { chapterMirrorRelPath, renderChapterMarkdown } from '../doc/mirror'
import type { SliceFixture } from './fixture'

/**
 * 切片 fixture 落库（PHASE-05 V1）：
 *   1 项目（已由项目向导创建）+ 5 角色 + 1 章 + 1 场景 + 2 拍。
 *
 * 两拍先以 `proposed`、`seq = NULL` 的占位形态存在：它们还不是叙事事件，
 * 生成时由 commitBeat 替换为带 seq 的正文版本。基线 revision 仍包含两行
 * 清单（空 body），保证 `verify` 的「清单完整」不误报。
 *
 * 幂等：章已存在时直接返回 seeded=false，不重复插角色/记忆/事实。
 */

export interface SliceSeedIds {
  projectId: string
  chapterId: string
  sceneId: string
  beatIds: string[]
  characterIds: string[]
  seeded: boolean
}

export function seedSlice(db: Db, repos: Repos, fixture: SliceFixture): SliceSeedIds {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')

  const existingChapter = repos.chapter.get(fixture.chapter.id)
  if (existingChapter) {
    return {
      projectId: project.id,
      chapterId: existingChapter.id,
      sceneId: fixture.scene.id,
      beatIds: fixture.beats.map((beat) => beat.id),
      characterIds: fixture.characters.map((character) => character.id),
      seeded: false
    }
  }

  return withTransaction(db, () => {
    for (const character of fixture.characters) {
      if (repos.character.get(character.id)) continue
      repos.character.insert({
        id: character.id,
        projectId: project.id,
        name: character.name,
        cardJson: JSON.stringify(character.card)
      })
    }

    const root = repos.outline.insert({
      id: 'out_slice_main',
      projectId: project.id,
      parentId: null,
      kind: 'main',
      ord: 0,
      title: `切片主线：${project.title}`,
      content: fixture.chapter.goal,
      status: 'approved'
    })
    const node = repos.outline.insert({
      id: 'out_slice_ch_01',
      projectId: project.id,
      parentId: root.id,
      kind: 'chapter',
      ord: fixture.chapter.ord,
      title: fixture.chapter.title,
      content: fixture.chapter.goal,
      status: 'approved'
    })

    repos.chapter.insert({
      id: fixture.chapter.id,
      projectId: project.id,
      outlineNodeId: node.id,
      ord: fixture.chapter.ord,
      status: 'drafting',
      coveredUntilSeq: 0,
      currentRevisionId: null
    })

    repos.scene.insert({
      id: fixture.scene.id,
      projectId: project.id,
      ord: fixture.scene.ord,
      location: fixture.scene.location,
      participantsJson: JSON.stringify(fixture.scene.participants),
      goal: fixture.scene.goal,
      entry: fixture.scene.entry,
      exitJson: JSON.stringify(fixture.scene.exit),
      status: 'open'
    })
    repos.scene.linkToChapter(fixture.chapter.id, fixture.scene.id, fixture.scene.ord)

    const manifest: ManifestBeatRow[] = fixture.beats.map((beat) => ({
      beatId: beat.id,
      sceneId: fixture.scene.id,
      sceneOrd: fixture.scene.ord,
      beatOrd: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: ''
    }))
    const revisionId = `rev_slice_base`
    repos.revision.insert({
      id: revisionId,
      chapterId: fixture.chapter.id,
      parentRevisionId: null,
      kind: 'draft',
      contentHash: hashManifestRows(manifest),
      createdBy: 'author',
      note: 'slice baseline (proposed beats)'
    })

    for (const beat of fixture.beats) {
      repos.beat.insert({
        id: beat.id,
        chapterId: fixture.chapter.id,
        sceneId: fixture.scene.id,
        ord: beat.ord,
        seq: null,
        speakerType: beat.speakerType,
        speakerId: beat.speakerId,
        intent: beat.intent,
        body: '',
        status: 'proposed',
        createdRevisionId: revisionId,
        maxWords: beat.maxWords
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
    repos.chapter.setCurrentRevision(fixture.chapter.id, revisionId)

    for (const memory of fixture.memories) {
      repos.memory.insert({
        id: memory.id,
        projectId: project.id,
        characterId: memory.characterId,
        kind: memory.kind,
        text: memory.text,
        learnedSeq: memory.learnedSeq,
        sourceChapterId: fixture.chapter.id,
        sourceRevisionId: revisionId,
        importance: memory.importance,
        pinned: memory.pinned,
        embeddingModel: project.embeddingModel
      })
    }

    for (const fact of fixture.facts) {
      repos.world.insert({
        id: fact.id,
        projectId: project.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        truth: 'objective',
        visibility: fact.visibility,
        revealSeq: fact.revealSeq,
        validFromSeq: fact.validFromSeq,
        sourceType: 'author'
      })
    }

    const mirrorHash = hashText(
      renderChapterMarkdown(db, { chapterId: fixture.chapter.id, revisionId })
    )
    repos.outbox.enqueue({
      projectId: project.id,
      chapterId: fixture.chapter.id,
      revisionId,
      path: chapterMirrorRelPath(fixture.chapter.ord),
      expectedHash: mirrorHash
    })

    return {
      projectId: project.id,
      chapterId: fixture.chapter.id,
      sceneId: fixture.scene.id,
      beatIds: fixture.beats.map((beat) => beat.id),
      characterIds: fixture.characters.map((character) => character.id),
      seeded: true
    }
  })
}
