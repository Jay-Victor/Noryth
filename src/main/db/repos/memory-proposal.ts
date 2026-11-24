import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { firstRow, runStatement } from '../kysely'
import type { MemoryProposalItemTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type ProposalKind = 'experience' | 'fact' | 'relationship' | 'cognition' | 'world_fact' | 'belief'
export type ProposalDecision = 'pending' | 'accept' | 'edit' | 'reject'

export interface MemoryProposalItemRecord {
  id: string
  projectId: string
  jobId: string
  kind: ProposalKind
  characterId: string | null
  text: string
  payloadJson: string
  sourceChapterId: string
  sourceRevisionId: string
  sourceBeatId: string | null
  importance: number
  pinned: number
  decision: ProposalDecision
  editedText: string | null
  decidedAt: string | null
  evidenceQuote: string | null
}

export interface NewMemoryProposalItemInput {
  id?: string
  projectId: string
  jobId: string
  kind: ProposalKind
  characterId?: string | null
  text: string
  payloadJson?: string
  sourceChapterId: string
  sourceRevisionId: string
  sourceBeatId?: string | null
  importance?: number
  pinned?: number
  decision?: ProposalDecision
  editedText?: string | null
  decidedAt?: string | null
  evidenceQuote?: string | null
}

type ProposalRow = Selectable<MemoryProposalItemTable>

function mapItem(row: ProposalRow): MemoryProposalItemRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobId: row.job_id,
    kind: row.kind as ProposalKind,
    characterId: row.character_id,
    text: row.text,
    payloadJson: row.payload_json,
    sourceChapterId: row.source_chapter_id,
    sourceRevisionId: row.source_revision_id,
    sourceBeatId: row.source_beat_id,
    importance: row.importance,
    pinned: row.pinned,
    decision: row.decision as ProposalDecision,
    editedText: row.edited_text,
    decidedAt: row.decided_at,
    evidenceQuote: row.evidence_quote
  }
}

/** 记忆固化提案（memory_proposal_item）：提案是数据，决策与应用分离（DEV-PLAN §10.3）。 */
export class MemoryProposalRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewMemoryProposalItemInput): MemoryProposalItemRecord {
    const id = input.id ?? newId('mpi')
    const values: Insertable<MemoryProposalItemTable> = {
      id,
      project_id: input.projectId,
      job_id: input.jobId,
      kind: input.kind,
      character_id: input.characterId ?? null,
      text: input.text,
      payload_json: input.payloadJson ?? '{}',
      source_chapter_id: input.sourceChapterId,
      source_revision_id: input.sourceRevisionId,
      source_beat_id: input.sourceBeatId ?? null,
      importance: input.importance ?? 0.5,
      pinned: input.pinned ?? 0,
      decision: input.decision ?? 'pending',
      edited_text: input.editedText ?? null,
      decided_at: input.decidedAt ?? null,
      evidence_quote: input.evidenceQuote ?? null
    }
    runStatement(this.runner, this.runner.db.insertInto('memory_proposal_item').values(values))
    return this.get(id)!
  }

  get(id: string): MemoryProposalItemRecord | null {
    const row = firstRow<ProposalRow>(
      this.runner,
      this.runner.db.selectFrom('memory_proposal_item').selectAll().where('id', '=', id)
    )
    return row ? mapItem(row) : null
  }

  listByJob(projectId: string, jobId: string): MemoryProposalItemRecord[] {
    // 按插入顺序（rowid）返回：提案在 UI 里是一条时间线，id 是随机十六进制，
    // 用它排序会让每次加载顺序都不同。
    const rows = this.runner.raw
      .prepare('SELECT * FROM memory_proposal_item WHERE project_id = ? AND job_id = ? ORDER BY rowid')
      .all(projectId, jobId) as ProposalRow[]
    return rows.map(mapItem)
  }

  listBySource(chapterId: string): MemoryProposalItemRecord[] {
    const rows = this.runner.raw
      .prepare('SELECT * FROM memory_proposal_item WHERE source_chapter_id = ? ORDER BY rowid')
      .all(chapterId) as ProposalRow[]
    return rows.map(mapItem)
  }

  listByProject(projectId: string, limit = 500): MemoryProposalItemRecord[] {
    const rows = this.runner.raw
      .prepare('SELECT * FROM memory_proposal_item WHERE project_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(projectId, limit) as ProposalRow[]
    return rows.map(mapItem)
  }

  /** 待决策条目（PHASE-22 归档保护）：跨全部历史，不被 500 条浏览上限截断。 */
  listPending(projectId: string): MemoryProposalItemRecord[] {
    const rows = this.runner.raw
      .prepare("SELECT * FROM memory_proposal_item WHERE project_id = ? AND decision = 'pending' ORDER BY rowid")
      .all(projectId) as ProposalRow[]
    return rows.map(mapItem)
  }

  /** 决策只记录结果；应用到记忆/世界状态由 memory.apply 完成。 */
  decide(id: string, decision: Exclude<ProposalDecision, 'pending'>, editedText?: string): MemoryProposalItemRecord {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('memory_proposal_item')
        .set({
          decision,
          edited_text: editedText ?? null,
          decided_at: this.now()
        })
        .where('id', '=', id)
    )
    return this.get(id)!
  }
}
