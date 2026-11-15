import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { MemoryEntryRecord } from '../db/repos/memory'
import type { ProposalKind } from '../db/repos/memory-proposal'
import { withTransaction } from '../db/tx'
import { classifyProposal } from './classify'
import type { Embedder } from './embed/types'
import { vectorToArray } from './embed/types'

/**
 * apply 执行器（PHASE-09 H3 / DEV-PLAN §10.3）。
 *
 * 单一写入者：记忆库、世界状态、信念、关系边、向量与审计**只**由这里写。
 * T39（memory.apply）与服务层都调用同一个函数，不存在「两条写路径」。
 *
 * 顺序不可换：
 *   1. 校验令牌 + 幂等键（重放直接返回首次结果，标 duplicate）
 *   2. 先算 embedding（worker）——失败则整个 apply 失败，不写任何东西
 *   3. 单事务：memory_entry + memory_vec + memory_fts + world_fact +
 *      character_belief + relationship_edge + 审计 + 决策 + 令牌消费
 * 任何一步失败 → 全部回滚；不会出现「有文本无向量」或「令牌已用但没写」。
 */

export interface ApplyDecision {
  itemId: string
  decision: 'accept' | 'edit' | 'reject'
  editedText?: string | null
}

export interface ApplyInput {
  projectId: string
  /** 提案 job（memory_proposal_item.job_id，T39 的 proposal_id）。 */
  proposalJobId: string
  /** memory.apply job id：G7 令牌的 job 绑定与审计都用它。 */
  applyJobId: string
  actor: string
  decisions: readonly ApplyDecision[]
  /** G7 令牌哈希；传入则在同一事务里消费，失败整体回滚。 */
  gateTokenHash?: string | null
  now?: string
}

export interface ApplyResult {
  duplicate: boolean
  applyJobId: string
  appliedCount: number
  rejectedCount: number
  superseded: string[]
  inactive: string[]
  memoryIds: string[]
  factIds: string[]
  beliefIds: string[]
  edgeIds: string[]
}

interface PreparedItem {
  itemId: string
  kind: ProposalKind
  characterId: string | null
  text: string
  payload: Record<string, unknown>
  sourceBeatId: string | null
  sourceChapterId: string
  sourceRevisionId: string
  importance: number
  pinned: number
  learnedSeq: number
  decision: 'accept' | 'edit'
}

function parseJson(text: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fallback
  } catch {
    return fallback
  }
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function proposalJobKey(projectId: string, proposalJobId: string): string {
  return `memory.apply:${projectId}:${proposalJobId}`
}

