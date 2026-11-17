import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { ApprovalReportTable, GateRecordTable, ReviewMessageTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type Verdict = 'pass' | 'pass_with_notes' | 'fail'
export type GateId = 'G0' | 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7' | 'author_confirm'
export type GateDecision = 'approve' | 'reject' | 'edit'

export interface ApprovalReportRecord {
  id: string
  projectId: string
  chapterId: string
  revisionId: string
  round: number
  verdict: Verdict
  blockingJson: string
  suggestionsJson: string
  dimensionsJson: string
  /** 复检范围（维度键数组）；空数组 = 全量报告。 */
  scopeJson: string
  degraded: string | null
  model: string | null
  /** 异构复检留痕（PHASE-16 §5.3）。 */
  provider: string | null
  createdAt: string
}

export interface NewApprovalReportInput {
  id?: string
  projectId: string
  chapterId: string
  revisionId: string
  round: number
  verdict: Verdict
  blockingJson?: string
  suggestionsJson?: string
  dimensionsJson?: string
  scopeJson?: string
  degraded?: string | null
  model?: string | null
  provider?: string | null
  createdAt?: string
}

export interface GateRecordRecord {
  id: string
  projectId: string
  gateId: GateId
  entityType: string
  entityId: string
  decision: GateDecision
  actor: string
  payloadJson: string
  tokenHash: string | null
  expiresAt: string | null
  consumedAt: string | null
  createdAt: string
}

export interface NewGateRecordInput {
  id?: string
  projectId: string
  gateId: GateId
  entityType: string
  entityId: string
  decision: GateDecision
  actor: string
  payloadJson?: string
  tokenHash?: string | null
  expiresAt?: string | null
  createdAt?: string
}

type ApprovalRow = Selectable<ApprovalReportTable>
type GateRow = Selectable<GateRecordTable>

function mapApproval(row: ApprovalRow): ApprovalReportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    revisionId: row.revision_id,
    round: row.round,
    verdict: row.verdict as Verdict,
    blockingJson: row.blocking_json,
    suggestionsJson: row.suggestions_json,
    dimensionsJson: row.dimensions_json,
    scopeJson: row.scope_json,
    degraded: row.degraded,
    model: row.model,
    provider: row.provider ?? null,
    createdAt: row.created_at
  }
}

function mapGate(row: GateRow): GateRecordRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    gateId: row.gate_id as GateId,
    entityType: row.entity_type,
    entityId: row.entity_id,
    decision: row.decision as GateDecision,
    actor: row.actor,
    payloadJson: row.payload_json,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at
  }
}

export class ReviewRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insertReport(input: NewApprovalReportInput): ApprovalReportRecord {
    const id = input.id ?? newId('rpt')
    const values: Insertable<ApprovalReportTable> = {
      id,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      revision_id: input.revisionId,
      round: input.round,
      verdict: input.verdict,
      blocking_json: input.blockingJson ?? '[]',
      suggestions_json: input.suggestionsJson ?? '[]',
      dimensions_json: input.dimensionsJson ?? '{}',
      scope_json: input.scopeJson ?? '[]',
      degraded: input.degraded ?? null,
      model: input.model ?? null,
      provider: input.provider ?? null,
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('approval_report').values(values))
    return this.getReport(id)!
  }

  getReport(id: string): ApprovalReportRecord | null {
    const row = firstRow<ApprovalRow>(
      this.runner,
      this.runner.db.selectFrom('approval_report').selectAll().where('id', '=', id)
    )
    return row ? mapApproval(row) : null
  }

  listReportsByChapter(chapterId: string): ApprovalReportRecord[] {
    const rows = allRows<ApprovalRow>(
      this.runner,
      this.runner.db
        .selectFrom('approval_report')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('round')
        .orderBy('created_at')
    )
    return rows.map(mapApproval)
  }

  /**
   * 补记降级原因（如 pass 但确定性检查没跑）。
   * 只改 degraded，不改 verdict/条目；报告本身不可变。
   */
  setDegraded(id: string, degraded: string): ApprovalReportRecord | null {
    const row = firstRow<ApprovalRow>(
      this.runner,
      this.runner.db
        .updateTable('approval_report')
        .set({ degraded })
        .where('id', '=', id)
        .returningAll()
    )
    return row ? mapApproval(row) : null
  }

  /**
   * 补记复检范围：报告可能由 T35 提交（工具不知道复检维度），
   * 由运行时在回合结束后写入；只改 scope，不改条目。
   */
  setScope(id: string, scopeJson: string): ApprovalReportRecord | null {
    const row = firstRow<ApprovalRow>(
      this.runner,
      this.runner.db
        .updateTable('approval_report')
        .set({ scope_json: scopeJson })
        .where('id', '=', id)
        .returningAll()
    )
    return row ? mapApproval(row) : null
  }

  /**
   * 补记 provider（PHASE-16 §5.3）：T35 提交报告时工具不知道真实绑定，
   * 由审批运行时在回合结束后写入；只改 provider，不改条目与 verdict。
   */
  setProvider(id: string, provider: string | null, model?: string | null): ApprovalReportRecord | null {
    const row = firstRow<ApprovalRow>(
      this.runner,
      this.runner.db
        .updateTable('approval_report')
        .set(model === undefined ? { provider } : { provider, model })
        .where('id', '=', id)
        .returningAll()
    )
    return row ? mapApproval(row) : null
  }
}

