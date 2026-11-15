import { AppError } from '../../shared/domain/app-error'
import { sameText } from '../../shared/text/normalize'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord, SpeakerType } from '../db/repos/beat'
import type { RevisionCreatedBy } from '../db/repos/revision'
import { newId } from '../db/repos/common'
import { allocateSeq, recomputeCoveredUntilSeq } from '../db/seq'
import { withTransaction } from '../db/tx'
import { hashManifestRows, hashText } from '../db/hash'
import { loadLiveManifest, mergeBeatIntoManifest, type ManifestBeatRow } from '../db/revision'
import { chapterMirrorRelPath, renderChapterMarkdown } from './mirror'

/**
 * DocController 的批量 patch 落盘（PHASE-08 G2 / DEV-PLAN §9.3）。
 *
 * 与 `commitBeat` 同族、但语义不同：一次事务里替换 N 拍、只产生 **一个** revision
 * （审批的「一次修订」是一份清单，不是 N 次提交）。正文仍然只经本文件写入，
 * `beat` 行通过 `repos.beat.insert` 追加、旧行 superseded，没有 UPDATE body。
 *
 * 前置条件由调用方（review/patch.ts）准备：patch 必须属于当前 revision、
 * `before` 必须与当前正文一致。这里再校验一次，因为「单一写入者」不能依赖调用方自觉。
 */

export interface PatchEdit {
  patchId: string
  beatId: string
  before: string
  after: string
  issueRef: string
}

export interface ApplyPatchBatchInput {
  chapterId: string
  expectedRevision: string | null
  epoch: number
  edits: readonly PatchEdit[]
  createdBy?: RevisionCreatedBy
  note?: string | null
  now?: string
}

export interface ApplyPatchBatchResult {
  revisionId: string
  parentRevisionId: string | null
  /** patchId → 新拍 id（同一顺序）。 */
  applied: Array<{ patchId: string; oldBeatId: string; newBeatId: string; seq: number }>
  contentHash: string
  mirrorHash: string
}

function assertLivePatchedBeat(
  repos: Repos,
  chapterId: string,
  edit: PatchEdit,
  live: ReadonlyMap<string, ManifestBeatRow>
): BeatRecord {
  const beat = repos.beat.get(edit.beatId)
  if (!beat) throw new AppError('invalid_args', `beat ${edit.beatId} not found`, { patchId: edit.patchId })
  if (beat.chapterId !== chapterId) {
    throw new AppError('invalid_args', 'patch 指向其他章节的拍', { patchId: edit.patchId })
  }
  if (!live.has(beat.id)) {
    throw new AppError('stale_revision', 'patch 的拍不在当前清单', {
      patchId: edit.patchId,
      beatId: beat.id
    })
  }
  if (!sameText(beat.body, edit.before)) {
    // PRD §5.3 / PHASE-08 §5.2：原文已变，不套用。
    throw new AppError('patch_conflict', `原文已变，patch ${edit.patchId} 未套用`, {
      patchId: edit.patchId,
      beatId: beat.id
    })
  }
  if (edit.after.trim().length === 0) {
    throw new AppError('invalid_args', 'patch 的 after 为空', { patchId: edit.patchId })
  }
  return beat
}

export function applyPatchBatch(db: Db, repos: Repos, input: ApplyPatchBatchInput): ApplyPatchBatchResult {
  return withTransaction(db, () => {
    if (input.edits.length === 0) throw new AppError('invalid_args', '没有可应用的 patch')
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
    if (chapter.status === 'finalized') {
      throw new AppError('already_finalized', '本章已定稿，patch 不能再套用', { chapterId: chapter.id })
    }
    if (chapter.currentRevisionId !== input.expectedRevision) {
      throw new AppError('stale_revision', 'patch base revision changed', {
        reason: 'revision',
        expected: input.expectedRevision,
        actual: chapter.currentRevisionId
      })
    }

    const seen = new Set<string>()
    for (const edit of input.edits) {
      if (seen.has(edit.beatId)) {
        throw new AppError('invalid_args', `同一拍出现多条 patch：${edit.beatId}`, { patchId: edit.patchId })
      }
      seen.add(edit.beatId)
    }

    const manifestBase = loadLiveManifest(db, chapter.id)
    const live = new Map(manifestBase.map((row) => [row.beatId, row]))
    const beats = input.edits.map((edit) => ({ edit, beat: assertLivePatchedBeat(repos, chapter.id, edit, live) }))

    const revisionId = newId('rev')
    const at = input.now ?? new Date().toISOString()
    let manifest = manifestBase

    // 先把「替换后的清单」算完，再一次性写 revision 与 beat：hash 必须在插入前算好。
    const planned = beats.map(({ edit, beat }) => {
      const row: ManifestBeatRow & { beatId: string } = {
        beatId: newId('bt'),
        sceneId: beat.sceneId,
        sceneOrd: live.get(beat.id)!.sceneOrd,
        beatOrd: beat.ord,
        speakerType: beat.speakerType,
        speakerId: beat.speakerId,
        body: edit.after
      }
      manifest = mergeBeatIntoManifest(manifest, row, beat.id)
      return { edit, beat, row }
    })
    const contentHash = hashManifestRows(manifest)

    repos.revision.insert({
      id: revisionId,
      chapterId: chapter.id,
      parentRevisionId: chapter.currentRevisionId,
      kind: 'draft',
      contentHash,
      createdBy: input.createdBy ?? 'reviewer',
      note: input.note ?? null
    })

    const applied: ApplyPatchBatchResult['applied'] = []
    for (const { edit, beat, row } of planned) {
      const seq = allocateSeq(db, chapter.projectId, () => at)
      repos.beat.markSuperseded(beat.id)
      const inserted = repos.beat.insert({
        id: row.beatId,
        chapterId: chapter.id,
        sceneId: beat.sceneId,
        ord: beat.ord,
        seq,
        speakerType: beat.speakerType as SpeakerType,
        speakerId: beat.speakerId,
        intent: beat.intent,
        body: edit.after,
        groundingJson: beat.groundingJson,
        traceRef: beat.traceRef,
        // 作者接受了 patch：正文变化已在报告里被复核，状态仍然是 confirmed。
        status: 'confirmed',
        supersedesId: beat.id,
        createdRevisionId: revisionId,
        maxWords: beat.maxWords,
        wordCount: [...edit.after].length,
        authorEdited: 0,
        decidedBy: 'author',
        createdAt: at,
        updatedAt: at
      })
      applied.push({ patchId: edit.patchId, oldBeatId: beat.id, newBeatId: inserted.id, seq })
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
      revisionId,
      parentRevisionId: chapter.currentRevisionId,
      applied,
      contentHash,
      mirrorHash
    }
  })
}
