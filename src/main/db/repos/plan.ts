import { sql, type Insertable, type Selectable, type SqlBool, type UpdateObject } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type {
  AgentProposalTable,
  Database,
  MemoryNamespaceTable,
  PlanCharacterTable,
  PlanFactTable,
  PlanMessageTable,
  PlanSessionTable
} from '../schema'
import { BaseRepo, boolToInt, newId, type Clock, systemClock } from './common'

/** 规划台 repos（PHASE-06）：会话、消息、角色卡草案、世界观初值、提案、命名空间。 */

export type PlanSessionStatus = 'active' | 'archived'
export type PlanMessageRole = 'author' | 'planner' | 'system'
export type PlanMessageKind = 'text' | 'draft' | 'coverage' | 'g1' | 'error'
export type PlanMessageStatus = 'streaming' | 'done' | 'stopped' | 'failed'
export type PlanCharacterStatus = 'draft' | 'registered'
export type PlanFactStatus = 'draft' | 'applied'
export type AgentProposalKind = 'blueprint_patch' | 'character_card' | 'roster'
export type AgentProposalStatus = 'draft' | 'applied' | 'rejected'
export type PlanFactVisibility = 'public' | 'secret'

export interface PlanSessionRecord {
  id: string
  projectId: string
  title: string
  status: PlanSessionStatus
  createdAt: string
  updatedAt: string
  lastMessageAt: string | null
}

export interface PlanMessageRecord {
  id: string
  sessionId: string
  projectId: string
  role: PlanMessageRole
  kind: PlanMessageKind
  body: string
  status: PlanMessageStatus
  metaJson: string
  attempt: number
  retryOf: string | null
  createdAt: string
  updatedAt: string
}

export interface PlanCharacterRecord {
  id: string
  projectId: string
  name: string
  cardJson: string
  cardVersion: number
  ord: number
  status: PlanCharacterStatus
  registeredCharacterId: string | null
  createdAt: string
  updatedAt: string
}

export interface PlanFactRecord {
  id: string
  projectId: string
  subject: string
  predicate: string
  object: string
  visibility: PlanFactVisibility
  ord: number
  status: PlanFactStatus
  createdAt: string
  updatedAt: string
}

export interface AgentProposalRecord {
  id: string
  projectId: string
  kind: AgentProposalKind
  status: AgentProposalStatus
  jobId: string
  turnId: string
  summaryJson: string
  payloadJson: string
  createdAt: string
  appliedAt: string | null
}

export interface MemoryNamespaceRecord {
  id: string
  projectId: string
  characterId: string | null
  kind: 'private' | 'public'
  name: string
  isolationVerified: number
  createdAt: string
}

type SessionRow = Selectable<PlanSessionTable>
type MessageRow = Selectable<PlanMessageTable>
type CharacterRow = Selectable<PlanCharacterTable>
type FactRow = Selectable<PlanFactTable>
type ProposalRow = Selectable<AgentProposalTable>
type NamespaceRow = Selectable<MemoryNamespaceTable>

function mapSession(row: SessionRow): PlanSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    status: row.status as PlanSessionStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastMessageAt: row.last_message_at
  }
}

function mapMessage(row: MessageRow): PlanMessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    role: row.role as PlanMessageRole,
    kind: row.kind as PlanMessageKind,
    body: row.body,
    status: row.status as PlanMessageStatus,
    metaJson: row.meta_json,
    attempt: row.attempt,
    retryOf: row.retry_of,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapCharacter(row: CharacterRow): PlanCharacterRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    cardJson: row.card_json,
    cardVersion: row.card_version,
    ord: row.ord,
    status: row.status as PlanCharacterStatus,
    registeredCharacterId: row.registered_character_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapFact(row: FactRow): PlanFactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    visibility: row.visibility as PlanFactVisibility,
    ord: row.ord,
    status: row.status as PlanFactStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapProposal(row: ProposalRow): AgentProposalRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind as AgentProposalKind,
    status: row.status as AgentProposalStatus,
    jobId: row.job_id,
    turnId: row.turn_id,
    summaryJson: row.summary_json,
    payloadJson: row.payload_json,
    createdAt: row.created_at,
    appliedAt: row.applied_at
  }
}

function mapNamespace(row: NamespaceRow): MemoryNamespaceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    characterId: row.character_id,
    kind: row.kind as 'private' | 'public',
    name: row.name,
    isolationVerified: row.isolation_verified,
    createdAt: row.created_at
  }
}