/** 闸门审计：G1 是长期授权，G5/G6/G7 是一次性令牌（C9）。 */
export class GateRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewGateRecordInput): GateRecordRecord {
    const id = input.id ?? newId('gate')
    const values: Insertable<GateRecordTable> = {
      id,
      project_id: input.projectId,
      gate_id: input.gateId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      decision: input.decision,
      actor: input.actor,
      payload_json: input.payloadJson ?? '{}',
      token_hash: input.tokenHash ?? null,
      expires_at: input.expiresAt ?? null,
      consumed_at: null,
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('gate_record').values(values))
    return this.get(id)!
  }

  get(id: string): GateRecordRecord | null {
    const row = firstRow<GateRow>(
      this.runner,
      this.runner.db.selectFrom('gate_record').selectAll().where('id', '=', id)
    )
    return row ? mapGate(row) : null
  }

  findByTokenHash(tokenHash: string): GateRecordRecord | null {
    const row = firstRow<GateRow>(
      this.runner,
      this.runner.db.selectFrom('gate_record').selectAll().where('token_hash', '=', tokenHash)
    )
    return row ? mapGate(row) : null
  }

  listByEntity(entityType: string, entityId: string): GateRecordRecord[] {
    const rows = allRows<GateRow>(
      this.runner,
      this.runner.db
        .selectFrom('gate_record')
        .selectAll()
        .where('entity_type', '=', entityType)
        .where('entity_id', '=', entityId)
        .orderBy('created_at')
    )
    return rows.map(mapGate)
  }

  /**
   * 原子消费一次性令牌：只有 consumed_at IS NULL 的行会被更新。
   * 返回 null 表示令牌不存在或已被消费，调用方映射为 gate_consumed。
   */
  consumeToken(tokenHash: string): GateRecordRecord | null {
    const row = firstRow<GateRow>(
      this.runner,
      this.runner.db
        .updateTable('gate_record')
        .set({ consumed_at: this.now() })
        .where('token_hash', '=', tokenHash)
        .where('consumed_at', 'is', null)
        .returningAll()
    )
    return row ? mapGate(row) : null
  }

  /**
   * 执行后补记 payload（G6 的 ack 在 finalize 时才确定，令牌在 issue 时已落库）。
   * 只允许补记 payload，不改 decision / token_hash / consumed_at。
   */
  annotatePayload(id: string, payloadJson: string): GateRecordRecord | null {
    const row = firstRow<GateRow>(
      this.runner,
      this.runner.db
        .updateTable('gate_record')
        .set({ payload_json: payloadJson })
        .where('id', '=', id)
        .returningAll()
    )
    return row ? mapGate(row) : null
  }
}

export type ReviewMessageRole = 'author' | 'reviewer' | 'system'
export type ReviewMessageKind = 'text' | 'report' | 'patch' | 'pause'

export interface ReviewMessageRecord {
  id: string
  projectId: string
  chapterId: string
  round: number
  role: ReviewMessageRole
  kind: ReviewMessageKind
  body: string
  metaJson: string
  createdAt: string
}

export interface NewReviewMessageInput {
  id?: string
  projectId: string
  chapterId: string
  round?: number
  role: ReviewMessageRole
  kind?: ReviewMessageKind
  body?: string
  metaJson?: string
  createdAt?: string
}

type ReviewMessageRow = Selectable<ReviewMessageTable>

function mapReviewMessage(row: ReviewMessageRow): ReviewMessageRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    chapterId: row.chapter_id,
    round: row.round,
    role: row.role as ReviewMessageRole,
    kind: row.kind as ReviewMessageKind,
    body: row.body,
    metaJson: row.meta_json,
    createdAt: row.created_at
  }
}

/** 审批台对话（UI-DESIGN §6.3）：讨论不改稿，消息只用于解释与追问。 */
export class ReviewMessageRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewReviewMessageInput): ReviewMessageRecord {
    const id = input.id ?? newId('rmsg')
    const values: Insertable<ReviewMessageTable> = {
      id,
      project_id: input.projectId,
      chapter_id: input.chapterId,
      round: input.round ?? 0,
      role: input.role,
      kind: input.kind ?? 'text',
      body: input.body ?? '',
      meta_json: input.metaJson ?? '{}',
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('review_message').values(values))
    return this.get(id)!
  }

  get(id: string): ReviewMessageRecord | null {
    const row = firstRow<ReviewMessageRow>(
      this.runner,
      this.runner.db.selectFrom('review_message').selectAll().where('id', '=', id)
    )
    return row ? mapReviewMessage(row) : null
  }

  listByChapter(chapterId: string, limit = 80): ReviewMessageRecord[] {
    const rows = allRows<ReviewMessageRow>(
      this.runner,
      this.runner.db
        .selectFrom('review_message')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at')
        .limit(limit)
    )
    return rows.map(mapReviewMessage)
  }
}
