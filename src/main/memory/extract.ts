import { AppError } from '../../shared/domain/app-error'
import type { Repos } from '../db/repos'
import type { MemoryProposalItemRecord, ProposalKind } from '../db/repos/memory-proposal'
import { classifyProposal } from './classify'
import { checkEvidence, type EvidenceReason } from './evidence'

/**
 * 抽取输入与提案落库（PHASE-09 H1 / DEV-PLAN §10.1）。
 *
 * 只读 `revision.kind='final'`：初稿、未确认拍、未接受 patch 都不进记忆。
 * 输入用定稿清单（revision_beat）而不是 live 拍表——清单是快照，改稿不会污染。
 *
 * 输出逐条落 `memory_proposal_item`，**不写记忆库、不写世界状态**：
 * 决策与应用是后面两步（DEV-PLAN §10.3）。
 */

export interface ExtractionBeat {
  id: string
  seq: number
  speakerType: 'character' | 'narrator'
  speakerId: string
  body: string
}

export interface ExtractionCharacter {
  id: string
  name: string
  cardJson: string
}

export interface ExtractionFact {
  id: string
  subject: string
  predicate: string
  object: string
  truth: 'objective' | 'claim'
  validToSeq: number | null
}

export interface ExtractionBelief {
  id: string
  characterId: string
  text: string
}

export interface ExtractionEdge {
  id: string
  fromId: string
  toId: string
  axis: string
  value: number
}

export interface ExtractionInput {
  chapter: { id: string; ord: number; title: string; finalRevisionId: string; coveredUntilSeq: number }
  beats: ExtractionBeat[]
  characters: ExtractionCharacter[]
  facts: ExtractionFact[]
  beliefs: ExtractionBelief[]
  edges: ExtractionEdge[]
}

export function extractionBodies(input: ExtractionInput): Map<string, string> {
  return new Map(input.beats.map((beat) => [beat.id, beat.body]))
}

export function buildExtractionInput(repos: Repos, chapterId: string): ExtractionInput {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} not found`)
  if (chapter.status !== 'finalized' || chapter.finalRevisionId === null) {
    throw new AppError('invalid_args', '只有定稿章节才能抽取记忆', { status: chapter.status })
  }
  const finalId = chapter.finalRevisionId
  const revision = repos.revision.get(finalId)
  if (!revision || revision.kind !== 'final') {
    throw new AppError('stale_revision', '定稿 revision 缺失或类型不对')
  }
  const members = repos.revision.manifest(finalId)
  const beats: ExtractionBeat[] = members.map((row) => {
    const beat = repos.beat.get(row.beatId)
    return {
      id: row.beatId,
      seq: beat?.seq ?? 0,
      speakerType: row.speakerType,
      speakerId: row.speakerId,
      body: row.body
    }
  })
  const project = repos.project.getById(chapter.projectId)
  return {
    chapter: {
      id: chapter.id,
      ord: chapter.ord,
      title: repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`,
      finalRevisionId: finalId,
      coveredUntilSeq: chapter.coveredUntilSeq ?? project?.seqHead ?? 0
    },
    beats,
    characters: repos.character.list(chapter.projectId).map((character) => ({
      id: character.id,
      name: character.name,
      cardJson: character.cardJson
    })),
    facts: repos.world
      .listByProject(chapter.projectId)
      .filter((fact) => fact.truth === 'objective')
      .map((fact) => ({
        id: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        truth: fact.truth,
        validToSeq: fact.validToSeq
      })),
    beliefs: repos.belief
      .listByProject(chapter.projectId)
      .filter((belief) => belief.status === 'active')
      .map((belief) => ({ id: belief.id, characterId: belief.characterId, text: belief.beliefText })),
    edges: repos.relationship
      .listActiveAll()
      .map((edge) => ({ id: edge.id, fromId: edge.fromId, toId: edge.toId, axis: edge.axis, value: edge.value }))
  }
}

export interface RawProposalItem {
  kind: ProposalKind
  characterId: string | null
  text: string
  payload: Record<string, unknown>
  sourceBeatId: string | null
  evidenceQuote: string | null
  importance: number
  pinned: boolean
}

export type DropReason = EvidenceReason | 'missing_character' | 'world_fact_payload' | 'empty_text' | 'duplicate' | 'unknown_character'

export interface SubmitProposalsInput {
  projectId: string
  jobId: string
  chapterId: string
  revisionId: string
  actor: string
  items: readonly RawProposalItem[]
}

export interface SubmitProposalsResult {
  inserted: MemoryProposalItemRecord[]
  dropped: Array<{ index: number; reason: DropReason; quote: string | null }>
  downgraded: Array<{ index: number; reason: string }>
  mismatches: number
}

/**
 * 共享的「提案落库」入口：T37 与运行时 JSON 回退都走这里。
 * 先证据后分类：没有证据的条目连分类都不做，直接丢弃并记审计。
 */