export class PlanSessionRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: { id?: string; projectId: string; title: string; at?: string }): PlanSessionRecord {
    const at = input.at ?? this.now()
    const id = input.id ?? newId('psn')
    const values: Insertable<PlanSessionTable> = {
      id,
      project_id: input.projectId,
      title: input.title,
      created_at: at,
      updated_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('plan_session').values(values))
    return this.get(id)!
  }

  get(id: string): PlanSessionRecord | null {
    const row = firstRow<SessionRow>(
      this.runner,
      this.runner.db.selectFrom('plan_session').selectAll().where('id', '=', id)
    )
    return row ? mapSession(row) : null
  }

  listByProject(projectId: string, options: { status?: PlanSessionStatus } = {}): PlanSessionRecord[] {
    let query = this.runner.db
      .selectFrom('plan_session')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy(sql`rowid`)
    if (options.status) query = query.where('status', '=', options.status)
    return allRows<SessionRow>(this.runner, query).map(mapSession)
  }

  rename(id: string, title: string): PlanSessionRecord {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('plan_session')
        .set({ title, updated_at: this.now() })
        .where('id', '=', id)
    )
    return this.get(id)!
  }

  archive(id: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('plan_session')
        .set({ status: 'archived', updated_at: this.now() })
        .where('id', '=', id)
    )
  }

  touch(id: string): void {
    const at = this.now()
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('plan_session')
        .set({ last_message_at: at, updated_at: at })
        .where('id', '=', id)
    )
  }
}

export class PlanMessageRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: {
    id?: string
    sessionId: string
    projectId: string
    role: PlanMessageRole
    kind?: PlanMessageKind
    body?: string
    status?: PlanMessageStatus
    metaJson?: string
    attempt?: number
    retryOf?: string | null
    at?: string
  }): PlanMessageRecord {
    const at = input.at ?? this.now()
    const id = input.id ?? newId('pmsg')
    const values: Insertable<PlanMessageTable> = {
      id,
      session_id: input.sessionId,
      project_id: input.projectId,
      role: input.role,
      kind: input.kind ?? 'text',
      body: input.body ?? '',
      status: input.status ?? 'done',
      meta_json: input.metaJson ?? '{}',
      attempt: input.attempt ?? 1,
      retry_of: input.retryOf ?? null,
      created_at: at,
      updated_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('plan_message').values(values))
    return this.get(id)!
  }

  get(id: string): PlanMessageRecord | null {
    const row = firstRow<MessageRow>(
      this.runner,
      this.runner.db.selectFrom('plan_message').selectAll().where('id', '=', id)
    )
    return row ? mapMessage(row) : null
  }

  listBySession(sessionId: string): PlanMessageRecord[] {
    const rows = allRows<MessageRow>(
      this.runner,
      this.runner.db
        .selectFrom('plan_message')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy(sql`rowid`)
    )
    return rows.map(mapMessage)
  }

  /** 流式增量写库：保留已生成文本，停止/崩溃后不回滚。 */
  updateStream(id: string, body: string, metaJson?: string): void {
    const update: UpdateObject<Database, 'plan_message'> = { body, updated_at: this.now() }
    if (metaJson !== undefined) update.meta_json = metaJson
    runStatement(this.runner, this.runner.db.updateTable('plan_message').set(update).where('id', '=', id))
  }

  setStatus(id: string, status: PlanMessageStatus, patch: { body?: string; metaJson?: string } = {}): void {
    const update: UpdateObject<Database, 'plan_message'> = { status, updated_at: this.now() }
    if (patch.body !== undefined) update.body = patch.body
    if (patch.metaJson !== undefined) update.meta_json = patch.metaJson
    runStatement(this.runner, this.runner.db.updateTable('plan_message').set(update).where('id', '=', id))
  }

  /** 重试同一条回复：attempt + 1、清空正文、回到 streaming（不新建孤儿消息）。 */
  restart(id: string, metaJson: string): PlanMessageRecord {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('plan_message')
        .set({
          body: '',
          status: 'streaming',
          meta_json: metaJson,
          attempt: sql`attempt + 1`,
          updated_at: this.now()
        })
        .where('id', '=', id)
    )
    return this.get(id)!
  }

  /** 启动恢复：流式中的规划消息标 stopped，保留已收增量（不假装完成）。 */
  markStreamingStopped(projectId: string): number {
    const rows = allRows<{ id: string }>(
      this.runner,
      this.runner.db
        .selectFrom('plan_message')
        .select('id')
        .where('project_id', '=', projectId)
        .where('status', '=', 'streaming')
    )
    for (const row of rows) {
      this.setStatus(row.id, 'stopped', {
        metaJson: JSON.stringify({ interrupted: true, reason: 'app_restart' })
      })
    }
    return rows.length
  }

  /** 最近一条本会话的消息（用于判断是否有未完成回复）。 */
  latest(sessionId: string): PlanMessageRecord | null {
    const row = firstRow<MessageRow>(
      this.runner,
      this.runner.db
        .selectFrom('plan_message')
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy(sql`rowid`, 'desc')
        .limit(1)
    )
    return row ? mapMessage(row) : null
  }

  /** 重试时找当前回复之前最近一条作者消息；用 rowid，避免同毫秒时间戳乱序。 */
  previousAuthor(sessionId: string, beforeMessageId: string): PlanMessageRecord | null {
    const row = firstRow<MessageRow>(
      this.runner,
      this.runner.db
        .selectFrom('plan_message')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('role', '=', 'author')
        .where(sql<SqlBool>`rowid < (SELECT rowid FROM plan_message WHERE id = ${beforeMessageId})`)
        .orderBy(sql`rowid`, 'desc')
        .limit(1)
    )
    return row ? mapMessage(row) : null
  }

  countBySession(sessionId: string): number {
    const row = firstRow<{ count: number }>(
      this.runner,
      this.runner.db
        .selectFrom('plan_message')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('session_id', '=', sessionId)
    )
    return row?.count ?? 0
  }
}

