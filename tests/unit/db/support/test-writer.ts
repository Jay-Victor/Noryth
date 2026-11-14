import { AppError } from '../../../../src/shared/domain/app-error'
import type { Db } from '../../../../src/main/db/project-db'
import type { Repos } from '../../../../src/main/db/repos'
import { newId } from '../../../../src/main/db/repos/common'
import type { BeatStatus } from '../../../../src/main/db/repos/beat'
import { allocateSeq, recomputeCoveredUntilSeq } from '../../../../src/main/db/seq'
import { withTransaction } from '../../../../src/main/db/tx'
import { hashManifestRows, hashText } from '../../../../src/main/db/hash'
import { loadLiveManifest, mergeBeatIntoManifest } from '../../../../src/main/db/revision'
import { chapterMirrorRelPath, renderChapterMarkdown } from '../../../../src/main/doc/mirror'

export interface TestCommitInput {
  chapterId: string
  sceneId: string
  ord: number
  speakerType: 'character' | 'narrator'
  speakerId: string
  body: string
  supersedesId?: string | null
  status?: BeatStatus
  expectedRevision?: string | null
}

export interface TestCommitResult {
  beatId: string
  revisionId: string
  seq: number
  contentHash: string
  mirrorHash: string
}

/**
 * TEST-ONLY（PHASE-02 §5.5）：模拟阶段 07 的 DocController.commitBeat。
 * 这是本阶段唯一允许写 beat.body 的代码路径；阶段 07 会用真实 DocController 替换。
 *
 * 事务顺序与 DEV-PLAN §9.1 一致：
 * seq → 清单 + hash → revision → 旧拍 superseded → 新 beat → revision_beat
 * → chapter.current_revision → covered_until_seq → outbox。
 */
export function testCommitBeat(db: Db, repos: Repos, input: TestCommitInput): TestCommitResult {
  return withTransaction(db, () => {
    const chapter = repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
    if (input.expectedRevision !== undefined && chapter.currentRevisionId !== input.expectedRevision) {
      throw new AppError('stale_revision', 'chapter revision changed')
    }

    const slot = repos.scene.listByChapter(chapter.id).find((item) => item.scene.id === input.sceneId)
    if (!slot) throw new AppError('invalid_args', `scene ${input.sceneId} is not linked to chapter`)

    if (input.supersedesId) {
      const old = repos.beat.get(input.supersedesId)
      if (!old) throw new AppError('invalid_args', `beat ${input.supersedesId} not found`)
    }

    const base = loadLiveManifest(db, chapter.id)
    const beatId = newId('bt')
    const revisionId = newId('rev')
    const manifest = mergeBeatIntoManifest(
      base,
      {
        beatId,
        sceneId: input.sceneId,
        sceneOrd: slot.chapterOrd,
        beatOrd: input.ord,
        speakerType: input.speakerType,
        speakerId: input.speakerId,
        body: input.body
      },
      input.supersedesId ?? null
    )
    const contentHash = hashManifestRows(manifest)

    repos.revision.insert({
      id: revisionId,
      chapterId: chapter.id,
      parentRevisionId: chapter.currentRevisionId,
      kind: 'draft',
      contentHash,
      createdBy: 'doc_controller'
    })

    // 先 supersede 旧拍，释放 (scene_id, ord) 的部分唯一索引槽位。
    if (input.supersedesId) repos.beat.markSuperseded(input.supersedesId)

    const seq = allocateSeq(db, chapter.projectId)
    repos.beat.insert({
      id: beatId,
      chapterId: chapter.id,
      sceneId: input.sceneId,
      ord: input.ord,
      seq,
      speakerType: input.speakerType,
      speakerId: input.speakerId,
      body: input.body,
      status: input.status ?? 'draft',
      supersedesId: input.supersedesId ?? null,
      createdRevisionId: revisionId,
      wordCount: [...input.body].length
    })

    repos.revision.insertMembers(
      revisionId,
      manifest.map((member) => ({
        revisionId,
        beatId: member.beatId,
        sceneOrd: member.sceneOrd,
        beatOrd: member.beatOrd
      }))
    )
    repos.chapter.setCurrentRevision(chapter.id, revisionId)
    recomputeCoveredUntilSeq(db, chapter.id)

    const content = renderChapterMarkdown(db, { chapterId: chapter.id, revisionId })
    const mirrorHash = hashText(content)
    repos.outbox.enqueue({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      revisionId,
      path: chapterMirrorRelPath(chapter.ord),
      expectedHash: mirrorHash
    })

    return { beatId, revisionId, seq, contentHash, mirrorHash }
  })
}
