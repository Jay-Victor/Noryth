import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { ChapterSummaryTable } from '../schema'
import { BaseRepo, type Clock, systemClock } from './common'

/**
 * 章末摘要（PHASE-16 §5.4 / M1-13）。
 *
 * 按 `revision_id` 主键保存：重开再定稿会生成新的 final 与新摘要，
 * 旧 final 的摘要永久保留（可用于对比 / 回退）。
 * 摘要不参与 revision hash，也不写 `beat.body`。
 */

export type SummarySource = 'extractive' | 'model'

export interface ChapterSummaryEntry {
  revisionId: string
  chapterId: string
  projectId: string
  summary: string
  keyFactsJson: string
  tokens: number
  source: SummarySource
  createdAt: string
}

export interface NewChapterSummaryInput {
  revisionId: string
  chapterId: string
  projectId: string
  summary: string
  keyFacts?: readonly string[]
  tokens: number
  source?: SummarySource
  createdAt?: string
}

type SummaryRow = Selectable<ChapterSummaryTable>

function mapSummary(row: SummaryRow): ChapterSummaryEntry {
  return {
    revisionId: row.revision_id,
    chapterId: row.chapter_id,
    projectId: row.project_id,
    summary: row.summary,
    keyFactsJson: row.key_facts_json,
    tokens: row.tokens,
    source: row.source as SummarySource,
    createdAt: row.created_at
  }
}

export class ChapterSummaryRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewChapterSummaryInput): ChapterSummaryEntry {
    const values: Insertable<ChapterSummaryTable> = {
      revision_id: input.revisionId,
      chapter_id: input.chapterId,
      project_id: input.projectId,
      summary: input.summary,
      key_facts_json: JSON.stringify(input.keyFacts ?? []),
      tokens: input.tokens,
      source: input.source ?? 'extractive',
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('chapter_summary').values(values))
    return this.get(input.revisionId)!
  }

  get(revisionId: string): ChapterSummaryEntry | null {
    const row = firstRow<SummaryRow>(
      this.runner,
      this.runner.db.selectFrom('chapter_summary').selectAll().where('revision_id', '=', revisionId)
    )
    return row ? mapSummary(row) : null
  }

  /** 同一章可能有多份摘要（每次定稿一份）；装配只取最新一份。 */
  latestByChapter(chapterId: string): ChapterSummaryEntry | null {
    const row = firstRow<SummaryRow>(
      this.runner,
      this.runner.db
        .selectFrom('chapter_summary')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at', 'desc')
        .orderBy('revision_id', 'desc')
        .limit(1)
    )
    return row ? mapSummary(row) : null
  }

  listByChapter(chapterId: string): ChapterSummaryEntry[] {
    const rows = allRows<SummaryRow>(
      this.runner,
      this.runner.db
        .selectFrom('chapter_summary')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .orderBy('created_at')
        .orderBy('revision_id')
    )
    return rows.map(mapSummary)
  }
}
