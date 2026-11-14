import { AppError } from '../../shared/domain/app-error'
import type { GroundingItem } from '../../shared/schema/envelope'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatStatus, SpeakerType } from '../db/repos/beat'
import type { RevisionCreatedBy } from '../db/repos/revision'
import { newId } from '../db/repos/common'
import { allocateSeq, recomputeCoveredUntilSeq } from '../db/seq'
import { withTransaction } from '../db/tx'
import { hashManifestRows, hashText } from '../db/hash'
import { loadLiveManifest, mergeBeatIntoManifest } from '../db/revision'
import { chapterMirrorRelPath, renderChapterMarkdown } from './mirror'

/**
 * DocController.commitBeat（PRD §4.7 / DEV-PLAN §9.1 / PHASE-05 §5.2）。
 *
 * 唯一允许写 `beat.body` 的入口；阶段 07 只加状态机，不改签名。
 *
 * 事务内顺序：
 *   epoch / expected_revision 校验 → seq → 新 beat → 旧拍 superseded
 *   → revision（hash 先算好）→ revision_beat 清单 → chapter.current_revision
 *   → covered_until_seq → outbox（Markdown 镜像）。
 *
 * 不在这里做的事：patch 应用、定稿、记忆抽取、状态机推进。
 * 失败要么抛错（事务回滚），要么不写任何正文——没有半条 revision。
 */

export interface CommitBeatInput {
  chapterId: string
  /** 客户端发起写入时看到的 revision；与 chapter.current_revision_id 不一致即拒绝。 */
  expectedRevision: string | null
  /** 任务开始时的 project.write_epoch；不匹配即拒绝（DEV-PLAN §9.2）。 */
  epoch: number
  sceneId: string
  ord: number
  speakerType: SpeakerType
  speakerId: string
  body: string
  intent?: string
  grounding?: readonly GroundingItem[]
  traceRef?: string | null
  /** 被替换的旧版本；一条旧拍只能被替换一次。 */
  supersedesId?: string | null
  /** 默认 draft；作者编辑写 author_edited，自动模式可直接 draft。 */
  status?: BeatStatus
  maxWords?: number | null
  authorEdited?: boolean
  createdBy?: RevisionCreatedBy
  now?: string
}

export interface CommitBeatResult {
  beatId: string
  revisionId: string
  parentRevisionId: string | null
  seq: number
  contentHash: string
  mirrorHash: string
  wordCount: number
}

function resolveSpeaker(repos: Repos, speakerType: SpeakerType, speakerId: string): void {
  if (speakerId.trim().length === 0) {
    throw new AppError('invalid_args', 'speaker_id 不能为空')
  }
  if (speakerType === 'character' && !repos.character.get(speakerId)) {
    throw new AppError('invalid_args', `speaker character ${speakerId} not found`, { speakerId })
  }
}

