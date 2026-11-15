import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { PatchRecord } from '../db/repos/patch'
import { withTransaction } from '../db/tx'
import { applyPatchBatch, type ApplyPatchBatchResult } from '../doc/patch-apply'
import { chapterTransition } from '../scheduler/transitions'

/**
 * patch 的逐条决定与落盘（PHASE-08 G2 / DEV-PLAN §9.3）。
 *
 * 语义：
 *   - 只改草稿区已有拍；不接受新增拍/场景（T36 在提案阶段就拒绝）。
 *   - `before` 必须与当前正文一致；任一接受项冲突 → 整个批次失败（patch_conflict），
 *     原文不变，作者以当前 revision 为 base 重新提案。
 *   - 一次修订只产生**一个** revision；被接受的 patch 记为 applied，拒绝的保留记录。
 *   - 未决定的旧提案在新 revision 之后标记 superseded（base 已变，不能再套用）。
 */

export interface PatchDecision {
  patchId: string
  accept: boolean
}

export interface DecidePatchesInput {
  chapterId: string
  expectedRevision: string | null
  decisions: readonly PatchDecision[]
}

export interface DecidePatchesResult {
  revisionId: string | null
  applied: string[]
  rejected: string[]
  superseded: string[]
  contentHash: string | null
  mirrorHash: string | null
}

function assertDecisions(repos: Repos, patches: readonly PatchRecord[], decisions: readonly PatchDecision[]): void {
  const byId = new Map(patches.map((patch) => [patch.id, patch]))
  const seen = new Set<string>()
  for (const decision of decisions) {
    if (seen.has(decision.patchId)) {
      throw new AppError('invalid_args', `重复的 patch 决定：${decision.patchId}`)
    }
    seen.add(decision.patchId)
    const patch = byId.get(decision.patchId)
    if (!patch) {
      throw new AppError('stale_revision', `patch ${decision.patchId} 不属于当前 revision`, {
        patchId: decision.patchId
      })
    }
    if (patch.status !== 'proposed') {
      throw new AppError('invalid_args', `patch ${decision.patchId} 已处理（${patch.status}）`, {
        patchId: decision.patchId,
        status: patch.status
      })
    }
  }
}

export function decidePatches(db: Db, repos: Repos, input: DecidePatchesInput): DecidePatchesResult {
  return withTransaction(db, () => {
    const chapter = repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
    if (chapter.status === 'finalized') {
      throw new AppError('already_finalized', '本章已定稿，patch 不能再执行', { chapterId: chapter.id })
    }
    if (chapter.currentRevisionId !== input.expectedRevision) {
      throw new AppError('stale_revision', '稿件已变更，请重新读取', {
        reason: 'revision',
        expected: input.expectedRevision,
        actual: chapter.currentRevisionId
      })
    }
    const revisionId = chapter.currentRevisionId
    if (revisionId === null) throw new AppError('invalid_args', '本章还没有草稿 revision')

    const patches = repos.patch.listByRevision(revisionId)
    assertDecisions(repos, patches, input.decisions)

    const accepted = patches.filter((patch) =>
      input.decisions.some((decision) => decision.patchId === patch.id && decision.accept)
    )
    const rejected = patches.filter((patch) =>
      input.decisions.some((decision) => decision.patchId === patch.id && !decision.accept)
    )
    for (const patch of rejected) repos.patch.setDecision(patch.id, 'rejected')

    let appliedResult: ApplyPatchBatchResult | null = null
    if (accepted.length > 0) {
      const project = repos.project.get()
      if (!project) throw new AppError('project_not_found', 'no project in database')
      appliedResult = applyPatchBatch(db, repos, {
        chapterId: chapter.id,
        expectedRevision: revisionId,
        epoch: project.writeEpoch,
        edits: accepted.map((patch) => ({
          patchId: patch.id,
          beatId: patch.beatId,
          before: patch.before,
          after: patch.after,
          issueRef: patch.issueRef
        })),
        createdBy: 'reviewer',
        note: `patch x${accepted.length}`
      })
      for (const item of appliedResult.applied) {
        repos.patch.markApplied(item.patchId, appliedResult.revisionId)
      }
    }

    // 本轮未决定、且仍挂在旧 base 上的提案：base 已变，标记 superseded。
    const superseded: string[] = []
    if (appliedResult !== null) {
      for (const patch of patches) {
        const decided = input.decisions.some((decision) => decision.patchId === patch.id)
        if (decided) continue
        if (patch.status !== 'proposed') continue
        repos.patch.setDecision(patch.id, 'superseded')
        superseded.push(patch.id)
      }
      if (chapter.status === 'under_review') {
        repos.chapter.setStatus(chapter.id, chapterTransition('under_review', 'REVISE'))
      }
    }

    return {
      revisionId: appliedResult?.revisionId ?? null,
      applied: appliedResult?.applied.map((item) => item.patchId) ?? [],
      rejected: rejected.map((patch) => patch.id),
      superseded,
      contentHash: appliedResult?.contentHash ?? null,
      mirrorHash: appliedResult?.mirrorHash ?? null
    }
  })
}

/** 本章所有 patch（按 revision 时间顺序），UI 用最近 40 条。 */
export function chapterPatches(repos: Repos, chapterId: string): PatchRecord[] {
  const revisions = repos.revision.listByChapter(chapterId)
  const rows = revisions.flatMap((revision) => repos.patch.listByRevision(revision.id))
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-40)
}

/** 当前 revision 上待决定的 patch。 */
export function pendingPatches(repos: Repos, chapterId: string): PatchRecord[] {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter || chapter.currentRevisionId === null) return []
  return repos.patch
    .listByRevision(chapter.currentRevisionId)
    .filter((patch) => patch.status === 'proposed')
}
