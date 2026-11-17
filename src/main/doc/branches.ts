import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { ChapterRecord } from '../db/repos/chapter'
import type { BranchRecord } from '../db/repos/branch'
import type { RevisionRecord } from '../db/repos/revision'
import { newId } from '../db/repos/common'
import { hashManifestRows } from '../db/hash'
import { withTransaction } from '../db/tx'

/**
 * 分支（PHASE-16 §5.2 / M1-21）。
 *
 * M1 的语义：
 *   - 分支只承载 **draft** revision；final 永远在主线上（`branch_id = NULL`）；
 *   - 「开新分支」= 从当前 revision 复制清单 → 新 draft + 新 branch；
 *   - 「切换」只改 `chapter.current_revision_id` 到该分支 head，不删任何版本；
 *   - 切到 final 不是分支切换：走「重新打开定稿」。
 *   - 不做合并：需要合并时作者手动重跑，避免自动合并制造不可审计正文。
 */

export const BRANCH_NAME_MAX = 40

export interface BranchView {
  id: string
  name: string
  baseRevisionId: string
  headRevisionId: string
  status: BranchRecord['status']
  createdAt: string
  isCurrent: boolean
}

export interface BranchOverview {
  /** 主线末梢：最近一个 branch_id IS NULL 的 draft。 */
  mainlineHeadId: string | null
  /** 当前 revision 是否在主线（branch_id = NULL）。 */
  mainlineCurrent: boolean
  /** 当前 revision 所属分支；null = 主线。 */
  currentBranchId: string | null
  branches: BranchView[]
}

export interface CreateBranchInput {
  chapterId: string
  name: string
  /** 默认从当前 revision 复制；必须是 draft。 */
  fromRevisionId?: string
  actor: string
  now?: string
}

export interface CreateBranchResult {
  branch: BranchView
  revisionId: string
  contentHash: string
}

export interface SwitchBranchInput {
  chapterId: string
  /** null = 切回主线。 */
  branchId: string | null
  actor: string
  now?: string
}

export interface SwitchBranchResult {
  revisionId: string
  branchId: string | null
}

function requireChapter(repos: Repos, chapterId: string): ChapterRecord {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId })
  return chapter
}

function requireDraftOfChapter(repos: Repos, chapterId: string, revisionId: string): RevisionRecord {
  const revision = repos.revision.get(revisionId)
  if (!revision || revision.chapterId !== chapterId) {
    throw new AppError('invalid_args', 'revision 不属于本章', { chapterId, revisionId })
  }
  if (revision.kind !== 'draft') {
    throw new AppError('invalid_args', '分支只能承载 draft revision；切到定稿请用「重新打开」', {
      chapterId,
      revisionId
    })
  }
  return revision
}

export function listBranches(repos: Repos, chapter: ChapterRecord): BranchOverview {
  const currentRevision = chapter.currentRevisionId ? repos.revision.get(chapter.currentRevisionId) : null
  const currentBranchId = currentRevision?.branchId ?? null
  const mainline = repos.revision.latestMainlineDraft(chapter.id)
  return {
    mainlineHeadId: mainline?.id ?? null,
    mainlineCurrent: currentBranchId === null,
    currentBranchId,
    branches: repos.branch.listByChapter(chapter.id).map((branch) => ({
      id: branch.id,
      name: branch.name,
      baseRevisionId: branch.baseRevisionId,
      headRevisionId: branch.headRevisionId,
      status: branch.status,
      createdAt: branch.createdAt,
      isCurrent: branch.id === currentBranchId
    }))
  }
}

