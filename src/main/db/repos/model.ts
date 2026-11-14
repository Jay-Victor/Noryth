import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type { ModelBindingAuditTable, ModelBindingTable, TurnMetricTable } from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type BindingAgentKey = 'project' | string

export interface ModelBindingRecord {
  id: string
  projectId: string
  agentKey: string
  provider: string
  model: string
  paramsJson: string
  version: number
  updatedAt: string
}

export interface ModelBindingInput {
  projectId: string
  agentKey: string
  provider: string
  model: string
  paramsJson?: string
}

export interface ModelBindingAuditRecord {
  id: string
  projectId: string
  agentKey: string
  oldJson: string | null
  newJson: string
  actor: string
  createdAt: string
}

export interface TurnMetricInput {
  turnId: string
  projectId: string
  jobId: string
  beatId: string | null
  agentKey: string
  provider: string
  model: string
  bindingVersion: number
  tokensIn: number | null
  tokensOut: number | null
  costCny: number | null
  latencyMs: number | null
  firstTokenMs: number | null
  contextJson: string
  degradedJson?: string
  createdAt?: string
}

export interface TurnMetricRecord extends TurnMetricInput {
  degradedJson: string
  createdAt: string
}

type BindingRow = Selectable<ModelBindingTable>
type BindingAuditRow = Selectable<ModelBindingAuditTable>
type TurnMetricRow = Selectable<TurnMetricTable>

function mapBinding(row: BindingRow): ModelBindingRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    agentKey: row.agent_key,
    provider: row.provider,
    model: row.model,
    paramsJson: row.params_json,
    version: row.version,
    updatedAt: row.updated_at
  }
}

function mapAudit(row: BindingAuditRow): ModelBindingAuditRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    agentKey: row.agent_key,
    oldJson: row.old_json,
    newJson: row.new_json,
    actor: row.actor,
    createdAt: row.created_at
  }
}

function mapMetric(row: TurnMetricRow): TurnMetricRecord {
  return {
    turnId: row.turn_id,
    projectId: row.project_id,
    jobId: row.job_id,
    beatId: row.beat_id,
    agentKey: row.agent_key,
    provider: row.provider,
    model: row.model,
    bindingVersion: row.binding_version,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costCny: row.cost_cny,
    latencyMs: row.latency_ms,
    firstTokenMs: row.first_token_ms,
    contextJson: row.context_json,
    degradedJson: row.degraded_json,
    createdAt: row.created_at
  }
}

/**
 * 逐 Agent 绑定（DEV-PLAN §7.7）。
 * `agent_key` 允许 `project` / 六个 Agent / `character:<id>`；解析与继承在
 * `model/bindings.ts` 做，repo 只负责存取与审计。
 */