export function submitProposalItems(repos: Repos, input: SubmitProposalsInput): SubmitProposalsResult {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter || chapter.projectId !== input.projectId) {
    throw new AppError('invalid_args', 'chapter not in project')
  }
  if (chapter.status !== 'finalized' || chapter.finalRevisionId === null) {
    throw new AppError('invalid_args', 'only finalized chapters feed memory', { status: chapter.status })
  }
  if (input.revisionId !== chapter.finalRevisionId) {
    throw new AppError('stale_revision', 'expected revision is not the final revision')
  }
  if (input.items.length === 0) throw new AppError('invalid_args', 'proposal has no items')
  if (input.items.length > 80) throw new AppError('invalid_args', 'proposal too large')

  const members = repos.revision.manifest(chapter.finalRevisionId)
  const bodies = new Map<string, string>()
  const speakerTypeById = new Map<string, 'character' | 'narrator'>()
  for (const row of members) {
    bodies.set(row.beatId, row.body)
    speakerTypeById.set(row.beatId, row.speakerType)
  }
  const characters = new Set(repos.character.list(input.projectId).map((character) => character.id))

  const result: SubmitProposalsResult = { inserted: [], dropped: [], downgraded: [], mismatches: 0 }
  const seen = new Set<string>()

  input.items.forEach((item, index) => {
    const evidence = checkEvidence({ beatId: item.sourceBeatId, quote: item.evidenceQuote, bodies })
    if (!evidence.ok) {
      result.mismatches += 1
      result.dropped.push({ index, reason: (evidence.reason ?? 'quote_not_substring') as DropReason, quote: evidence.quote })
      repos.memoryAudit.insert({
        projectId: input.projectId,
        jobId: input.jobId,
        action: 'evidence_mismatch',
        actor: input.actor,
        entityType: 'proposal',
        entityId: input.jobId,
        detail: {
          index,
          reason: evidence.reason,
          quote: evidence.quote,
          beatId: item.sourceBeatId,
          kind: item.kind,
          chapterId: input.chapterId
        }
      })
      return
    }

    const text = item.text.trim()
    if (text.length === 0) {
      result.dropped.push({ index, reason: 'empty_text', quote: evidence.quote })
      return
    }
    if (item.characterId !== null && !characters.has(item.characterId)) {
      result.dropped.push({ index, reason: 'unknown_character', quote: evidence.quote })
      return
    }

    const classification = classifyProposal({
      kind: item.kind,
      characterId: item.characterId,
      payload: item.payload,
      speakerType: speakerTypeById.get(item.sourceBeatId ?? '') ?? 'character'
    })
    if (!classification.ok) {
      result.dropped.push({ index, reason: classification.drop ?? 'empty_text', quote: evidence.quote })
      return
    }

    const dedupe = `${classification.kind}|${item.characterId ?? '-'}|${text}`
    if (seen.has(dedupe)) {
      result.dropped.push({ index, reason: 'duplicate', quote: evidence.quote })
      return
    }
    seen.add(dedupe)

    const record = repos.memoryProposal.insert({
      projectId: input.projectId,
      jobId: input.jobId,
      kind: classification.kind,
      characterId: item.characterId,
      text,
      payloadJson: JSON.stringify({
        ...classification.payload,
        ...(classification.downgrades.length > 0 ? { downgraded: classification.downgrades } : {}),
        ...(classification.truth === null ? {} : { truth: classification.truth })
      }),
      sourceChapterId: input.chapterId,
      sourceRevisionId: input.revisionId,
      sourceBeatId: item.sourceBeatId,
      evidenceQuote: evidence.quote,
      importance: Math.min(1, Math.max(0, item.importance)),
      pinned: item.pinned ? 1 : 0
    })
    result.inserted.push(record)
    for (const reason of classification.downgrades) result.downgraded.push({ index, reason })
    repos.memoryAudit.insert({
      projectId: input.projectId,
      jobId: input.jobId,
      action: 'extract',
      actor: input.actor,
      entityType: 'proposal',
      entityId: record.id,
      detail: {
        kind: classification.kind,
        characterId: item.characterId,
        beatId: item.sourceBeatId,
        quote: evidence.quote,
        downgrades: classification.downgrades
      }
    })
  })

  return result
}

/** 模型最终 JSON 回退：`{proposals:[...]}`（MEMORY_ANSWER_CONTRACT）。 */
export function parseProposalJson(payload: unknown): RawProposalItem[] | null {
  if (payload === null || typeof payload !== 'object') return null
  const proposals = (payload as { proposals?: unknown }).proposals
  if (!Array.isArray(proposals)) return null
  const out: RawProposalItem[] = []
  for (const raw of proposals) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const kind = item.kind
    if (
      kind !== 'experience' &&
      kind !== 'fact' &&
      kind !== 'relationship' &&
      kind !== 'cognition' &&
      kind !== 'world_fact' &&
      kind !== 'belief'
    ) {
      continue
    }
    const text = typeof item.text === 'string' ? item.text : ''
    if (text.trim().length === 0) continue
    out.push({
      kind,
      characterId: typeof item.character_id === 'string' ? item.character_id : null,
      text,
      payload:
        item.payload !== null && typeof item.payload === 'object' && !Array.isArray(item.payload)
          ? (item.payload as Record<string, unknown>)
          : {},
      sourceBeatId: typeof item.source_beat_id === 'string' ? item.source_beat_id : typeof item.beat_id === 'string' ? item.beat_id : null,
      evidenceQuote: typeof item.evidence_quote === 'string' ? item.evidence_quote : typeof item.quote === 'string' ? item.quote : null,
      importance: typeof item.importance === 'number' ? item.importance : 0.5,
      pinned: item.pinned === true
    })
  }
  return out
}