export function createBranch(db: Db, repos: Repos, input: CreateBranchInput): CreateBranchResult {
  return withTransaction(db, () => {
    const chapter = requireChapter(repos, input.chapterId)
    if (chapter.status === 'finalized') {
      throw new AppError('already_finalized', '本章已定稿；先「重新打开」再开分支', { chapterId: chapter.id })
    }
    const name = input.name.trim()
    if (name.length === 0 || [...name].length > BRANCH_NAME_MAX) {
      throw new AppError('invalid_args', `分支名需要 1–${BRANCH_NAME_MAX} 个字符`, { name: input.name })
    }
    if (repos.branch.findByName(chapter.id, name) !== null) {
      throw new AppError('invalid_args', '本章已有同名分支', { chapterId: chapter.id, name })
    }
    if (chapter.currentRevisionId === null) {
      throw new AppError('invalid_args', '本章还没有草稿 revision，不能开分支', { chapterId: chapter.id })
    }
    const from = input.fromRevisionId
      ? requireDraftOfChapter(repos, chapter.id, input.fromRevisionId)
      : requireDraftOfChapter(repos, chapter.id, chapter.currentRevisionId)
    const members = repos.revision.manifest(from.id)
    if (members.length === 0) {
      throw new AppError('invalid_args', '来源 revision 清单为空', { revisionId: from.id })
    }

    const branchId = newId('brn')
    const revisionId = newId('rev')
    const at = input.now ?? new Date().toISOString()
    // 先建分支行（head 暂指来源 revision，FK 有效），再插新 revision（branch_id 一次写对，
    // revision 仍然只 INSERT），最后把分支 head 移到新 revision。
    repos.branch.insert({
      id: branchId,
      projectId: chapter.projectId,
      chapterId: chapter.id,
      name,
      baseRevisionId: from.id,
      headRevisionId: from.id,
      createdAt: at
    })
    const contentHash = hashManifestRows(members)
    repos.revision.insert({
      id: revisionId,
      chapterId: chapter.id,
      parentRevisionId: from.id,
      kind: 'draft',
      contentHash,
      createdBy: 'author',
      note: `branch: ${name}`,
      createdAt: at,
      branchId
    })
    repos.revision.insertMembers(
      revisionId,
      members.map((member) => ({
        revisionId,
        beatId: member.beatId,
        sceneOrd: member.sceneOrd,
        beatOrd: member.beatOrd
      }))
    )
    repos.branch.setHead(branchId, revisionId)
    repos.chapter.setCurrentRevision(chapter.id, revisionId)

    const branch = repos.branch.get(branchId)!
    return {
      branch: {
        id: branch.id,
        name: branch.name,
        baseRevisionId: branch.baseRevisionId,
        headRevisionId: branch.headRevisionId,
        status: branch.status,
        createdAt: branch.createdAt,
        isCurrent: true
      },
      revisionId,
      contentHash
    }
  })
}

export function switchBranch(db: Db, repos: Repos, input: SwitchBranchInput): SwitchBranchResult {
  return withTransaction(db, () => {
    const chapter = requireChapter(repos, input.chapterId)
    if (chapter.status === 'finalized') {
      throw new AppError('already_finalized', '本章已定稿；先「重新打开」再切换版本', { chapterId: chapter.id })
    }

    if (input.branchId === null) {
      const mainline = repos.revision.latestMainlineDraft(chapter.id)
      if (!mainline) throw new AppError('invalid_args', '本章还没有主线草稿', { chapterId: chapter.id })
      repos.chapter.setCurrentRevision(chapter.id, mainline.id)
      return { revisionId: mainline.id, branchId: null }
    }

    const branch = repos.branch.get(input.branchId)
    if (!branch || branch.chapterId !== chapter.id) {
      throw new AppError('invalid_args', '分支不属于本章', { chapterId: chapter.id, branchId: input.branchId })
    }
    if (branch.status !== 'open') {
      throw new AppError('invalid_args', '分支已合并或归档，不能再切换', { branchId: branch.id, status: branch.status })
    }
    const head = requireDraftOfChapter(repos, chapter.id, branch.headRevisionId)
    repos.chapter.setCurrentRevision(chapter.id, head.id)
    return { revisionId: head.id, branchId: branch.id }
  })
}
