import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { newId } from '../db/repos/common'
import { withTransaction } from '../db/tx'
import { chapterTransition } from '../scheduler/transitions'

/**
 * 重新打开定稿（PHASE-16 §5.1 / DEV-PLAN §9.6 / M1-21）。
 *
 * `finalized → revising`：新建 draft revision（parent = 旧 final，复制清单），
 * 旧 final 永久保留（可对比 / 可回退），`final_revision_id` 仍指向旧 final，
 * 直到下次定稿把新 final 写进去。
 *
 * 不变量：
 *   - 只 INSERT revision + revision_beat；正文行不动（旧 final 的清单指向同一批 beat）；
 *   - `write_epoch + 1`：所有旧窗口的在跑任务被 epoch 校验挡掉；
 *   - 不在这里入队记忆任务：首次定稿 = memory.extract，重开再定稿 = memory.rebuild
 *     由 `finalizeChapter` 依据「是否已有 final」决定。
 *   - 只有作者能触发（IPC 层只暴露 review.reopen；没有 Agent 工具）。
 */

export interface ReopenChapterInput {
  chapterId: string
  actor: string
  reason?: string | null
  now?: string
}

export interface ReopenChapterResult {
  chapterId: string
  previousFinalRevisionId: string
  draftRevisionId: string
  contentHash: string
  epoch: number
  status: 'revising'
}

export function reopenChapter(db: Db, repos: Repos, input: ReopenChapterInput): ReopenChapterResult {
  return withTransaction(db, () => {
    const project = repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const chapter = repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId: input.chapterId })
    if (chapter.status !== 'finalized' || chapter.finalRevisionId === null) {
      throw new AppError('invalid_args', '只有已定稿章节才能重新打开', {
        chapterId: chapter.id,
        status: chapter.status
      })
    }

    const final = repos.revision.get(chapter.finalRevisionId)
    if (!final || final.kind !== 'final' || final.chapterId !== chapter.id) {
      throw new AppError('stale_revision', '定稿 revision 缺失或类型不对', {
        chapterId: chapter.id,
        finalRevisionId: chapter.finalRevisionId
      })
    }
    const members = repos.revision.manifest(final.id)
    if (members.length === 0) {
      throw new AppError('invalid_args', '定稿清单为空，不能重新打开', { chapterId: chapter.id })
    }

    const draftRevisionId = newId('rev')
    const at = input.now ?? new Date().toISOString()
    repos.revision.insert({
      id: draftRevisionId,
      chapterId: chapter.id,
      parentRevisionId: final.id,
      kind: 'draft',
      contentHash: final.contentHash,
      createdBy: 'author',
      note: input.reason?.trim() ? `reopen: ${input.reason.trim().slice(0, 200)}` : 'reopen',
      createdAt: at,
      // 重开 = 回到主线；分支末梢保持原样，作者可在版本 tab 里再切。
      branchId: null
    })
    repos.revision.insertMembers(
      draftRevisionId,
      members.map((member) => ({
        revisionId: draftRevisionId,
        beatId: member.beatId,
        sceneOrd: member.sceneOrd,
        beatOrd: member.beatOrd
      }))
    )

    const nextStatus = chapterTransition('finalized', 'REOPEN')
    repos.chapter.setStatus(chapter.id, nextStatus)
    repos.chapter.setCurrentRevision(chapter.id, draftRevisionId)
    const epoch = repos.project.incrementWriteEpoch(project.id)

    return {
      chapterId: chapter.id,
      previousFinalRevisionId: final.id,
      draftRevisionId,
      contentHash: final.contentHash,
      epoch,
      status: 'revising'
    }
  })
}