export function commitBeat(db: Db, repos: Repos, input: CommitBeatInput): CommitBeatResult {
  return withTransaction(db, () => {
    const project = repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    if (project.writeEpoch !== input.epoch) {
      throw new AppError('stale_revision', 'write epoch changed', {
        reason: 'epoch',
        expected: input.epoch,
        actual: project.writeEpoch
      })
    }

    const chapter = repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
    if (chapter.currentRevisionId !== input.expectedRevision) {
      throw new AppError('stale_revision', 'chapter revision changed', {
        reason: 'revision',
        expected: input.expectedRevision,
        actual: chapter.currentRevisionId
      })
    }

    const slot = repos.scene.listByChapter(chapter.id).find((item) => item.scene.id === input.sceneId)
    if (!slot) {
      throw new AppError('invalid_args', `scene ${input.sceneId} is not linked to chapter`, {
        chapterId: chapter.id
      })
    }

    const body = input.body
    if (body.trim().length === 0) {
      throw new AppError('schema_invalid', 'body 为空，拒绝落盘', { chapterId: chapter.id })
    }
    resolveSpeaker(repos, input.speakerType, input.speakerId)

    const status = input.status ?? 'draft'
    if (
      status === 'proposed' ||
      status === 'generating' ||
      status === 'regenerating' ||
      status === 'superseded'
    ) {
      throw new AppError('invalid_args', `commitBeat 不能写入 ${status} 状态`, { status })
    }

    const supersedesId = input.supersedesId ?? null
    let previous: ReturnType<Repos['beat']['get']> = null
    if (supersedesId !== null) {
      previous = repos.beat.get(supersedesId)
      if (!previous) throw new AppError('invalid_args', `beat ${supersedesId} not found`)
      if (previous.chapterId !== chapter.id) {
        throw new AppError('invalid_args', 'supersedes 指向其他章节的拍', { supersedesId })
      }
      if (previous.sceneId !== input.sceneId || previous.ord !== input.ord) {
        throw new AppError('invalid_args', 'supersedes 必须替换同一槽位', {
          supersedesId,
          expected: { sceneId: input.sceneId, ord: input.ord },
          actual: { sceneId: previous.sceneId, ord: previous.ord }
        })
      }
      if (previous.status === 'superseded') {
        throw new AppError('invalid_args', `beat ${supersedesId} 已被替换过`, { supersedesId })
      }
    }

    const beatId = newId('bt')
    const revisionId = newId('rev')
    const at = input.now ?? new Date().toISOString()
    const beatRow = {
      beatId,
      sceneId: input.sceneId,
      sceneOrd: slot.chapterOrd,
      beatOrd: input.ord,
      speakerType: input.speakerType,
      speakerId: input.speakerId,
      body
    }
    const manifest = mergeBeatIntoManifest(loadLiveManifest(db, chapter.id), beatRow, supersedesId)
    const contentHash = hashManifestRows(manifest)

    // revision 只 INSERT：hash 在插入前算好（DEV-PLAN §9.1）。
    repos.revision.insert({
      id: revisionId,
      chapterId: chapter.id,
      parentRevisionId: chapter.currentRevisionId,
      kind: 'draft',
      contentHash,
      createdBy: input.createdBy ?? 'doc_controller'
    })

    // 先释放 (scene_id, ord) 的部分唯一索引槽位，再插新拍。
    if (supersedesId !== null) repos.beat.markSuperseded(supersedesId)

    const seq = allocateSeq(db, chapter.projectId, () => at)
    const wordCount = [...body].length
    const inserted = repos.beat.insert({
      id: beatId,
      chapterId: chapter.id,
      sceneId: input.sceneId,
      ord: input.ord,
      seq,
      speakerType: input.speakerType,
      speakerId: input.speakerId,
      intent: input.intent ?? previous?.intent ?? '',
      body,
      groundingJson: JSON.stringify(input.grounding ?? []),
      traceRef: input.traceRef ?? null,
      status,
      supersedesId,
      createdRevisionId: revisionId,
      maxWords: input.maxWords ?? previous?.maxWords ?? null,
      wordCount,
      authorEdited: input.authorEdited === true ? 1 : 0,
      decidedBy: null,
      createdAt: at,
      updatedAt: at
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
    repoRequireBeat(repos, inserted.id)
    repos.chapter.setCurrentRevision(chapter.id, revisionId)
    recomputeCoveredUntilSeq(db, chapter.id)

    const mirrorHash = hashText(renderChapterMarkdown(db, { chapterId: chapter.id, revisionId }))
    repos.outbox.enqueue({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      revisionId,
      path: chapterMirrorRelPath(chapter.ord),
      expectedHash: mirrorHash
    })

    return {
      beatId,
      revisionId,
      parentRevisionId: chapter.currentRevisionId,
      seq,
      contentHash,
      mirrorHash,
      wordCount
    }
  })
}

/** 写入后自检：插入的 beat 必须读得回来；失败让事务整体回滚。 */
function repoRequireBeat(repos: Repos, beatId: string): void {
  if (!repos.beat.get(beatId)) {
    throw new AppError('internal_error', `beat ${beatId} not readable after insert`)
  }
}
