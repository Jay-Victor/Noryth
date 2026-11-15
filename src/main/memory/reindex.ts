import { AppError } from '../../shared/domain/app-error'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { JobRecord } from '../db/repos/job'
import { withTransaction } from '../db/tx'
import type { Embedder } from './embed/types'
import { vectorToArray } from './embed/types'

/**
 * 索引重建（PHASE-14 M1-20 / DEV-PLAN §10.5）。
 *
 * 背景：`memory_entry.embedding_model` 记录每条记忆写向量时用的模型；检索的向量通道
 * 只查当前模型（`memory-index.searchVector` 的 `embeddingModel` 过滤）。换模型后旧行
 * 仍能按关键词召回，但向量通道会漏——所以需要分批重算。
 *
 * 规则（PHASE-14 §5.3）：
 *   - 只重算 `status='active'` 且 `embedding_model != 当前模型` 的条目；
 *   - 32 条/批，**每批一个事务**（删旧向量 + 插新向量 + 改模型名同成败）；
 *   - 中途被杀：已提交的批次保留，重启继续；未提交的批次整批回滚，不会留下半条向量；
 *   - author_confirm 令牌在**完成的那个事务**里消费；失败可重试；
 *   - 不阻塞正文：只读记忆索引，不碰 beat / revision。
 */

export const REINDEX_BATCH_SIZE = 32

export interface ReindexRequest {
  projectId: string
  jobId: string
  actor: string
  /** author_confirm 令牌哈希；给出则在收尾事务里消费。 */
  gateTokenHash: string | null
  batchSize?: number
}

export interface ReindexOutcome {
  duplicate: boolean
  jobId: string
  model: string
  total: number
  rebuiltCount: number
  remaining: number
}

export interface ReindexProgress {
  total: number
  rebuilt: number
  done: boolean
  model: string
}

/** 幂等键按「第几次重建」编号：换回旧模型也要能再跑一次。 */
export function reindexJobKey(projectId: string, generation: number): string {
  return `index.rebuild:${projectId}:${generation}`
}

export function parseReindexProgress(job: JobRecord | null): ReindexProgress | null {
  if (!job || job.resultJson === null) return null
  try {
    const parsed = JSON.parse(job.resultJson) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    if (typeof record.total !== 'number') return null
    return {
      total: record.total,
      rebuilt: typeof record.rebuilt === 'number' ? record.rebuilt : 0,
      done: record.done === true,
      model: typeof record.model === 'string' ? record.model : ''
    }
  } catch {
    return null
  }
}

/**
 * 续跑点：最近一个 `index.rebuild` job。
 * 与 `status` 无关——失败/中断的 job 也从「剩余待重算」继续，不从头再来。
 */
export function latestReindexJob(repos: Repos, projectId: string): JobRecord | null {
  const recent = repos.job.listRecent(projectId, 40).filter((job) => job.type === 'index.rebuild')
  return recent[0] ?? null
}

export async function reindexProject(
  db: Db,
  repos: Repos,
  input: ReindexRequest,
  embedder: Embedder
): Promise<ReindexOutcome> {
  const project = repos.project.getById(input.projectId)
  if (!project) throw new AppError('project_not_found', 'project row missing', { projectId: input.projectId })

  const job = repos.job.get(input.jobId)
  if (!job || job.projectId !== input.projectId) {
    throw new AppError('invalid_args', '索引重建任务不存在', { jobId: input.jobId })
  }
  if (job.type !== 'index.rebuild') {
    throw new AppError('invalid_args', '任务类型不是 index.rebuild', { type: job.type })
  }

  const previous = parseReindexProgress(job)
  if (previous?.done === true) {
    if (input.gateTokenHash !== null) repos.gate.consumeToken(input.gateTokenHash)
    const remaining = repos.memory.countByModelMismatch(input.projectId, embedder.model)
    return {
      duplicate: true,
      jobId: job.id,
      model: embedder.model,
      total: previous.total,
      rebuiltCount: previous.rebuilt,
      remaining
    }
  }

  const batchSize = Math.max(1, Math.min(REINDEX_BATCH_SIZE, Math.trunc(input.batchSize ?? REINDEX_BATCH_SIZE)))
  const total = previous?.total ?? repos.memory.countByModelMismatch(input.projectId, embedder.model)
  let rebuilt = previous?.rebuilt ?? 0

  repos.job.setStatus(job.id, 'running')

  while (true) {
    const batch = repos.memory.listByModelMismatch(input.projectId, embedder.model, batchSize)
    if (batch.length === 0) break

    const vectors = await embedder.embed(
      batch.map((entry) => entry.text),
      'doc'
    )
    if (vectors.length !== batch.length) {
      throw new AppError('vector_unavailable', '嵌入返回条数与请求不一致', {
        expected: batch.length,
        actual: vectors.length
      })
    }
    for (const vector of vectors) {
      if (vector.length !== embedder.dim) {
        throw new AppError('vector_unavailable', `嵌入维度 ${vector.length} 与 ${embedder.dim} 不一致`)
      }
    }

    // 每批一个事务：删旧向量 + 插新向量 + 改模型名同成败。
    withTransaction(db, () => {
      batch.forEach((entry, index) => {
        repos.memoryIndex.replaceVector(entry.id, vectorToArray(vectors[index]!))
        repos.memory.setEmbeddingModel(entry.id, embedder.model)
      })
      rebuilt += batch.length
      repos.job.setStatus(job.id, 'running', {
        resultJson: JSON.stringify({
          total,
          rebuilt,
          done: false,
          model: embedder.model
        } satisfies ReindexProgress)
      })
    })
  }

  const remaining = repos.memory.countByModelMismatch(input.projectId, embedder.model)

  // 收尾事务：消费令牌 + 标记完成。中途崩溃会停在 done=false，重试从这里继续。
  withTransaction(db, () => {
    if (input.gateTokenHash !== null) {
      const consumed = repos.gate.consumeToken(input.gateTokenHash)
      if (!consumed) throw new AppError('gate_consumed', '该确认已使用')
    }
    repos.job.setStatus(job.id, 'succeeded', {
      resultJson: JSON.stringify({
        total,
        rebuilt,
        done: true,
        remaining,
        model: embedder.model
      })
    })
    repos.memoryAudit.insert({
      projectId: input.projectId,
      jobId: job.id,
      action: 'rebuild',
      actor: input.actor,
      entityType: 'memory_entry',
      entityId: job.id,
      detail: { scope: 'index', model: embedder.model, rebuilt, total, remaining }
    })
  })

  return {
    duplicate: false,
    jobId: job.id,
    model: embedder.model,
    total,
    rebuiltCount: rebuilt,
    remaining
  }
}