export class PlanCharacterRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: {
    id?: string
    projectId: string
    name: string
    cardJson: string
    ord?: number
    status?: PlanCharacterStatus
    at?: string
  }): PlanCharacterRecord {
    const at = input.at ?? this.now()
    const id = input.id ?? newId('pchr')
    const values: Insertable<PlanCharacterTable> = {
      id,
      project_id: input.projectId,
      name: input.name,
      card_json: input.cardJson,
      ord: input.ord ?? this.maxOrd(input.projectId) + 1,
      status: input.status ?? 'draft',
      created_at: at,
      updated_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('plan_character').values(values))
    return this.get(id)!
  }

  get(id: string): PlanCharacterRecord | null {
    const row = firstRow<CharacterRow>(
      this.runner,
      this.runner.db.selectFrom('plan_character').selectAll().where('id', '=', id)
    )
    return row ? mapCharacter(row) : null
  }

  byName(projectId: string, name: string): PlanCharacterRecord | null {
    const row = firstRow<CharacterRow>(
      this.runner,
      this.runner.db
        .selectFrom('plan_character')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('name', '=', name)
    )
    return row ? mapCharacter(row) : null
  }

  listByProject(projectId: string): PlanCharacterRecord[] {
    const rows = allRows<CharacterRow>(
      this.runner,
      this.runner.db
        .selectFrom('plan_character')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('ord')
    )
    return rows.map(mapCharacter)
  }

  updateCard(id: string, cardJson: string): PlanCharacterRecord {
    const update: UpdateObject<Database, 'plan_character'> = {
      card_json: cardJson,
      card_version: sql`card_version + 1`,
      updated_at: this.now()
    }
    runStatement(this.runner, this.runner.db.updateTable('plan_character').set(update).where('id', '=', id))
    return this.get(id)!
  }

  markRegistered(id: string, characterId: string): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('plan_character')
        .set({ status: 'registered', registered_character_id: characterId, updated_at: this.now() })
        .where('id', '=', id)
    )
  }

  remove(id: string): void {
    runStatement(this.runner, this.runner.db.deleteFrom('plan_character').where('id', '=', id))
  }

  maxOrd(projectId: string): number {
    const row = firstRow<{ ord: number | null }>(
      this.runner,
      this.runner.db
        .selectFrom('plan_character')
        .select(sql<number | null>`max(ord)`.as('ord'))
        .where('project_id', '=', projectId)
    )
    return row?.ord ?? 0
  }
}

export class PlanFactRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: {
    id?: string
    projectId: string
    subject: string
    predicate: string
    object: string
    visibility?: PlanFactVisibility
    ord?: number
    status?: PlanFactStatus
    at?: string
  }): PlanFactRecord {
    const at = input.at ?? this.now()
    const id = input.id ?? newId('pfact')
    const values: Insertable<PlanFactTable> = {
      id,
      project_id: input.projectId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      visibility: input.visibility ?? 'public',
      ord: input.ord ?? this.maxOrd(input.projectId) + 1,
      status: input.status ?? 'draft',
      created_at: at,
      updated_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('plan_fact').values(values))
    return this.get(id)!
  }

  get(id: string): PlanFactRecord | null {
    const row = firstRow<FactRow>(
      this.runner,
      this.runner.db.selectFrom('plan_fact').selectAll().where('id', '=', id)
    )
    return row ? mapFact(row) : null
  }

  listByProject(projectId: string): PlanFactRecord[] {
    const rows = allRows<FactRow>(
      this.runner,
      this.runner.db
        .selectFrom('plan_fact')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('ord')
    )
    return rows.map(mapFact)
  }

  update(
    id: string,
    patch: { subject?: string; predicate?: string; object?: string; visibility?: PlanFactVisibility }
  ): PlanFactRecord {
    const update: UpdateObject<Database, 'plan_fact'> = { updated_at: this.now() }
    if (patch.subject !== undefined) update.subject = patch.subject
    if (patch.predicate !== undefined) update.predicate = patch.predicate
    if (patch.object !== undefined) update.object = patch.object
    if (patch.visibility !== undefined) update.visibility = patch.visibility
    runStatement(this.runner, this.runner.db.updateTable('plan_fact').set(update).where('id', '=', id))
    return this.get(id)!
  }

  markApplied(id: string): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('plan_fact').set({ status: 'applied', updated_at: this.now() }).where('id', '=', id)
    )
  }

  remove(id: string): void {
    runStatement(this.runner, this.runner.db.deleteFrom('plan_fact').where('id', '=', id))
  }

  maxOrd(projectId: string): number {
    const row = firstRow<{ ord: number | null }>(
      this.runner,
      this.runner.db
        .selectFrom('plan_fact')
        .select(sql<number | null>`max(ord)`.as('ord'))
        .where('project_id', '=', projectId)
    )
    return row?.ord ?? 0
  }
}

