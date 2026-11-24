import { sha256Hex } from '../crypto'
import type { Repos } from '../db/repos'
import type { MemoryEntryRecord } from '../db/repos/memory'
import { normalizeText } from '../tools/support/text'

/**
 * 非事实类记忆归档（PHASE-22 §5.1 / M2-7）。
 *
 * 本文件只做**规则与编排**：候选是纯函数输出，不写库。
 * 真正的写入在 `memory/apply.archiveMemoryEntries`（单一写入者 + 单事务 + 审计）。
 *
 * 候选必须同时满足五条（PHASE-22 §5.1）：
 *   1. `kind='experience'`（fact / relationship / cognition 永不进入）；
 *   2. active、未归档、未 pin、`importance <= 0.30`；
 *   3. 没有被有效事实 / 关系边按来源引用；
 *   4. 同角色内存在 keeper：文本完全相等（NFKC + 去空白）或**同一嵌入模型**余弦 ≥ 0.92；
 *      keeper 的重要度不低于候选，相同则取更新 `learned_seq`；
 *   5. 不是待决策提案的来源拍。
 *
 * 不做语义判断（「这句话是氛围还是承诺」），只用 kind 白名单与引用保护。
 */

export const ARCHIVE_KIND = 'experience' as const
export const ARCHIVE_IMPORTANCE_MAX = 0.3
export const ARCHIVE_SIMILARITY_MIN = 0.92
export const ARCHIVE_BATCH_LIMIT = 50
export const ARCHIVE_REASON = 'redundant' as const

export type ArchiveReason = 'duplicate_experience'

export type ArchiveBlockReason =
  | 'missing'
  | 'not_experience'
  | 'already_archived'
  | 'not_active'
  | 'pinned'
  | 'important'
  | 'referenced'
  | 'pending_proposal'
  | 'no_keeper'

export interface ArchiveCandidate {
  id: string
  characterId: string
  text: string
  importance: number
  learnedSeq: number
  keeperId: string
  keeperText: string
  similarity: number
  reason: ArchiveReason
}

export interface ArchiveProtection {
  /** 被有效 `world_fact` / `relationship_edge` 按来源引用的记忆条目 id。 */
  referenced: Set<string>
  /** 仍有 pending 提案的来源拍 id。 */
  pendingBeats: Set<string>
}

export function archiveProtectionOf(repos: Repos, projectId: string): ArchiveProtection {
  const referenced = new Set<string>()
  for (const fact of repos.world.listByProject(projectId)) {
    if (fact.validToSeq !== null) continue
    if (fact.sourceType === 'memory' && fact.sourceId !== null) referenced.add(fact.sourceId)
  }
  for (const edge of repos.relationship.listActiveAll()) {
    if (edge.sourceType === 'memory' && edge.sourceId !== null) referenced.add(edge.sourceId)
  }
  const pendingBeats = new Set<string>()
  for (const item of repos.memoryProposal.listPending(projectId)) {
    if (item.sourceBeatId !== null) pendingBeats.add(item.sourceBeatId)
  }
  return { referenced, pendingBeats }
}

/** NFKC + 去空白：只用于「文本完全相等」判断，不做模糊匹配。 */
function textKey(text: string): string {
  return normalizeText(text).replace(/\s+/g, '')
}

