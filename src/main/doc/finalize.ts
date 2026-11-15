import { AppError } from '../../shared/domain/app-error'
import type { Issue } from '../../shared/schema/report'
import type { ReviewUnreviewedItem } from '../../shared/schema/review'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { newId } from '../db/repos/common'
import { hashManifestRows, sha256Hex } from '../db/hash'
import { recomputeCoveredUntilSeq } from '../db/seq'
import { withTransaction } from '../db/tx'
import { chapterTransition } from '../scheduler/transitions'

/**
 * 定稿（DEV-PLAN §9.5 / PHASE-08 §5.3）。
 *
 * 不变量：
 *   - 只能由作者触发，且必须带 `gate_record(G6)`（令牌校验在 review/gates.ts，
 *     这里再核对记录本身，防止有人绕过服务直接调 DocController）。
 *   - final 是**清单快照**：只 INSERT revision + revision_beat，正文行不动。
 *   - 定稿后 `commitBeat` 会拒绝任何正文写入（chapter.status === 'finalized'）。
 *   - 幂等：已定稿直接返回现有 final，不重复建 revision / job。
 *   - 入队 `memory.extract`（queued），阶段 09 才真正执行。
 */

export interface FinalizeChapterInput {
  chapterId: string
  /** G6 的 gate_record id（令牌签发时写入的那一行）。 */
  gateRecordId: string
  actor: string
  /** 有阻断时必须勾选；勾选后写进 gate payload 留痕。 */
  ackBlocking: boolean
  /** 有未复检改动时必须勾选。 */
  ackUnreviewed: boolean
  blocking: readonly Issue[]
  unreviewed: readonly ReviewUnreviewedItem[]
  reason?: string | null
  now?: string
}

export interface FinalizeChapterResult {
  finalRevisionId: string
  sourceRevisionId: string
  contentHash: string
  memoryJobId: string | null
  alreadyFinalized: boolean
}

function memoryJobKey(projectId: string, finalRevisionId: string): string {
  return sha256Hex(`${projectId}|memory.extract|${finalRevisionId}`)
}

export function finalizeChapter(db: Db, repos: Repos, input: FinalizeChapterInput): FinalizeChapterResult {
  return withTransaction(db, () => {
    const chapter = repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)

    if (chapter.status === 'finalized' && chapter.finalRevisionId !== null) {
      const final = repos.revision.get(chapter.finalRevisionId)
      return {
        finalRevisionId: chapter.finalRevisionId,
        sourceRevisionId: final?.parentRevisionId ?? chapter.currentRevisionId ?? chapter.finalRevisionId,
        contentHash: final?.contentHash ?? '',
        memoryJobId: null,
        alreadyFinalized: true
      }
    }

    const gate = repos.gate.get(input.gateRecordId)
    if (!gate) throw new AppError('gate_required', 'G6 记录不存在', { gateId: 'G6' })
    if (gate.gateId !== 'G6') throw new AppError('gate_required', '需要 G6 记录', { gateId: gate.gateId })
    if (gate.entityType !== 'chapter' || gate.entityId !== chapter.id) {
      throw new AppError('stale_revision', 'G6 记录与本章不匹配', {
        expected: { entityType: 'chapter', entityId: chapter.id },
        actual: { entityType: gate.entityType, entityId: gate.entityId }
      })
    }
    if (gate.decision !== 'approve') throw new AppError('gate_required', 'G6 未批准')

    if (chapter.currentRevisionId === null) {
      throw new AppError('invalid_args', '本章还没有草稿，不能定稿')
    }

    if (input.blocking.length > 0 && !input.ackBlocking) {
      throw new AppError('gate_required', '有未确认的阻断项', {
        gateId: 'G6',
        blocking: input.blocking.length,
        first: input.blocking[0]?.issue_id ?? null
      })
    }
    if (input.unreviewed.length > 0 && !input.ackUnreviewed) {
      throw new AppError('gate_required', '有未复检的改动', {
        gateId: 'G6',
        unreviewed: input.unreviewed.length
      })
    }

    const sourceRevisionId = chapter.currentRevisionId
    const members = repos.revision.manifest(sourceRevisionId)
    if (members.length === 0) throw new AppError('invalid_args', '当前草稿清单为空')
    const contentHash = hashManifestRows(
      members.map((row) => ({
        sceneId: row.sceneId,
        sceneOrd: row.sceneOrd,
        beatOrd: row.beatOrd,
        speakerType: row.speakerType,
        speakerId: row.speakerId,
        body: row.body
      }))
    )

    const finalRevisionId = newId('rev')
    const at = input.now ?? new Date().toISOString()
    repos.revision.insert({
      id: finalRevisionId,
      chapterId: chapter.id,
      parentRevisionId: sourceRevisionId,
      kind: 'final',
      contentHash,
      createdBy: 'author',
      note: input.reason ?? null,
      createdAt: at
    })
    repos.revision.insertMembers(
      finalRevisionId,
      members.map((member) => ({
        revisionId: finalRevisionId,
        beatId: member.beatId,
        sceneOrd: member.sceneOrd,
        beatOrd: member.beatOrd
      }))
    )

    // 状态先走到 approved，再走 FINALIZE：状态机表是唯一真源。
    let status = chapter.status
    if (status !== 'approved') {
      if (status === 'draft_complete') status = chapterTransition(status, 'REVIEW')
      if (status === 'under_review' || status === 'revising') status = chapterTransition(status, 'APPROVE')
      if (status !== 'approved') {
        throw new AppError('invalid_args', `章节状态 ${chapter.status} 不能定稿`, { status: chapter.status })
      }
      repos.chapter.setStatus(chapter.id, status)
    }
    repos.chapter.markFinalized(chapter.id, finalRevisionId)
    recomputeCoveredUntilSeq(db, chapter.id)

    // 审计：把 ack 与最终 revision 补记到 G6 记录上（令牌行只有一份，不写第二条）。
    repos.gate.annotatePayload(
      gate.id,
      JSON.stringify({
        ...(safeParse(gate.payloadJson) ?? {}),
        ackedBlocking: input.blocking.length > 0 ? input.ackBlocking : true,
        ackedUnreviewed: input.unreviewed.length > 0 ? input.ackUnreviewed : true,
        blockingCount: input.blocking.length,
        unreviewedCount: input.unreviewed.length,
        reason: input.reason ?? null,
        sourceRevisionId,
        finalRevisionId
      })
    )

    const project = repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const key = memoryJobKey(project.id, finalRevisionId)
    const existing = repos.job.findByIdempotency(project.id, key)
    const job =
      existing ??
      repos.job.insert({
        projectId: project.id,
        type: 'memory.extract',
        status: 'queued',
        expectedRevision: finalRevisionId,
        epoch: project.writeEpoch,
        idempotencyKey: key,
        payloadJson: JSON.stringify({
          chapterId: chapter.id,
          revisionId: finalRevisionId,
          requestedBy: input.actor
        })
      })

    return {
      finalRevisionId,
      sourceRevisionId,
      contentHash,
      memoryJobId: job.id,
      alreadyFinalized: false
    }
  })
}

function safeParse(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
