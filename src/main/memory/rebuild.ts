import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { sha256Hex } from '../crypto'
import { applyMemoryProposals, type ApplyDecision, type ApplyResult } from './apply'
import type { Embedder } from './embed/types'

/**
 * 按章重建（PHASE-14 M1-4 / DEV-PLAN §10.6）。
 *
 *   1. 只读本章 final revision（未定稿 / 无 final → invalid_args）；
 *   2. 事务外重新抽取，提案落到本次重建专属的 memory.extract job；
 *   3. 单事务（复用 `applyMemoryProposals` 的写入原语）：
 *        旧条目 inactive → 旧事实/边按来源关闭 → 写新条目/向量/事实/边 → 审计 → 消费令牌
 *   4. 失败整体回滚：旧条目仍 active、旧事实/边未关、令牌可重试；
 *   5. 重放同幂等键 → duplicate，不双写。
 *
 * 与作者逐条审提案（阶段 09）不同：T40 是「整章重建」，作者用 author_confirm 授权，
 * 结果可在记忆台逐条复核、软失效。两套语义不混用。
 */

export interface RebuildRequest {
  projectId: string
  chapterId: string
  /** 本次重建的 job（job.type = 'memory.rebuild'，幂等键见 `rebuildJobKey`）。 */
  rebuildJobId: string
  /** 本次重建专属的抽取 job（job.type = 'memory.extract'），提案条目挂在它下面。 */
  proposalJobId: string
  actor: string
  /** author_confirm 令牌哈希；传入则在同一事务里消费。 */
  gateTokenHash: string | null
  /** 逐条决定；整章重建由服务层给出「全部接受」。 */
  decisions: readonly ApplyDecision[]
  now?: string
}

export interface RebuildOutcome extends ApplyResult {
  chapterId: string
  revisionId: string
  closeAtSeq: number
  /** 旧条目 + 旧信念 + 旧事实 + 旧边的总失效率，供 UI 显示。 */
  inactiveCount: number
  rebuiltCount: number
}

/** 幂等键（DEV-PLAN §10.6 / PHASE-14 §5.1）：同一章的同一份定稿只重建一次。 */
export function rebuildJobKey(projectId: string, chapterId: string, finalRevisionId: string): string {
  return `memory.rebuild:${projectId}:${chapterId}:${finalRevisionId}`
}

/** 重建专属抽取 job 的键：与阶段 09 的首次抽取（memory.extract:<revision>）分开。 */
export function rebuildExtractKey(projectId: string, rebuildKey: string): string {
  return sha256Hex(`${projectId}|memory.extract|rebuild|${rebuildKey}`)
}

/**
 * 重建水位：本章认知快照 `covered_until_seq`。
 * 为 0（理论上定稿章不会）时退回项目水位，避免把「关旧值」定在 0 把整章历史抹掉。
 */
export function rebuildCloseAtSeq(repos: Repos, chapterId: string): number {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId })
  const covered = Number.isFinite(chapter.coveredUntilSeq) ? Math.max(0, Math.trunc(chapter.coveredUntilSeq)) : 0
  if (covered > 0) return covered
  const project = repos.project.getById(chapter.projectId)
  return Math.max(0, Math.trunc(project?.seqHead ?? 0))
}

export async function rebuildChapter(
  db: Db,
  repos: Repos,
  input: RebuildRequest,
  embedder: Embedder
): Promise<RebuildOutcome> {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter || chapter.projectId !== input.projectId) {
    throw new AppError('invalid_args', '本章不存在', { chapterId: input.chapterId })
  }
  if (chapter.status !== 'finalized' || chapter.finalRevisionId === null) {
    throw new AppError('invalid_args', '只有定稿章节才能重建记忆', { status: chapter.status })
  }
  const finalRevisionId = chapter.finalRevisionId
  const revision = repos.revision.get(finalRevisionId)
  if (!revision || revision.kind !== 'final') {
    throw new AppError('stale_revision', '定稿 revision 缺失或类型不对', { revisionId: finalRevisionId })
  }

  const closeAtSeq = rebuildCloseAtSeq(repos, chapter.id)
  const applied = await applyMemoryProposals(
    db,
    repos,
    {
      projectId: input.projectId,
      proposalJobId: input.proposalJobId,
      applyJobId: input.rebuildJobId,
      actor: input.actor,
      decisions: input.decisions,
      gateTokenHash: input.gateTokenHash,
      rebuild: { chapterId: chapter.id, closeAtSeq },
      ...(input.now === undefined ? {} : { now: input.now })
    },
    embedder
  )

  return {
    ...applied,
    chapterId: chapter.id,
    revisionId: finalRevisionId,
    closeAtSeq,
    inactiveCount: applied.inactive.length,
    rebuiltCount: applied.memoryIds.length
  }
}

/** 重建结果里对外的计数（job.result_json / UI / T40 输出共用一份口径）。 */
export function rebuildResultPayload(outcome: RebuildOutcome): Record<string, unknown> {
  return {
    applied: true,
    chapterId: outcome.chapterId,
    revisionId: outcome.revisionId,
    closeAtSeq: outcome.closeAtSeq,
    duplicate: outcome.duplicate,
    inactive_count: outcome.inactiveCount,
    rebuilt_count: outcome.rebuiltCount,
    inactive: outcome.inactive,
    rebuilt: outcome.memoryIds,
    closed_facts: outcome.closedFacts,
    closed_edges: outcome.closedEdges,
    inactive_beliefs: outcome.inactiveBeliefs
  }
}
