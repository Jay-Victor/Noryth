import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { asQueryRunner } from '../kysely'
import { bigrams } from '../../tools/support/text'

/**
 * 记忆索引：向量（sqlite-vec）与关键词（FTS5）的写入与召回原语。
 *
 * 可见性过滤全部在 SQL 里完成（DEV-PLAN §10.4）：
 *   status='active' + learned_seq <= as_of + (valid_to_seq IS NULL OR valid_to_seq > as_of)
 * 不在应用层过滤——应用层遗漏一次就是跨角色泄漏。
 *
 * 索引行与业务行同库同事务：apply 在单事务里写 memory_entry + memory_vec + memory_fts，
 * 失败一起回滚，不会出现「有文本无向量」。
 */

export interface VecHit {
  memoryId: string
  /** 归一化向量的 L2 距离；cosine = 1 - d²/2。 */
  distance: number
}

export interface KeywordHit {
  memoryId: string
  /** BM25 取正（FTS5 返回负值，越小越相关）；LIKE 兜底为 0。 */
  score: number
}

export interface VisibilityFilter {
  characterId: string
  asOf: number
  embeddingModel?: string
}

function embeddingBlob(vector: readonly number[]): Buffer {
  const floats = Float32Array.from(vector)
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength)
}

/** FTS5 MATCH 串：每个 token 加引号，内部引号翻倍；OR 连接。 */
export function ftsMatchQuery(text: string): string | null {
  const tokens = [...bigrams(text)]
  if (tokens.length === 0) return null
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

export function bigramsText(text: string): string {
  return [...bigrams(text)].sort().join(' ')
}

export class MemoryIndexRepo {
  private readonly runner: QueryRunner

  constructor(input: Db | QueryRunner) {
    this.runner = asQueryRunner(input)
  }

  writeVector(memoryId: string, vector: readonly number[]): void {
    this.runner.raw
      .prepare('INSERT INTO memory_vec(memory_id, embedding) VALUES (?, ?)')
      .run(memoryId, embeddingBlob(vector))
  }

  hasVector(memoryId: string): boolean {
    const row = this.runner.raw.prepare('SELECT 1 AS ok FROM memory_vec WHERE memory_id = ?').get(memoryId) as
      | { ok: number }
      | undefined
    return row !== undefined
  }

  countVectors(): number {
    const row = this.runner.raw.prepare('SELECT COUNT(*) AS count FROM memory_vec').get() as { count: number }
    return row.count
  }

  /** KNN：k 必须是小整数常量；这里只允许调用方传 1–200 的整数。 */
  searchVector(vector: readonly number[], filter: VisibilityFilter, limit: number): VecHit[] {
    const k = Math.max(1, Math.min(200, Math.trunc(limit)))
    const sql = `
      SELECT v.memory_id AS memory_id, v.distance AS distance
      FROM memory_vec v
      JOIN memory_entry m ON m.id = v.memory_id
      WHERE v.embedding MATCH ?
        AND k = ${k}
        AND m.character_id = ?
        AND m.status = 'active'
        AND m.learned_seq <= ?
        AND (m.valid_to_seq IS NULL OR m.valid_to_seq > ?)
        ${filter.embeddingModel === undefined ? '' : 'AND m.embedding_model = ?'}
      ORDER BY v.distance
    `
    const params: unknown[] = [embeddingBlob(vector), filter.characterId, filter.asOf, filter.asOf]
    if (filter.embeddingModel !== undefined) params.push(filter.embeddingModel)
    return this.runner.raw.prepare(sql).all(...params) as VecHit[]
  }

  writeBigrams(memoryId: string, characterId: string, text: string): void {
    this.runner.raw
      .prepare('INSERT INTO memory_fts(memory_id, character_id, bigrams) VALUES (?, ?, ?)')
      .run(memoryId, characterId, bigramsText(text))
  }

  /** 删旧行前先查 rowid：FTS5 的 UNINDEXED 列不能直接作为删除条件。 */
  deleteBigrams(memoryId: string): void {
    const row = this.runner.raw.prepare('SELECT rowid AS rowid FROM memory_fts WHERE memory_id = ?').get(memoryId) as
      | { rowid: number }
      | undefined
    if (row) this.runner.raw.prepare('DELETE FROM memory_fts WHERE rowid = ?').run(row.rowid)
  }

  searchBigrams(text: string, filter: VisibilityFilter, limit: number): KeywordHit[] {
    const match = ftsMatchQuery(text)
    if (match === null) return []
    const sql = `
      SELECT f.memory_id AS memoryId, bm25(memory_fts) AS bm25
      FROM memory_fts f
      JOIN memory_entry m ON m.id = f.memory_id
      WHERE memory_fts MATCH ?
        AND m.character_id = ?
        AND m.status = 'active'
        AND m.learned_seq <= ?
        AND (m.valid_to_seq IS NULL OR m.valid_to_seq > ?)
        ${filter.embeddingModel === undefined ? '' : 'AND m.embedding_model = ?'}
      ORDER BY bm25
      LIMIT ?
    `
    const params: unknown[] = [match, filter.characterId, filter.asOf, filter.asOf]
    if (filter.embeddingModel !== undefined) params.push(filter.embeddingModel)
    params.push(Math.max(1, Math.min(200, Math.trunc(limit))))
    const rows = this.runner.raw.prepare(sql).all(...params) as Array<{ memoryId: string; bm25: number }>
    return rows.map((row) => ({ memoryId: row.memoryId, score: -row.bm25 }))
  }

  /**
   * 单字/无 bigram 查询的兜底：LIKE 直接扫本人的 active 条目。
   * DEV-PLAN §10.4：单字查询不走向量，避免 bigram 为空导致 0 行。
   */
  searchLike(text: string, filter: VisibilityFilter, limit: number): KeywordHit[] {
    const needle = text.trim()
    if (needle.length === 0) return []
    const rows = this.runner.raw
      .prepare(
        `SELECT id AS memoryId FROM memory_entry
         WHERE character_id = ? AND status = 'active'
           AND learned_seq <= ? AND (valid_to_seq IS NULL OR valid_to_seq > ?)
           AND text LIKE ?
         ORDER BY importance DESC, learned_seq DESC
         LIMIT ?`
      )
      .all(
        filter.characterId,
        filter.asOf,
        filter.asOf,
        `%${needle}%`,
        Math.max(1, Math.min(200, Math.trunc(limit)))
      ) as Array<{ memoryId: string }>
    return rows.map((row) => ({ memoryId: row.memoryId, score: 0 }))
  }
}