export class AgentProposalRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: {
    id?: string
    projectId: string
    kind: AgentProposalKind
    jobId: string
    turnId: string
    summaryJson?: string
    payloadJson: string
    status?: AgentProposalStatus
    at?: string
  }): AgentProposalRecord {
    const at = input.at ?? this.now()
    const id = input.id ?? newId('prop')
    const values: Insertable<AgentProposalTable> = {
      id,
      project_id: input.projectId,
      kind: input.kind,
      status: input.status ?? 'draft',
      job_id: input.jobId,
      turn_id: input.turnId,
      summary_json: input.summaryJson ?? '{}',
      payload_json: input.payloadJson,
      created_at: at
    }
    runStatement(this.runner, this.runner.db.insertInto('agent_proposal').values(values))
    return this.get(id)!
  }

  get(id: string): AgentProposalRecord | null {
    const row = firstRow<ProposalRow>(
      this.runner,
      this.runner.db.selectFrom('agent_proposal').selectAll().where('id', '=', id)
    )
    return row ? mapProposal(row) : null
  }

  listByProject(projectId: string, options: { status?: AgentProposalStatus } = {}): AgentProposalRecord[] {
    let query = this.runner.db
      .selectFrom('agent_proposal')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at')
    if (options.status) query = query.where('status', '=', options.status)
    return allRows<ProposalRow>(this.runner, query).map(mapProposal)
  }

  setStatus(id: string, status: AgentProposalStatus): void {
    const update: UpdateObject<Database, 'agent_proposal'> = { status }
    if (status === 'applied') update.applied_at = this.now()
    runStatement(this.runner, this.runner.db.updateTable('agent_proposal').set(update).where('id', '=', id))
  }
}

export class MemoryNamespaceRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  ensurePrivate(projectId: string, characterId: string, name: string): MemoryNamespaceRecord {
    const existing = this.byCharacter(projectId, characterId)
    if (existing) return existing
    const id = newId('ns')
    const values: Insertable<MemoryNamespaceTable> = {
      id,
      project_id: projectId,
      character_id: characterId,
      kind: 'private',
      name,
      created_at: this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('memory_namespace').values(values))
    return this.get(id)!
  }

  ensurePublic(projectId: string, name: string): MemoryNamespaceRecord {
    const existing = this.publicNamespace(projectId)
    if (existing) return existing
    const id = newId('ns')
    const values: Insertable<MemoryNamespaceTable> = {
      id,
      project_id: projectId,
      character_id: null,
      kind: 'public',
      name,
      created_at: this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('memory_namespace').values(values))
    return this.get(id)!
  }

  get(id: string): MemoryNamespaceRecord | null {
    const row = firstRow<NamespaceRow>(
      this.runner,
      this.runner.db.selectFrom('memory_namespace').selectAll().where('id', '=', id)
    )
    return row ? mapNamespace(row) : null
  }

  byCharacter(projectId: string, characterId: string): MemoryNamespaceRecord | null {
    const row = firstRow<NamespaceRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_namespace')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('character_id', '=', characterId)
        .where('kind', '=', 'private')
    )
    return row ? mapNamespace(row) : null
  }

  publicNamespace(projectId: string): MemoryNamespaceRecord | null {
    const row = firstRow<NamespaceRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_namespace')
        .selectAll()
        .where('project_id', '=', projectId)
        .where('kind', '=', 'public')
    )
    return row ? mapNamespace(row) : null
  }

  listByProject(projectId: string): MemoryNamespaceRecord[] {
    const rows = allRows<NamespaceRow>(
      this.runner,
      this.runner.db
        .selectFrom('memory_namespace')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('kind')
        .orderBy('name')
    )
    return rows.map(mapNamespace)
  }

  setIsolationVerified(projectId: string, verified: boolean): void {
    runStatement(
      this.runner,
      this.runner.db
        .updateTable('memory_namespace')
        .set({ isolation_verified: boolToInt(verified) })
        .where('project_id', '=', projectId)
    )
  }
}
