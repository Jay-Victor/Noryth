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
  batchId: string | null
}

export interface BindingBatchRecord {
  batchId: string
  createdAt: string
  entries: number
}

export interface TurnMetricInput {
  turnId: string
  projectId: string
  jobId: string
  beatId: string | null
  /** 费用归因（PHASE-20 M2-5）：拍/审批/记忆/讨论记章；规划为 NULL。 */
  chapterId: string | null
  agentKey: string
  provider: string
  model: string
  bindingVersion: number
  tokensIn: number | null
  tokensOut: number | null
  /** 供应商报告的缓存命中 token（0014，PHASE-22）；未报告为 null/省略。 */
  cachedTokens?: number | null
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
    createdAt: row.created_at,
    batchId: row.batch_id
  }
}

function mapMetric(row: TurnMetricRow): TurnMetricRecord {
  return {
    turnId: row.turn_id,
    projectId: row.project_id,
    jobId: row.job_id,
    beatId: row.beat_id,
    chapterId: row.chapter_id,
    agentKey: row.agent_key,
    provider: row.provider,
    model: row.model,
    bindingVersion: row.binding_version,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    cachedTokens: row.cached_tokens,
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
  upsert(input: ModelBindingInput, actor: string, batchId?: string): ModelBindingRecord {
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
      createdAt: at,
      ...(batchId === undefined ? {} : { batchId })
    })
    return next
  }

  /** 回滚到「从未绑定」的状态时用它；审计由调用方在同一次回滚里写。 */
  delete(projectId: string, agentKey: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .deleteFrom('model_binding')
        .where('project_id', '=', projectId)
        .where('agent_key', '=', agentKey)
    )
  }

  recordAudit(input: {
    projectId: string
    agentKey: string
    oldJson: string | null
    newJson: string
    actor: string
    createdAt?: string
    batchId?: string | null
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
        created_at: input.createdAt ?? this.now(),
        batch_id: input.batchId ?? null
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

  /** 按批汇总（新的在前）：设置页「回滚上一套」用最近一批。 */
  listBatches(projectId: string): BindingBatchRecord[] {
    const rows = allRows<{ batch_id: string | null; created_at: string; entries: number }>(
      this.runner,
      this.runner.db
        .selectFrom('model_binding_audit')
        .select([
          'batch_id',
          (eb) => eb.fn.max<string>('created_at').as('created_at'),
          (eb) => eb.fn.countAll<number>().as('entries')
        ])
        .where('project_id', '=', projectId)
        .where('batch_id', 'is not', null)
        .groupBy('batch_id')
        .orderBy('created_at', 'desc')
    )
    return rows
      .filter((row): row is { batch_id: string; created_at: string; entries: number } => row.batch_id !== null)
      .map((row) => ({ batchId: row.batch_id, createdAt: row.created_at, entries: row.entries }))
  }

  listBatchEntries(projectId: string, batchId: string): ModelBindingAuditRecord[] {
    const rows = allRows<BindingAuditRow>(
      this.runner,
      this.runner.db
        .selectFrom('model_binding_audit')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('batch_id', '=', batchId)
        .orderBy('created_at')
    )
    return rows.map(mapAudit)
  }

  /** 已被回滚过的批 id；再次回滚同一批会撞唯一索引，这里提前给出提示。 */
  rolledBackBatches(projectId: string): string[] {
    const rows = allRows<{ batch_id: string }>(
      this.runner,
      this.runner.db.selectFrom('binding_rollback').select('batch_id').where('project_id', '=', projectId)
    )
    return rows.map((row) => row.batch_id)
  }

  /** 回滚自己写出的审计批 id：它们不能再作为回滚候选，否则撤销栈退不干净。 */
  rollbackAuditBatches(projectId: string): string[] {
    const rows = allRows<{ audit_batch_id: string }>(
      this.runner,
      this.runner.db
        .selectFrom('binding_rollback')
        .select('audit_batch_id')
        .where('project_id', '=', projectId)
    )
    return rows.map((row) => row.audit_batch_id)
  }

  recordRollback(input: {
    projectId: string
    batchId: string
    auditBatchId: string
    actor: string
    createdAt?: string
  }): void {
    runStatement(
      this.runner,
      this.runner.db.insertInto('binding_rollback').values({
        id: newId('mbr'),
        project_id: input.projectId,
        batch_id: input.batchId,
        audit_batch_id: input.auditBatchId,
        actor: input.actor,
        created_at: input.createdAt ?? this.now()
      })
    )
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
      chapter_id: input.chapterId,
      agent_key: input.agentKey,
      provider: input.provider,
      model: input.model,
      binding_version: input.bindingVersion,
      tokens_in: input.tokensIn,
      tokens_out: input.tokensOut,
      cached_tokens: input.cachedTokens ?? null,
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
          chapter_id: input.chapterId,
          agent_key: input.agentKey,
          provider: input.provider,
          model: input.model,
          binding_version: input.bindingVersion,
          tokens_in: input.tokensIn,
          tokens_out: input.tokensOut,
          cached_tokens: input.cachedTokens ?? null,
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

  /** 某一拍最近一次真实调用（上下文检查器的数据源，PHASE-13 M1-17）。 */
  latestByBeat(beatId: string): TurnMetricRecord | null {
    const row = firstRow<TurnMetricRow>(
      this.runner,
      this.runner.db
        .selectFrom('turn_metric')
        .selectAll()
        .where('beat_id', '=', beatId)
        .orderBy('created_at', 'desc')
        .limit(1)
    )
    return row ? mapMetric(row) : null
  }

  /**
   * 本章正文实际由哪一家生成（PHASE-16 §5.3 异构复检的判定输入）。
   * 只读：最近一条带 beat_id 的真实调用；没有调用过返回 null，由调用方回退到
   * 旁白绑定（尚未生成过的章节）。
   */
  latestProviderForBeats(beatIds: readonly string[]): string | null {
    if (beatIds.length === 0) return null
    const row = firstRow<{ provider: string }>(
      this.runner,
      this.runner.db
        .selectFrom('turn_metric')
        .select(['provider'])
        .where('beat_id', 'in', [...beatIds])
        .orderBy('created_at', 'desc')
        .limit(1)
    )
    return row?.provider ?? null
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

  /**
   * 每个 Agent 最近一次真实调用的时间与模型（设置页「最近使用」列）。
   * 只读聚合，不写任何东西；没有调用过就不出现。
   */
  lastUsedByAgent(projectId: string): Record<string, { at: string; provider: string; model: string }> {
    const rows = allRows<{ agent_key: string; at: string; provider: string; model: string }>(
      this.runner,
      this.runner.db
        .selectFrom('turn_metric')
        .select([
          'agent_key',
          'provider',
          'model',
          (eb) => eb.fn.max<string>('created_at').as('at')
        ])
        .where('project_id', '=', projectId)
        .groupBy(['agent_key', 'provider', 'model'])
        .orderBy('at', 'desc')
    )
    const out: Record<string, { at: string; provider: string; model: string }> = {}
    for (const row of rows) {
      if (!out[row.agent_key]) out[row.agent_key] = { at: row.at, provider: row.provider, model: row.model }
    }
    return out
  }

  /**
   * 章预算口径（DEV-PLAN §8.5 / PHASE-20 §5.1）：本章所有已计量调用。
   *
   * 口径是 `chapter_id`（0013 起）：写拍、审批、记忆、讨论都记到章；
   * 不再用 beat join 推导（旧的 beat join 只用于迁移回填）。
   * 重跑同一 turn 会覆盖指标，所以这里等于「最近一次真实消耗」。
   */
  sumByChapter(chapterId: string): {
    tokensIn: number
    tokensOut: number
    costCny: number
    pricedCalls: number
    unpricedCalls: number
    turns: number
  } {
    const row = firstRow<{
      tokens_in: number | null
      tokens_out: number | null
      cost_cny: number | null
      priced_calls: number
      turns: number
    }>(
      this.runner,
      this.runner.db
        .selectFrom('turn_metric')
        .select([
          (eb) => eb.fn.sum<number>('tokens_in').as('tokens_in'),
          (eb) => eb.fn.sum<number>('tokens_out').as('tokens_out'),
          (eb) => eb.fn.sum<number>('cost_cny').as('cost_cny'),
          (eb) => eb.fn.count<number>('cost_cny').as('priced_calls'),
          (eb) => eb.fn.countAll<number>().as('turns')
        ])
        .where('chapter_id', '=', chapterId)
    )
    const turns = Number(row?.turns ?? 0)
    const pricedCalls = Number(row?.priced_calls ?? 0)
    return {
      tokensIn: Number(row?.tokens_in ?? 0),
      tokensOut: Number(row?.tokens_out ?? 0),
      costCny: Number(row?.cost_cny ?? 0),
      pricedCalls,
      unpricedCalls: Math.max(0, turns - pricedCalls),
      turns
    }
  }

  /** 最近 N 次**拍**调用（费用预测只用写拍，审批/记忆不混进来）。 */
  recentBeatsByChapter(chapterId: string, limit = 5): TurnMetricRecord[] {
    const rows = allRows<TurnMetricRow>(
      this.runner,
      this.runner.db
        .selectFrom('turn_metric')
        .selectAll()
        .where('chapter_id', '=', chapterId)
        .where('beat_id', 'is not', null)
        .orderBy('created_at', 'desc')
        .orderBy('turn_id', 'desc')
        .limit(limit)
    )
    return rows.map(mapMetric).reverse()
  }

  /**
   * 报表聚合（PHASE-20 §5.5）：一次按 (chapter, agent) 分组，覆盖
   * 按章 / 按 Agent / 项目级 / 合计四个视角，避免 N+1。
   */
  aggregate(projectId: string, filter: CostQueryFilter = {}): TurnMetricAggregateRow[] {
    let query = this.runner.db
      .selectFrom('turn_metric')
      .select([
        'chapter_id',
        'agent_key',
        (eb) => eb.fn.sum<number>('tokens_in').as('tokens_in'),
        (eb) => eb.fn.sum<number>('tokens_out').as('tokens_out'),
        (eb) => eb.fn.sum<number>('cached_tokens').as('cached_tokens'),
        (eb) => eb.fn.sum<number>('cost_cny').as('cost_cny'),
        (eb) => eb.fn.countAll<number>().as('calls'),
        (eb) => eb.fn.count<number>('cost_cny').as('priced_calls'),
        (eb) => eb.fn.count<number>('cached_tokens').as('cache_calls')
      ])
      .where('project_id', '=', projectId)
      .groupBy(['chapter_id', 'agent_key'])
    if (filter.chapterId !== undefined) query = query.where('chapter_id', '=', filter.chapterId)
    if (filter.from !== undefined) query = query.where('created_at', '>=', filter.from)
    if (filter.to !== undefined) query = query.where('created_at', '<=', filter.to)
    const rows = allRows<{
      chapter_id: string | null
      agent_key: string
      tokens_in: number | null
      tokens_out: number | null
      cached_tokens: number | null
      cost_cny: number | null
      calls: number
      priced_calls: number
      cache_calls: number
    }>(this.runner, query)
    return rows.map((row) => ({
      chapterId: row.chapter_id,
      agentKey: row.agent_key,
      tokensIn: Number(row.tokens_in ?? 0),
      tokensOut: Number(row.tokens_out ?? 0),
      cachedTokens: Number(row.cached_tokens ?? 0),
      costCny: Number(row.cost_cny ?? 0),
      calls: Number(row.calls),
      pricedCalls: Number(row.priced_calls),
      cacheCalls: Number(row.cache_calls)
    }))
  }

  /** 耗时样本（报表 P50/P95）：一次取回，不在循环里按章查。 */
  latencySamples(projectId: string, filter: CostQueryFilter = {}): TurnMetricLatencyRow[] {
    let query = this.runner.db
      .selectFrom('turn_metric')
      .select(['chapter_id', 'agent_key', 'latency_ms'])
      .where('project_id', '=', projectId)
      .where('latency_ms', 'is not', null)
    if (filter.chapterId !== undefined) query = query.where('chapter_id', '=', filter.chapterId)
    if (filter.from !== undefined) query = query.where('created_at', '>=', filter.from)
    if (filter.to !== undefined) query = query.where('created_at', '<=', filter.to)
    const rows = allRows<{ chapter_id: string | null; agent_key: string; latency_ms: number | null }>(
      this.runner,
      query
    )
    return rows.map((row) => ({
      chapterId: row.chapter_id,
      agentKey: row.agent_key,
      latencyMs: Number(row.latency_ms ?? 0)
    }))
  }
}

/** 报表的只读过滤（PHASE-20 §5.5）：章 / 时间窗，都省略 = 全书全书期。 */
export interface CostQueryFilter {
  chapterId?: string
  from?: string
  to?: string
}

export interface TurnMetricAggregateRow {
  chapterId: string | null
  agentKey: string
  tokensIn: number
  tokensOut: number
  /** 供应商报告了缓存的调用之和；`cacheCalls` 为报告行数（口径见报表）。 */
  cachedTokens: number
  costCny: number
  calls: number
  pricedCalls: number
  cacheCalls: number
}

export interface TurnMetricLatencyRow {
  chapterId: string | null
  agentKey: string
  latencyMs: number
}
