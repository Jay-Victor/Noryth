import type { Insertable, Selectable } from 'kysely'
import type { Db } from '../project-db'
import type { QueryRunner } from '../kysely'
import { allRows, firstRow, runStatement } from '../kysely'
import type {
  CharacterBeliefTable,
  RelationshipEdgeTable,
  WorldFactTable
} from '../schema'
import { BaseRepo, newId, type Clock, systemClock } from './common'

export type WorldTruth = 'objective' | 'claim'
export type WorldVisibility = 'public' | 'secret'
export type WorldSourceType = 'author' | 'event' | 'memory'
export type BeliefSourceType = 'dialogue' | 'narration' | 'inference' | 'author'
export type RelationshipAxis = 'trust' | 'intimacy' | 'tension'
export type RelationshipSourceType = 'event' | 'memory' | 'author'
export type WorldEntryStatus = 'active' | 'superseded' | 'inactive'

export interface WorldFactRecord {
  id: string
  projectId: string
  subject: string
  predicate: string
  object: string
  singleValue: number
  truth: WorldTruth
  visibility: WorldVisibility
  knownByJson: string
  revealSeq: number | null
  validFromSeq: number
  validToSeq: number | null
  sourceType: WorldSourceType
  sourceId: string | null
  createdAt: string
}

export interface NewWorldFactInput {
  id?: string
  projectId: string
  subject: string
  predicate: string
  object: string
  singleValue?: number
  truth: WorldTruth
  visibility: WorldVisibility
  knownByJson?: string
  revealSeq?: number | null
  validFromSeq: number
  validToSeq?: number | null
  sourceType: WorldSourceType
  sourceId?: string | null
  createdAt?: string
}

export interface CharacterBeliefRecord {
  id: string
  projectId: string
  characterId: string
  factId: string | null
  beliefText: string
  confidence: number
  learnedSeq: number
  sourceType: BeliefSourceType
  sourceId: string | null
  status: WorldEntryStatus
  createdAt: string
}

export interface NewCharacterBeliefInput {
  id?: string
  projectId: string
  characterId: string
  factId?: string | null
  beliefText: string
  confidence: number
  learnedSeq: number
  sourceType: BeliefSourceType
  sourceId?: string | null
  status?: WorldEntryStatus
  createdAt?: string
}

export interface RelationshipEdgeRecord {
  id: string
  projectId: string
  fromId: string
  toId: string
  axis: RelationshipAxis
  value: number
  sinceSeq: number
  validToSeq: number | null
  sourceType: RelationshipSourceType
  sourceId: string | null
  supersedesId: string | null
}

export interface NewRelationshipEdgeInput {
  id?: string
  projectId: string
  fromId: string
  toId: string
  axis: RelationshipAxis
  value: number
  sinceSeq: number
  validToSeq?: number | null
  sourceType: RelationshipSourceType
  sourceId?: string | null
  supersedesId?: string | null
}

type FactRow = Selectable<WorldFactTable>
type BeliefRow = Selectable<CharacterBeliefTable>
type RelationshipRow = Selectable<RelationshipEdgeTable>

function mapFact(row: FactRow): WorldFactRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    singleValue: row.single_value,
    truth: row.truth as WorldTruth,
    visibility: row.visibility as WorldVisibility,
    knownByJson: row.known_by_json,
    revealSeq: row.reveal_seq,
    validFromSeq: row.valid_from_seq,
    validToSeq: row.valid_to_seq,
    sourceType: row.source_type as WorldSourceType,
    sourceId: row.source_id,
    createdAt: row.created_at
  }
}

function mapBelief(row: BeliefRow): CharacterBeliefRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    characterId: row.character_id,
    factId: row.fact_id,
    beliefText: row.belief_text,
    confidence: row.confidence,
    learnedSeq: row.learned_seq,
    sourceType: row.source_type as BeliefSourceType,
    sourceId: row.source_id,
    status: row.status as WorldEntryStatus,
    createdAt: row.created_at
  }
}

function mapRelationship(row: RelationshipRow): RelationshipEdgeRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    fromId: row.from_id,
    toId: row.to_id,
    axis: row.axis as RelationshipAxis,
    value: row.value,
    sinceSeq: row.since_seq,
    validToSeq: row.valid_to_seq,
    sourceType: row.source_type as RelationshipSourceType,
    sourceId: row.source_id,
    supersedesId: row.supersedes_id
  }
}