function cosineOf(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function eligibilityOf(entry: MemoryEntryRecord, protection: ArchiveProtection): ArchiveBlockReason | null {
  if (entry.kind !== ARCHIVE_KIND) return 'not_experience'
  if (entry.archivedAt !== null) return 'already_archived'
  if (entry.status !== 'active') return 'not_active'
  if (entry.pinned === 1) return 'pinned'
  if (entry.importance > ARCHIVE_IMPORTANCE_MAX) return 'important'
  if (entry.sourceBeatId !== null && protection.pendingBeats.has(entry.sourceBeatId)) return 'pending_proposal'
  if (protection.referenced.has(entry.id)) return 'referenced'
  return null
}

interface KeeperHit {
  keeper: MemoryEntryRecord
  similarity: number
}

type VectorLookup = (entry: MemoryEntryRecord) => Float32Array | null

/**
 * 同角色 keeper：`group` 已按 `(importance desc, learnedSeq desc, id asc)` 排序。
 * 文本相等优先（相似度 1）；否则只有**同一 embedding_model** 才比余弦。
 * 因为按重要度降序，扫到低于候选重要度即可停。
 *
 * PHASE-23 M2-6：3k 条记忆时逐条 `textKey()` 与逐条读向量都是热点：
 * 文本键按条目缓存一次，向量按角色一次批量读回（`readVectors`）。
 */
function keeperOf(
  candidate: MemoryEntryRecord,
  group: readonly MemoryEntryRecord[],
  vectorOf: VectorLookup,
  keyOf: (entry: MemoryEntryRecord) => string
): KeeperHit | null {
  const key = keyOf(candidate)
  const candidateVector = vectorOf(candidate)
  let similar: KeeperHit | null = null
  for (const other of group) {
    if (other.id === candidate.id) continue
    if (other.importance < candidate.importance) break
    if (keyOf(other) === key) return { keeper: other, similarity: 1 }
    if (similar !== null) continue
    if (candidateVector === null) continue
    const otherVector = vectorOf(other)
    if (otherVector === null) continue
    const cosine = cosineOf(candidateVector, otherVector)
    if (cosine >= ARCHIVE_SIMILARITY_MIN) {
      similar = { keeper: other, similarity: Math.round(cosine * 1e6) / 1e6 }
    }
  }
  return similar
}

function compareKeeperOrder(left: MemoryEntryRecord, right: MemoryEntryRecord): number {
  return (
    right.importance - left.importance ||
    right.learnedSeq - left.learnedSeq ||
    left.id.localeCompare(right.id)
  )
}

/**
 * 生成候选（确定性）：按 `(character_id, learned_seq, id)` 排序，最多 50 条。
 * 同一角色内允许出现多条候选，但 keeper 永远不会同时是候选的「唯一保留者」：
 * keeper 是排序最靠前、重要度不低于候选的那一条。
 */
export function buildArchiveCandidates(repos: Repos, projectId: string): ArchiveCandidate[] {
  const entries = repos.memory.listByProject(projectId, { includeArchived: true })
  const protection = archiveProtectionOf(repos, projectId)
  const byCharacter = new Map<string, MemoryEntryRecord[]>()
  for (const entry of entries) {
    if (entry.status !== 'active' || entry.archivedAt !== null) continue
    const list = byCharacter.get(entry.characterId) ?? []
    list.push(entry)
    byCharacter.set(entry.characterId, list)
  }
  for (const group of byCharacter.values()) group.sort(compareKeeperOrder)

  const textKeys = new Map<string, string>()
  const keyOf = (entry: MemoryEntryRecord): string => {
    const cached = textKeys.get(entry.id)
    if (cached !== undefined) return cached
    const key = textKey(entry.text)
    textKeys.set(entry.id, key)
    return key
  }

  // 向量按角色批量读回（PHASE-23 M2-6）：同一角色只发一条 IN 查询。
  const vectorsByCharacter = new Map<string, Map<string, Float32Array>>()
  const vectorOfFor = (characterId: string, group: readonly MemoryEntryRecord[]): VectorLookup => {
    return (entry) => {
      let vectors = vectorsByCharacter.get(characterId)
      if (vectors === undefined) {
        vectors = repos.memoryIndex.readVectors(group.map((item) => item.id))
        vectorsByCharacter.set(characterId, vectors)
      }
      return vectors.get(entry.id) ?? null
    }
  }

  const candidates: ArchiveCandidate[] = []
  const ordered = [...entries]
    .filter((entry) => eligibilityOf(entry, protection) === null)
    .sort(
      (left, right) =>
        left.characterId.localeCompare(right.characterId) ||
        left.learnedSeq - right.learnedSeq ||
        left.id.localeCompare(right.id)
    )
  for (const entry of ordered) {
    const group = byCharacter.get(entry.characterId) ?? []
    const hit = keeperOf(entry, group, vectorOfFor(entry.characterId, group), keyOf)
    if (hit === null) continue
    candidates.push({
      id: entry.id,
      characterId: entry.characterId,
      text: entry.text,
      importance: entry.importance,
      learnedSeq: entry.learnedSeq,
      keeperId: hit.keeper.id,
      keeperText: hit.keeper.text,
      similarity: hit.similarity,
      reason: 'duplicate_experience'
    })
    if (candidates.length >= ARCHIVE_BATCH_LIMIT) break
  }
  return candidates
}

/**
 * 单条不可归档的原因（执行时重新校验用；null = 仍是有效候选）。
 * `candidateIds` 由同一次 `buildArchiveCandidates` 结果提供，避免重复扫描。
 */
export function archiveBlockReasonOf(
  repos: Repos,
  projectId: string,
  entryId: string,
  candidateIds: ReadonlySet<string>,
  protection?: ArchiveProtection
): ArchiveBlockReason | null {
  const entry = repos.memory.get(entryId)
  if (!entry || entry.projectId !== projectId) return 'missing'
  const guard = protection ?? archiveProtectionOf(repos, projectId)
  const reason = eligibilityOf(entry, guard)
  if (reason !== null) return reason
  return candidateIds.has(entry.id) ? null : 'no_keeper'
}

/** 幂等批次 id：同一组 id（顺序无关）永远得到同一个哈希。 */
export function archiveBatchId(ids: readonly string[]): string {
  const normalized = [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))].sort()
  return sha256Hex(`memory.archive|${normalized.join('|')}`)
}