export class ModelBindingRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  list(projectId: string): ModelBindingRecord[] {
    const rows = allRows<BindingRow>(
      this.runner,
      this.runner.db.selectFrom('model_binding').selectAll().where('project_id', '=', projectId).orderBy('agent_key')
    )
    return rows.map(mapBinding)
  }

  get(projectId: string, agentKey: string): ModelBindingRecord | null {
    const row = firstRow<BindingRow>(
      this.runner,
      this.runner.db
        .selectFrom('model_binding')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('agent_key', '=', agentKey)
    )
    return row ? mapBinding(row) : null
  }

  /** 同 (project, agent) 只保留一行；版本号单调递增，写审计旧/新。 */
  upsert(input: ModelBindingInput, actor: string): ModelBindingRecord {
    const at = this.now()
    const previous = this.get(input.projectId, input.agentKey)
    const paramsJson = input.paramsJson ?? previous?.paramsJson ?? '{}'

    if (previous) {
      runStatement(
        this.runner,
        this.runner.db
          .updateTable('model_binding')
          .set({
            provider: input.provider,
            model: input.model,
            params_json: paramsJson,
            version: previous.version + 1,
            updated_at: at
          })
          .where('id', '=', previous.id)
      )
    } else {
      const values: Insertable<ModelBindingTable> = {
        id: newId('mb'),
        project_id: input.projectId,
        agent_key: input.agentKey,
        provider: input.provider,
        model: input.model,
        params_json: paramsJson,
        version: 1,
        updated_at: at
      }
      runStatement(this.runner, this.runner.db.insertInto('model_binding').values(values))
    }

    const next = this.get(input.projectId, input.agentKey)!
    this.recordAudit({
      projectId: input.projectId,
      agentKey: input.agentKey,
      oldJson: previous ? JSON.stringify(previous) : null,
      newJson: JSON.stringify(next),
      actor,
      createdAt: at
    })
    return next
  }

  recordAudit(input: {
    projectId: string
    agentKey: string
    oldJson: string | null
    newJson: string
    actor: string
    createdAt?: string
  }): ModelBindingAuditRecord {
    const id = newId('mba')
    runStatement(
      this.runner,
      this.runner.db.insertInto('model_binding_audit').values({
        id,
        project_id: input.projectId,
        agent_key: input.agentKey,
        old_json: input.oldJson,
        new_json: input.newJson,
        actor: input.actor,
        created_at: input.createdAt ?? this.now()
      })
    )
    const row = firstRow<BindingAuditRow>(
      this.runner,
      this.runner.db.selectFrom('model_binding_audit').selectAll().where('id', '=', id)
    )!
    return mapAudit(row)
  }

  listAudit(projectId: string): ModelBindingAuditRecord[] {
    const rows = allRows<BindingAuditRow>(
      this.runner,
      this.runner.db
        .selectFrom('model_binding_audit')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('created_at')
    )
    return rows.map(mapAudit)
  }
}

/** 每拍一行，供成本归因与上下文回放（DEV-PLAN §7.9 / §16.4）。 */
export class TurnMetricRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: TurnMetricInput): TurnMetricRecord {
    const values: Insertable<TurnMetricTable> = {
      turn_id: input.turnId,
      project_id: input.projectId,
      job_id: input.jobId,
      beat_id: input.beatId,
      agent_key: input.agentKey,
      provider: input.provider,
      model: input.model,
      binding_version: input.bindingVersion,
      tokens_in: input.tokensIn,
      tokens_out: input.tokensOut,
      cost_cny: input.costCny,
      latency_ms: input.latencyMs,
      first_token_ms: input.firstTokenMs,
      context_json: input.contextJson,
      degraded_json: input.degradedJson ?? '[]',
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('turn_metric').values(values))
    return this.get(input.turnId)!
  }

  /** 同一 turn 重跑（重试/重放）覆盖旧指标，不产生两行。 */
  upsert(input: TurnMetricInput): TurnMetricRecord {
    if (!this.get(input.turnId)) return this.insert(input)
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('turn_metric')
        .set({
          beat_id: input.beatId,
          agent_key: input.agentKey,
          provider: input.provider,
          model: input.model,
          binding_version: input.bindingVersion,
          tokens_in: input.tokensIn,
          tokens_out: input.tokensOut,
          cost_cny: input.costCny,
          latency_ms: input.latencyMs,
          first_token_ms: input.firstTokenMs,
          context_json: input.contextJson,
          degraded_json: input.degradedJson ?? '[]',
          created_at: input.createdAt ?? this.now()
        })
        .where('turn_id', '=', input.turnId)
    )
    return this.get(input.turnId)!
  }

  get(turnId: string): TurnMetricRecord | null {
    const row = firstRow<TurnMetricRow>(
      this.runner,
      this.runner.db.selectFrom('turn_metric').selectAll().where('turn_id', '=', turnId)
    )
    return row ? mapMetric(row) : null
  }

  listByJob(jobId: string): TurnMetricRecord[] {
    const rows = allRows<TurnMetricRow>(
      this.runner,
      this.runner.db
        .selectFrom('turn_metric')
        .selectAll()
        .where('job_id', '=', jobId)
        .orderBy('created_at')
    )
    return rows.map(mapMetric)
  }
}