export async function applyMemoryProposals(
  db: Db,
  repos: Repos,
  input: ApplyInput,
  embedder: Embedder
): Promise<ApplyResult> {
  const proposalJob = repos.job.get(input.proposalJobId)
  if (!proposalJob) throw new AppError('invalid_args', '提案任务不存在', { jobId: input.proposalJobId })
  if (proposalJob.projectId !== input.projectId) throw new AppError('invalid_args', '提案不属于本项目')
  if (proposalJob.type !== 'memory.extract') {
    throw new AppError('invalid_args', '只能应用记忆抽取提案', { type: proposalJob.type })
  }

  // 1) 重放：同一提案 job 已经应用过 → 返回首次结果，不双写。
  const previous = proposalJob.resultJson === null ? {} : parseJson(proposalJob.resultJson)
  if (previous.applied === true) {
    // 重放也算一次「使用」：令牌在这里消费，避免留下可复用的窗口。
    if (input.gateTokenHash !== undefined && input.gateTokenHash !== null) {
      repos.gate.consumeToken(input.gateTokenHash)
    }
    const stored = (previous.apply_result ?? {}) as Partial<ApplyResult>
    return {
      duplicate: true,
      applyJobId: typeof stored.applyJobId === 'string' ? stored.applyJobId : input.applyJobId,
      appliedCount: numberOr(stored.appliedCount, 0) ?? 0,
      rejectedCount: numberOr(stored.rejectedCount, 0) ?? 0,
      superseded: Array.isArray(stored.superseded) ? stored.superseded.filter((id): id is string => typeof id === 'string') : [],
      inactive: Array.isArray(stored.inactive) ? stored.inactive.filter((id): id is string => typeof id === 'string') : [],
      memoryIds: Array.isArray(stored.memoryIds) ? stored.memoryIds.filter((id): id is string => typeof id === 'string') : [],
      factIds: Array.isArray(stored.factIds) ? stored.factIds.filter((id): id is string => typeof id === 'string') : [],
      beliefIds: Array.isArray(stored.beliefIds) ? stored.beliefIds.filter((id): id is string => typeof id === 'string') : [],
      edgeIds: Array.isArray(stored.edgeIds) ? stored.edgeIds.filter((id): id is string => typeof id === 'string') : []
    }
  }

  const items = repos.memoryProposal.listByJob(input.projectId, input.proposalJobId)
  if (items.length === 0) throw new AppError('invalid_args', '提案没有任何条目')
  const byId = new Map(items.map((item) => [item.id, item]))
  if (input.decisions.length === 0) throw new AppError('invalid_args', '没有可应用的条目')

  const project = repos.project.getById(input.projectId)
  if (!project) throw new AppError('project_not_found', 'project row missing')

  const prepared: PreparedItem[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  for (const decision of input.decisions) {
    const item = byId.get(decision.itemId)
    if (!item) throw new AppError('invalid_args', `提案条目 ${decision.itemId} 不存在`)
    if (seen.has(item.id)) throw new AppError('invalid_args', `条目 ${item.id} 重复决定`)
    seen.add(item.id)
    if (item.decision !== 'pending' && item.decision !== decision.decision) {
      throw new AppError('stale_revision', `条目 ${item.id} 已决定（${item.decision}）`)
    }
    if (decision.decision === 'reject') {
      rejected.push(item.id)
      continue
    }
    const edited = decision.editedText ?? item.editedText ?? null
    const text = (decision.decision === 'edit' ? edited : item.text)?.trim() ?? ''
    if (text.length === 0) throw new AppError('invalid_args', `条目 ${item.id} 文本为空`)
    if (decision.decision === 'edit' && (edited ?? '').trim().length === 0) {
      throw new AppError('invalid_args', `条目 ${item.id} 编辑后为空`)
    }

    const payload = parseJson(item.payloadJson)
    const beat = item.sourceBeatId ? repos.beat.get(item.sourceBeatId) : null
    const classification = classifyProposal({
      kind: item.kind,
      characterId: item.characterId,
      payload,
      speakerType: beat?.speakerType === 'narrator' ? 'narrator' : 'character'
    })
    if (!classification.ok) {
      throw new AppError('invalid_args', `条目 ${item.id} 不合法：${classification.drop ?? 'unknown'}`)
    }

    prepared.push({
      itemId: item.id,
      kind: classification.kind,
      characterId: item.characterId,
      text,
      payload: classification.payload,
      sourceBeatId: item.sourceBeatId,
      sourceChapterId: item.sourceChapterId,
      sourceRevisionId: item.sourceRevisionId,
      importance: item.importance,
      pinned: item.pinned,
      learnedSeq: beat?.seq ?? project.seqHead,
      decision: decision.decision
    })
  }

  if (prepared.length === 0 && rejected.length === 0) throw new AppError('invalid_args', '没有可应用的条目')

  // 2) 先算 embedding：只给「记忆条目」算，事实/信念/边不需要向量。
  const vectorItems = prepared.filter((item) => item.kind !== 'world_fact' && item.kind !== 'belief')
  const vectors = new Map<string, number[]>()
  if (vectorItems.length > 0) {
    const embedded = await embedder.embed(
      vectorItems.map((item) => item.text),
      'doc'
    )
    if (embedded.length !== vectorItems.length) {
      throw new AppError('vector_unavailable', '嵌入返回条数与请求不一致')
    }
    vectorItems.forEach((item, index) => {
      const vector = embedded[index]!
      if (vector.length !== embedder.dim) {
        throw new AppError('vector_unavailable', `嵌入维度 ${vector.length} 与 ${embedder.dim} 不一致`)
      }
      vectors.set(item.itemId, vectorToArray(vector))
    })
  }

  const at = input.now ?? new Date().toISOString()
  const result: ApplyResult = {
    duplicate: false,
    applyJobId: input.applyJobId,
    appliedCount: 0,
    rejectedCount: rejected.length,
    superseded: [],
    inactive: [],
    memoryIds: [],
    factIds: [],
    beliefIds: [],
    edgeIds: []
  }

  withTransaction(db, () => {
    // 3) 令牌在同一事务里消费：失败则整个 apply 回滚。
    if (input.gateTokenHash !== undefined && input.gateTokenHash !== null) {
      const consumed = repos.gate.consumeToken(input.gateTokenHash)
      if (!consumed) throw new AppError('gate_consumed', '该确认已使用')
    }

    for (const itemId of rejected) {
      repos.memoryProposal.decide(itemId, 'reject')
    }

    for (const item of prepared) {
      const vector = vectors.get(item.itemId)

      if (item.kind === 'world_fact') {
        const subject = stringOr(item.payload.subject)
        const predicate = stringOr(item.payload.predicate)
        const object = stringOr(item.payload.object)
        if (subject === null || predicate === null || object === null) {
          throw new AppError('invalid_args', `world_fact 条目 ${item.itemId} 缺三元组`)
        }
        const truth = item.payload.truth === 'objective' ? 'objective' : 'claim'
        const singleValue = numberOr(item.payload.single_value, 1) === 0 ? 0 : 1
        if (truth === 'objective' && singleValue === 1) {
          const current = repos.world.current(subject, predicate)
          // 同一三元组重复提案：不插第二行（单值唯一索引会拒绝），只记为已应用。
          if (current && current.object === object) {
            repos.memoryProposal.decide(item.itemId, item.decision === 'edit' ? 'edit' : 'accept')
            result.appliedCount += 1
            repos.memoryAudit.insert({
              projectId: input.projectId,
              jobId: input.applyJobId,
              action: 'apply',
              actor: input.actor,
              entityType: 'world_fact',
              entityId: current.id,
              detail: { deduplicated: true, subject, predicate, object, from: item.sourceBeatId }
            })
            continue
          }
          if (current !== null) {
            repos.world.closeValidity(current.id, item.learnedSeq)
            result.superseded.push(current.id)
            repos.memoryAudit.insert({
              projectId: input.projectId,
              jobId: input.applyJobId,
              action: 'supersede',
              actor: input.actor,
              entityType: 'world_fact',
              entityId: current.id,
              detail: { by: 'world_fact', subject, predicate, newObject: object, seq: item.learnedSeq }
            })
          }
        }
        const knownBy = Array.isArray(item.payload.known_by)
          ? item.payload.known_by.filter((value): value is string => typeof value === 'string')
          : []
        const fact = repos.world.insert({
          projectId: input.projectId,
          subject,
          predicate,
          object,
          singleValue,
          truth,
          visibility: item.payload.visibility === 'secret' ? 'secret' : 'public',
          knownByJson: JSON.stringify(knownBy),
          revealSeq: numberOr(item.payload.reveal_seq, null),
          validFromSeq: item.learnedSeq,
          sourceType: 'memory',
          sourceId: item.itemId
        })
        result.factIds.push(fact.id)
        repos.memoryAudit.insert({
          projectId: input.projectId,
          jobId: input.applyJobId,
          action: 'apply',
          actor: input.actor,
          entityType: 'world_fact',
          entityId: fact.id,
          detail: { truth, from: item.sourceBeatId, revision: item.sourceRevisionId }
        })
        repos.memoryProposal.decide(item.itemId, item.decision === 'edit' ? 'edit' : 'accept')
        result.appliedCount += 1
        continue
      }

      if (item.kind === 'belief') {
        if (item.characterId === null) throw new AppError('invalid_args', `belief 条目 ${item.itemId} 缺角色`)
        const factId = stringOr(item.payload.fact_id)
        const belief = repos.belief.insert({
          projectId: input.projectId,
          characterId: item.characterId,
          factId: factId !== null && repos.world.get(factId) !== null ? factId : null,
          beliefText: item.text,
          confidence: numberOr(item.payload.confidence, 0.6) ?? 0.6,
          learnedSeq: item.learnedSeq,
          sourceType: 'dialogue',
          sourceId: item.itemId
        })
        result.beliefIds.push(belief.id)
        repos.memoryAudit.insert({
          projectId: input.projectId,
          jobId: input.applyJobId,
          action: 'apply',
          actor: input.actor,
          entityType: 'belief',
          entityId: belief.id,
          detail: { characterId: item.characterId, from: item.sourceBeatId }
        })
        repos.memoryProposal.decide(item.itemId, item.decision === 'edit' ? 'edit' : 'accept')
        result.appliedCount += 1
        continue
      }

      if (item.characterId === null) throw new AppError('invalid_args', `${item.kind} 条目 ${item.itemId} 缺角色`)
      const memory = repos.memory.insert({
        projectId: input.projectId,
        characterId: item.characterId,
        kind: item.kind as Extract<ProposalKind, 'experience' | 'fact' | 'relationship' | 'cognition'>,
        text: item.text,
        learnedSeq: item.learnedSeq,
        sourceChapterId: item.sourceChapterId,
        sourceRevisionId: item.sourceRevisionId,
        sourceBeatId: item.sourceBeatId,
        importance: item.importance,
        pinned: item.pinned,
        embeddingModel: embedder.model,
        createdAt: at
      })
      result.memoryIds.push(memory.id)

      // 向量与文本同事务：不会出现「有文本无向量」。
      if (vector === undefined) throw new AppError('vector_unavailable', `条目 ${item.itemId} 缺向量`)
      repos.memoryIndex.writeVector(memory.id, vector)
      repos.memoryIndex.writeBigrams(memory.id, item.characterId, item.text)

      const supersedesId = stringOr(item.payload.supersedes_id)
      if (supersedesId !== null) {
        const previousEntry = repos.memory.get(supersedesId)
        if (previousEntry && previousEntry.characterId === item.characterId && previousEntry.status === 'active') {
          repos.memory.supersede(previousEntry.id, memory.id)
          result.superseded.push(previousEntry.id)
          repos.memoryAudit.insert({
            projectId: input.projectId,
            jobId: input.applyJobId,
            action: 'supersede',
            actor: input.actor,
            entityType: 'memory_entry',
            entityId: previousEntry.id,
            detail: { by: memory.id, text: item.text }
          })
        }
      }

      if (item.kind === 'relationship') {
        const toId = stringOr(item.payload.to_id)
        const axisRaw = stringOr(item.payload.axis)
        const value = numberOr(item.payload.value, null)
        if (toId !== null && axisRaw !== null && value !== null) {
          const axis = axisRaw === 'intimacy' || axisRaw === 'tension' ? axisRaw : 'trust'
          const current = repos.relationship.current(item.characterId, toId, axis)
          if (current) {
            repos.relationship.closeValidity(current.id, item.learnedSeq)
            result.superseded.push(current.id)
          }
          const edge = repos.relationship.insert({
            projectId: input.projectId,
            fromId: item.characterId,
            toId,
            axis,
            value,
            sinceSeq: item.learnedSeq,
            sourceType: 'memory',
            sourceId: memory.id,
            supersedesId: current?.id ?? null
          })
          result.edgeIds.push(edge.id)
          repos.memoryAudit.insert({
            projectId: input.projectId,
            jobId: input.applyJobId,
            action: 'apply',
            actor: input.actor,
            entityType: 'relationship',
            entityId: edge.id,
            detail: { from: item.characterId, to: toId, axis, value, previous: current?.id ?? null }
          })
        }
      }

      repos.memoryAudit.insert({
        projectId: input.projectId,
        jobId: input.applyJobId,
        action: 'apply',
        actor: input.actor,
        entityType: 'memory_entry',
        entityId: memory.id,
        detail: {
          kind: item.kind,
          characterId: item.characterId,
          from: item.sourceBeatId,
          chapter: item.sourceChapterId,
          revision: item.sourceRevisionId,
          learnedSeq: item.learnedSeq,
          importance: item.importance,
          pinned: item.pinned,
          embeddingModel: embedder.model,
          decision: item.decision
        }
      })

      repos.memoryProposal.decide(item.itemId, item.decision === 'edit' ? 'edit' : 'accept')
      result.appliedCount += 1
    }

    // 提案 job 记下「已应用」，重放据此返回 duplicate。
    repos.job.setStatus(proposalJob.id, 'succeeded', {
      resultJson: JSON.stringify({
        ...previous,
        applied: true,
        apply_job_id: input.applyJobId,
        apply_result: result
      })
    })
    repos.job.setStatus(input.applyJobId, 'succeeded', {
      resultJson: JSON.stringify({
        proposal_job_id: input.proposalJobId,
        applied_count: result.appliedCount,
        rejected_count: result.rejectedCount,
        memory_ids: result.memoryIds,
        fact_ids: result.factIds,
        belief_ids: result.beliefIds,
        edge_ids: result.edgeIds
      })
    })
  })

  return result
}

/** 标记错误：软失效，不物理删除（PRD §6.4 / PHASE-09 H4）。 */
export function invalidateMemoryEntry(
  repos: Repos,
  input: { projectId: string; entryId: string; actor: string; reason: string; jobId?: string | null }
): MemoryEntryRecord {
  const entry = repos.memory.get(input.entryId)
  if (!entry || entry.projectId !== input.projectId) {
    throw new AppError('invalid_args', '记忆条目不存在', { entryId: input.entryId })
  }
  if (entry.status === 'inactive') return entry
  repos.memory.markInvalid(entry.id, 'inactive')
  repos.memoryAudit.insert({
    projectId: input.projectId,
    jobId: input.jobId ?? null,
    action: 'invalidate',
    actor: input.actor,
    entityType: 'memory_entry',
    entityId: entry.id,
    detail: { reason: input.reason, previous: entry.status, text: entry.text }
  })
  return repos.memory.get(entry.id)!
}

/** 审计链：单条记忆的全部动作（来源、应用、取代、失效）。 */
export function memoryAuditTrail(repos: Repos, entryId: string): Array<{ id: string; action: string; actor: string; createdAt: string; detail: Record<string, unknown> }> {
  return repos.memoryAudit.listByEntity(entryId).map((record) => ({
    id: record.id,
    action: record.action,
    actor: record.actor,
    createdAt: record.createdAt,
    detail: parseJson(record.detailJson)
  }))
}
