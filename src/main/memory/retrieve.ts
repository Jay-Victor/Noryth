import type { Repos } from '../db/repos'
import type { MemoryEntryRecord, MemoryKind } from '../db/repos/memory'
import { normalizeText } from '../tools/support/text'
import type { Embedder } from './embed/types'
import { cosineFromDistance } from './embed/types'

/**
 * 检索管线（PHASE-09 H3 / DEV-PLAN §10.4）：
 *
 *   向量 top30 + 关键词 top30 → RRF(k=60, 1.0/0.7) → 绝对下限
 *   → 相对截断（头名 40%）→ 文本去重 → top_k → 追加 pinned（≤5）
 *
 * 可见性过滤全部在 SQL（memory_index），本层只做排序与收口。
 * 空结果不是失败：返回 `empty`，由运行时标 `memory_empty` 继续写。
 *
 * 缓存键 = project + actor + character + as_of + query：apply 后由服务层清空，
 * 避免「刚固化的记忆查不到」。
 */

export interface RetrieveQuery {
  text: string
  topK?: number
  kinds?: readonly MemoryKind[]
}

export interface RetrieveContext {
  projectId: string
  actorId: string
  characterId: string
  asOf: number
  /** 低于该 cosine 且关键词未命中 → 丢弃（默认 0.35，按模型校准）。 */
  threshold?: number
  /** BM25 下限（FTS5 取正后的值）；0 = 只要求命中。 */
  kwFloor?: number
}

export interface RetrievedItem {
  entry: MemoryEntryRecord
  score: number
  channel: 'vector' | 'keyword' | 'both' | 'pinned'
  cosine: number | null
  bm25: number | null
}

export interface RetrieveResult {
  items: RetrievedItem[]
  pinned: RetrievedItem[]
  empty: boolean
  degraded: 'none' | 'empty' | 'facts_only'
  stats: { vectorHits: number; keywordHits: number; fused: number }
}

const CACHE_LIMIT = 128
const cache = new Map<string, RetrieveResult>()

function cacheKey(query: RetrieveQuery, context: RetrieveContext, model: string): string {
  return [
    context.projectId,
    context.actorId,
    context.characterId,
    context.asOf,
    model,
    query.topK ?? 5,
    (query.kinds ?? []).join(','),
    normalizeText(query.text)
  ].join('|')
}

