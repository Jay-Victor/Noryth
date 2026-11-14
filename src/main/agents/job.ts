import { z } from 'zod'
import { AppError } from '../../shared/domain/app-error'
import { CapabilitiesSchema } from '../../shared/schema/model'
import type { Repos } from '../db/repos'
import type { JobRecord } from '../db/repos/job'
import type { RegistrySnapshot } from '../tools/registry'
import type { AgentInstanceKey } from '../tools/types'
import { sha256Hex } from '../crypto'
import type { BindingSnapshot, CapabilitiesLookup } from '../model/bindings'
import { freezeBindings } from '../model/bindings'
import { PROMPT_VERSION } from './prompts'

/**
 * 单拍 job（DEV-PLAN §7.1 / §7.7 / PHASE-04 §5.5）。
 *
 * job 创建时冻结绑定与工具集快照，写 `job.payload_json`；job 内所有拍复用，
 * 运行中改绑定只影响下一个 job。
 */

export const ResolvedBindingSchema = z.strictObject({
  agentKey: z.string(),
  provider: z.string(),
  model: z.string(),
  params: z.record(z.string(), z.unknown()),
  version: z.number().int().nonnegative(),
  source: z.enum(['instance', 'agent', 'project', 'preset']),
  capabilities: CapabilitiesSchema.optional()
})

export const BindingSnapshotSchema = z.strictObject({
  version: z.literal(1),
  at: z.string(),
  bindings: z.record(z.string(), ResolvedBindingSchema),
  hash: z.string().min(1)
})

export const TurnJobPayloadSchema = z.strictObject({
  chapter_id: z.string().min(1),
  beat_id: z.string().min(1),
  actor: z.string().min(1),
  mode: z.enum(['interactive', 'auto', 'batch']),
  bindings: BindingSnapshotSchema,
  binding_hash: z.string().min(1),
  toolset_version: z.string().min(1),
  prompt_version: z.string().min(1)
})
export type TurnJobPayload = z.infer<typeof TurnJobPayloadSchema>

export function beatJobIdempotencyKey(input: {
  projectId: string
  chapterId: string
  beatId: string
  epoch: number
  expectedRevision: string | null
  actor: string
  toolsetVersion: string
  bindingHash: string
}): string {
  return sha256Hex(
    [
      input.projectId,
      input.chapterId,
      input.beatId,
      String(input.epoch),
      input.expectedRevision ?? '',
      input.actor,
      input.toolsetVersion,
      input.bindingHash
    ].join('|')
  )
}

export interface CreateTurnJobInput {
  chapterId: string
  beatId: string
  actor: AgentInstanceKey
  mode: 'interactive' | 'auto' | 'batch'
  at: string
  /** 测试注入固定 id。 */
  id?: string
}

export interface CreatedTurnJob {
  job: JobRecord
  payload: TurnJobPayload
}

function actorForBeat(speakerType: string, speakerId: string): AgentInstanceKey {
  return speakerType === 'character' ? `character:${speakerId}` : 'narrator'
}

export interface CreateTurnJobOptions {
  /** 主进程传入 settings.providers 的探测结果；缺省用预设表。 */
  capabilitiesLookup?: CapabilitiesLookup
}

export function createTurnJob(
  repos: Repos,
  registry: RegistrySnapshot,
  input: CreateTurnJobInput,
  options: CreateTurnJobOptions = {}
): CreatedTurnJob {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')

  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter) throw new AppError('project_not_found', 'chapter missing', { chapterId: input.chapterId })

  const beat = repos.beat.get(input.beatId)
  if (!beat) throw new AppError('project_not_found', 'beat missing', { beatId: input.beatId })
  if (beat.speakerType === 'character' && input.actor !== `character:${beat.speakerId}`) {
    throw new AppError('invalid_args', 'job actor 与分镜 speaker 不一致', {
      actor: input.actor,
      speakerId: beat.speakerId
    })
  }

  const actor = actorForBeat(beat.speakerType, beat.speakerId)
  if (actor !== input.actor) {
    throw new AppError('invalid_args', 'job actor 与分镜 speaker 不一致', { actor: input.actor, expected: actor })
  }

  const bindings = freezeBindings(repos, project, [input.actor], input.at, options.capabilitiesLookup)
  const payload: TurnJobPayload = {
    chapter_id: input.chapterId,
    beat_id: input.beatId,
    actor: input.actor,
    mode: input.mode,
    bindings,
    binding_hash: bindings.hash,
    toolset_version: registry.version,
    prompt_version: PROMPT_VERSION
  }

  const idempotencyKey = beatJobIdempotencyKey({
    projectId: project.id,
    chapterId: input.chapterId,
    beatId: input.beatId,
    epoch: project.writeEpoch,
    expectedRevision: chapter.currentRevisionId,
    actor: input.actor,
    toolsetVersion: registry.version,
    bindingHash: bindings.hash
  })

  const existing = repos.job.findByIdempotency(project.id, idempotencyKey)
  if (existing) {
    return { job: existing, payload: parseTurnJobPayload(existing) }
  }

  const job = repos.job.insert({
    ...(input.id === undefined ? {} : { id: input.id }),
    projectId: project.id,
    type: 'beat.generate',
    status: 'queued',
    expectedRevision: chapter.currentRevisionId,
    epoch: project.writeEpoch,
    idempotencyKey,
    payloadJson: JSON.stringify(payload),
    createdAt: input.at,
    updatedAt: input.at
  })

  return { job, payload }
}

export function parseTurnJobPayload(job: JobRecord): TurnJobPayload {
  let raw: unknown
  try {
    raw = JSON.parse(job.payloadJson)
  } catch {
    throw new AppError('internal_error', 'job.payload_json 不是合法 JSON', { jobId: job.id })
  }
  const parsed = TurnJobPayloadSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('setup_incomplete', 'job 缺少冻结的绑定或工具集快照', {
      jobId: job.id,
      issues: parsed.error.issues.map((issue) => issue.path.join('.'))
    })
  }
  return parsed.data
}

/** 快照自检：job 内不允许回数据库重解析绑定。 */
export function assertSnapshotConsistent(snapshot: BindingSnapshot): void {
  for (const [key, binding] of Object.entries(snapshot.bindings)) {
    if (binding.agentKey !== key) {
      throw new AppError('internal_error', '绑定快照键不一致', { key, agentKey: binding.agentKey })
    }
  }
}