/** 世界事实：只写客观事实或明确标注的 claim；台词不得伪造 objective。 */
export class WorldFactRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewWorldFactInput): WorldFactRecord {
    const id = input.id ?? newId('wf')
    const values: Insertable<WorldFactTable> = {
      id,
      project_id: input.projectId,
      subject: input.subject,
      predicate: input.predicate,
      object: input.object,
      single_value: input.singleValue ?? 1,
      truth: input.truth,
      visibility: input.visibility,
      known_by_json: input.knownByJson ?? '[]',
      reveal_seq: input.revealSeq ?? null,
      valid_from_seq: input.validFromSeq,
      valid_to_seq: input.validToSeq ?? null,
      source_type: input.sourceType,
      source_id: input.sourceId ?? null,
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('world_fact').values(values))
    return this.get(id)!
  }

  get(id: string): WorldFactRecord | null {
    const row = firstRow<FactRow>(
      this.runner,
      this.runner.db.selectFrom('world_fact').selectAll().where('id', '=', id)
    )
    return row ? mapFact(row) : null
  }

  listByProject(projectId: string): WorldFactRecord[] {
    const rows = allRows<FactRow>(
      this.runner,
      this.runner.db
        .selectFrom('world_fact')
        .selectAll()
        .where('project_id', '=', projectId)
        .orderBy('valid_from_seq')
    )
    return rows.map(mapFact)
  }

  current(subject: string, predicate: string): WorldFactRecord | null {
    const row = firstRow<FactRow>(
      this.runner,
      this.runner.db
        .selectFrom('world_fact')
        .selectAll()
        .where('subject', '=', subject)
        .where('predicate', '=', predicate)
        .where('valid_to_seq', 'is', null)
        .where('truth', '=', 'objective')
        .orderBy('valid_from_seq', 'desc')
        .limit(1)
    )
    return row ? mapFact(row) : null
  }

  closeValidity(id: string, seq: number): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('world_fact').set({ valid_to_seq: seq }).where('id', '=', id)
    )
  }
}

export class CharacterBeliefRepo extends BaseRepo {
  constructor(input: Db | QueryRunner, now: Clock = systemClock) {
    super(input, now)
  }

  insert(input: NewCharacterBeliefInput): CharacterBeliefRecord {
    const id = input.id ?? newId('bel')
    const values: Insertable<CharacterBeliefTable> = {
      id,
      project_id: input.projectId,
      character_id: input.characterId,
      fact_id: input.factId ?? null,
      belief_text: input.beliefText,
      confidence: input.confidence,
      learned_seq: input.learnedSeq,
      source_type: input.sourceType,
      source_id: input.sourceId ?? null,
      status: input.status ?? 'active',
      created_at: input.createdAt ?? this.now()
    }
    runStatement(this.runner, this.runner.db.insertInto('character_belief').values(values))
    return this.get(id)!
  }

  get(id: string): CharacterBeliefRecord | null {
    const row = firstRow<BeliefRow>(
      this.runner,
      this.runner.db.selectFrom('character_belief').selectAll().where('id', '=', id)
    )
    return row ? mapBelief(row) : null
  }

  listByCharacter(characterId: string): CharacterBeliefRecord[] {
    const rows = allRows<BeliefRow>(
      this.runner,
      this.runner.db
        .selectFrom('character_belief')
        .selectAll()
        .where('character_id', '=', characterId)
        .orderBy('learned_seq')
    )
    return rows.map(mapBelief)
  }

  setStatus(id: string, status: WorldEntryStatus): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('character_belief').set({ status }).where('id', '=', id)
    )
  }
}

export class RelationshipRepo extends BaseRepo {
  constructor(input: Db | QueryRunner) {
    super(input)
  }

  insert(input: NewRelationshipEdgeInput): RelationshipEdgeRecord {
    const id = input.id ?? newId('rel')
    const values: Insertable<RelationshipEdgeTable> = {
      id,
      project_id: input.projectId,
      from_id: input.fromId,
      to_id: input.toId,
      axis: input.axis,
      value: input.value,
      since_seq: input.sinceSeq,
      valid_to_seq: input.validToSeq ?? null,
      source_type: input.sourceType,
      source_id: input.sourceId ?? null,
      supersedes_id: input.supersedesId ?? null
    }
    runStatement(this.runner, this.runner.db.insertInto('relationship_edge').values(values))
    return this.get(id)!
  }

  get(id: string): RelationshipEdgeRecord | null {
    const row = firstRow<RelationshipRow>(
      this.runner,
      this.runner.db.selectFrom('relationship_edge').selectAll().where('id', '=', id)
    )
    return row ? mapRelationship(row) : null
  }

  listActiveFrom(characterId: string): RelationshipEdgeRecord[] {
    const rows = allRows<RelationshipRow>(
      this.runner,
      this.runner.db
        .selectFrom('relationship_edge')
        .selectAll()
        .where('from_id', '=', characterId)
        .where('valid_to_seq', 'is', null)
        .orderBy('to_id')
        .orderBy('axis')
    )
    return rows.map(mapRelationship)
  }

  current(fromId: string, toId: string, axis: RelationshipAxis): RelationshipEdgeRecord | null {
    const row = firstRow<RelationshipRow>(
      this.runner,
      this.runner.db
        .selectFrom('relationship_edge')
        .selectAll()
        .where('from_id', '=', fromId)
        .where('to_id', '=', toId)
        .where('axis', '=', axis)
        .where('valid_to_seq', 'is', null)
        .limit(1)
    )
    return row ? mapRelationship(row) : null
  }

  closeValidity(id: string, seq: number): void {
    runStatement(
      this.runner,
      this.runner.db.updateTable('relationship_edge').set({ valid_to_seq: seq }).where('id', '=', id)
    )
  }
}