export function invalidateRetrievalCache(projectId?: string): void {
  if (projectId === undefined) {
    cache.clear()
    return
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${projectId}|`)) cache.delete(key)
  }
}

/** RRF：k=60；向量权重 1.0、关键词 0.7（DEV-PLAN §10.4）。 */
function rrf(rank: number, weight: number): number {
  return weight / (60 + rank + 1)
}

function dedupeKey(entry: MemoryEntryRecord): string {
  return normalizeText(entry.text).replace(/\s+/g, '')
}

export async function retrieveOwn(
  repos: Repos,
  embedder: Embedder | null,
  query: RetrieveQuery,
  context: RetrieveContext
): Promise<RetrieveResult> {
  const topK = Math.max(1, Math.min(8, query.topK ?? 5))
  const key = cacheKey(query, context, embedder?.model ?? 'none')
  const hit = cache.get(key)
  if (hit) return hit

  const pinnedEntries = repos.memory.listPinned(context.characterId, context.asOf, 5)
  const pinned: RetrievedItem[] = pinnedEntries.map((entry) => ({
    entry,
    score: 1,
    channel: 'pinned',
    cosine: null,
    bm25: null
  }))

  const text = query.text.trim()
  if (text.length === 0) {
    const empty = pinned.length === 0
    const result: RetrieveResult = {
      items: [],
      pinned,
      empty,
      degraded: empty ? 'empty' : 'none',
      stats: { vectorHits: 0, keywordHits: 0, fused: 0 }
    }
    remember(key, result)
    return result
  }

  const filter = { characterId: context.characterId, asOf: context.asOf }
  let degraded: 'none' | 'empty' | 'facts_only' = 'none'

  // 向量通道：模型不可用或索引为空时降级为关键词，不阻塞正文。
  const cosineById = new Map<string, number>()
  const vectorRank = new Map<string, number>()
  if (embedder !== null) {
    try {
      const [vector] = await embedder.embed([text], 'query')
      if (vector && vector.length > 0) {
        const hits = repos.memoryIndex.searchVector(Array.from(vector), { ...filter, embeddingModel: embedder.model }, 30)
        hits.forEach((hit, rank) => {
          vectorRank.set(hit.memoryId, rank)
          cosineById.set(hit.memoryId, cosineFromDistance(hit.distance))
        })
      }
    } catch {
      degraded = 'facts_only'
    }
  }

  const keywordRank = new Map<string, number>()
  const bm25ById = new Map<string, number>()
  const keywordHits = repos.memoryIndex.searchBigrams(text, filter, 30)
  const keyword = keywordHits.length > 0 ? keywordHits : repos.memoryIndex.searchLike(text, filter, 30)
  keyword.forEach((hit, rank) => {
    keywordRank.set(hit.memoryId, rank)
    bm25ById.set(hit.memoryId, hit.score)
  })

  const threshold = context.threshold ?? 0.35
  const kwFloor = context.kwFloor ?? 0
  const candidates = new Set<string>([...vectorRank.keys(), ...keywordRank.keys()])

  const scored: RetrievedItem[] = []
  for (const memoryId of candidates) {
    const cosine = cosineById.get(memoryId) ?? null
    const bm25 = bm25ById.get(memoryId) ?? null
    const passes = (cosine !== null && cosine >= threshold) || (bm25 !== null && bm25 >= kwFloor)
    if (!passes) continue
    const score = rrf(vectorRank.get(memoryId) ?? 999, 1.0) + rrf(keywordRank.get(memoryId) ?? 999, 0.7)
    const entry = repos.memory.get(memoryId)
    if (!entry) continue
    if (entry.characterId !== context.characterId) continue // 双保险：跨角色永不召回
    if (entry.status !== 'active') continue
    if (entry.learnedSeq > context.asOf) continue
    if (entry.validToSeq !== null && entry.validToSeq <= context.asOf) continue
    if (query.kinds !== undefined && query.kinds.length > 0 && !query.kinds.includes(entry.kind)) continue
    scored.push({
      entry,
      score,
      channel: vectorRank.has(memoryId) && keywordRank.has(memoryId) ? 'both' : vectorRank.has(memoryId) ? 'vector' : 'keyword',
      cosine,
      bm25
    })
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.entry.importance - left.entry.importance ||
      right.entry.learnedSeq - left.entry.learnedSeq ||
      left.entry.id.localeCompare(right.entry.id)
  )

  // 相对截断：低于头名 40% 丢弃（DEV-PLAN §10.4）。
  const head = scored[0]?.score ?? 0
  const cut = head > 0 ? scored.filter((item) => item.score >= head * 0.4) : scored

  const seenText = new Set<string>()
  const deduped: RetrievedItem[] = []
  for (const item of cut) {
    const dedupe = dedupeKey(item.entry)
    if (seenText.has(dedupe)) continue
    seenText.add(dedupe)
    deduped.push(item)
  }

  const items = deduped.slice(0, topK)
  const empty = items.length === 0 && pinned.length === 0
  const result: RetrieveResult = {
    items,
    pinned: pinned.filter((item) => !items.some((entry) => entry.entry.id === item.entry.id)),
    empty,
    degraded: empty ? 'empty' : degraded,
    stats: {
      vectorHits: vectorRank.size,
      keywordHits: keywordRank.size,
      fused: candidates.size
    }
  }
  remember(key, result)
  return result
}

function remember(key: string, result: RetrieveResult): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, result)
}
