import type { DimensionKey, Issue, IssueType } from '../../shared/schema/report'
import { REVIEW_ROUND_LIMIT, dimensionsForBlocking } from '../../shared/schema/report'
import type { ChapterRecord } from '../db/repos/chapter'
import type { Repos } from '../db/repos'
import type { PatchRecord } from '../db/repos/patch'
import type { ApprovalReportRecord } from '../db/repos/review'
import { latestReport, parseReportRecord } from './report'

/**
 * 轮次、复检范围与「未复检改动」（DEV-PLAN §9.7 / PHASE-08 §5.4）。
 *
 * 轮次 = 本章已出的报告数（一份报告一轮）。
 * 转人工 = 已到 3 轮且最新一轮仍是 fail；此时 G5 关闭，G6 仍可由作者执行
 * （UI-DESIGN §6.4「3 轮超限仍可定稿，但显示已转人工」）。
 */

export interface RoundState {
  reports: ApprovalReportRecord[]
  latest: ApprovalReportRecord | null
  rounds: number
  takeover: boolean
}

export function roundState(repos: Repos, chapterId: string): RoundState {
  const reports = repos.review.listReportsByChapter(chapterId)
  const latest = latestReport(repos, chapterId)
  const rounds = latest?.round ?? 0
  return {
    reports,
    latest,
    rounds,
    takeover: rounds >= REVIEW_ROUND_LIMIT && latest?.verdict === 'fail'
  }
}

/** 复检只跑受影响维度：上一轮阻断类型 → 维度；没有阻断就全维度（保守）。 */
export function recheckScope(latest: ApprovalReportRecord | null): DimensionKey[] {
  if (!latest) return dimensionsForBlocking([])
  const parsed = parseReportRecord(latest)
  const types = parsed.blocking.map((issue) => issue.type)
  return dimensionsForBlocking(types as IssueType[])
}

export interface UnreviewedChanges {
  /** 报告之后落盘的 revision（含被接受的 patch 与作者手改）。 */
  revisionIds: string[]
  patches: PatchRecord[]
  editedBeatIds: string[]
  items: Array<{ kind: 'patch' | 'edit' | 'revision'; id: string; label: string }>
  count: number
  /** 当前 revision 链上找不到报告 revision（历史被改写/分支）。 */
  diverged: boolean
}

/**
 * 从当前 revision 沿 parent 链回溯到报告 revision，收集两者之间的改动。
 * 用 parent 链而不是时间戳：同一毫秒内多次写入时时间不构成顺序证据。
 */
export function unreviewedChanges(
  repos: Repos,
  chapter: ChapterRecord,
  report: ApprovalReportRecord | null
): UnreviewedChanges {
  const empty: UnreviewedChanges = {
    revisionIds: [],
    patches: [],
    editedBeatIds: [],
    items: [],
    count: 0,
    diverged: false
  }
  if (!report || chapter.currentRevisionId === null) return empty
  if (chapter.currentRevisionId === report.revisionId) return empty

  const chain: string[] = []
  let cursor: string | null = chapter.currentRevisionId
  let found = false
  const guard = new Set<string>()
  while (cursor !== null && !guard.has(cursor)) {
    guard.add(cursor)
    if (cursor === report.revisionId) {
      found = true
      break
    }
    chain.push(cursor)
    cursor = repos.revision.get(cursor)?.parentRevisionId ?? null
  }

  const patches: PatchRecord[] = []
  const editedBeatIds: string[] = []
  const items: UnreviewedChanges['items'] = []
  const chainSet = new Set(chain)
  for (const revisionId of chain) {
    const revision = repos.revision.get(revisionId)
    // patch 的 base 是链上某个 revision；它落在链内的 applied_revision_id 才算「报告之后的改动」。
    for (const patch of repos.patch.listByRevision(revisionId)) {
      if (patch.appliedRevisionId === null || !chainSet.has(patch.appliedRevisionId)) continue
      patches.push(patch)
      items.push({ kind: 'patch', id: patch.id, label: `patch ${patch.id} · ${patch.beatId}` })
    }
    // 手改：拍必须是在报告之后的 revision 里创建的，否则会把报告前的编辑算进来。
    for (const member of repos.revision.listMembers(revisionId)) {
      const beat = repos.beat.get(member.beatId)
      if (!beat || beat.authorEdited !== 1) continue
      if (!chainSet.has(beat.createdRevisionId)) continue
      editedBeatIds.push(beat.id)
      items.push({ kind: 'edit', id: beat.id, label: `手改 ${beat.id}（第 ${member.beatOrd} 拍）` })
    }
    if (revision && revision.createdBy === 'reviewer' && patches.length === 0) {
      items.push({ kind: 'revision', id: revisionId, label: `revision ${revisionId}` })
    }
  }

  return {
    revisionIds: chain,
    patches,
    editedBeatIds,
    items,
    count: items.length,
    diverged: !found
  }
}

/** G5 前置：有报告、未到轮次上限、没有待决 patch、未定稿。 */
export function g5State(
  repos: Repos,
  chapter: ChapterRecord,
  round: RoundState
): { allowed: boolean; reason: string | null; round: number } {
  if (chapter.status === 'finalized') {
    return { allowed: false, reason: '本章已定稿；要改请先重新打开', round: round.rounds }
  }
  if (!round.latest) {
    return { allowed: false, reason: '先生成审批报告（G4）', round: round.rounds }
  }
  if (round.takeover) {
    return { allowed: false, reason: `已修订 ${REVIEW_ROUND_LIMIT} 轮，转人工`, round: round.rounds }
  }
  const pending = repos.patch
    .listByRevision(chapter.currentRevisionId ?? '')
    .filter((patch) => patch.status === 'proposed')
  if (pending.length > 0) {
    return { allowed: false, reason: `还有 ${pending.length} 条 patch 待处理`, round: round.rounds }
  }
  return { allowed: true, reason: null, round: round.rounds }
}

/** 阻断项计数（按拍分组，初稿 gutter 用）。 */
export function issueCountsByBeat(
  blocking: readonly Issue[],
  suggestions: readonly Issue[]
): Map<string, { blocking: number; suggestions: number }> {
  const counts = new Map<string, { blocking: number; suggestions: number }>()
  const bump = (beatId: string, key: 'blocking' | 'suggestions'): void => {
    if (beatId.length === 0) return
    const current = counts.get(beatId) ?? { blocking: 0, suggestions: 0 }
    current[key] += 1
    counts.set(beatId, current)
  }
  for (const issue of blocking) bump(issue.beat_id, 'blocking')
  for (const issue of suggestions) bump(issue.beat_id, 'suggestions')
  return counts
}
