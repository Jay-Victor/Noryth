import { z } from 'zod'
import { AppError } from '../../../shared/domain/app-error'
import type { Repos } from '../../db/repos'
import type { MemoryEntryRecord, MemoryKind } from '../../db/repos/memory'
import type { WorldFactRecord } from '../../db/repos/world'
import { retrieveOwn } from '../../memory/retrieve'
import { factValidAt, readerKnownAt } from '../../world/projection'
import { queryTimeline } from '../support/timeline'
import { defineTool } from '../define'
import { makeRef } from '../support/refs'
import { clampAsOf, scoreText } from '../support/text'
import { AUDIT, Id, Query, degradeFor, limitsFor, parseJson } from './shared'

/** T10–T23：知识检索（PRD §4.10.2）。检索走 memory/retrieve（向量 + bigram + pinned）。 */

const MemoryKindSchema = z.enum(['experience', 'fact', 'relationship', 'cognition'])
const MEMORY_KINDS: MemoryKind[] = ['experience', 'fact', 'relationship', 'cognition']

const MemoryItem = z.strictObject({
  id: Id,
  kind: z.string(),
  text: z.string(),
  learned_seq: z.number().int(),
  importance: z.number()
})

const MemoryOutput = z.strictObject({ hit_count: z.number().int(), items: z.array(MemoryItem) })

function requireCharacter(ctxCharacterId: string | null): string {
  if (!ctxCharacterId) throw new AppError('invalid_args', 'character identity missing')
  return ctxCharacterId
}

async function searchMemory(
  repos: Repos,
  embedder: Parameters<typeof retrieveOwn>[1],
  input: {
    projectId: string
    actorId: string
    characterId: string
    query: string
    kinds?: readonly MemoryKind[] | undefined
    topK: number
    asOf: number
  }
): Promise<{ entries: MemoryEntryRecord[]; empty: boolean; degraded: 'none' | 'empty' | 'facts_only' }> {
  const result = await retrieveOwn(
    repos,
    embedder,
    {
      text: input.query,
      topK: input.topK,
      ...(input.kinds === undefined ? {} : { kinds: input.kinds })
    },
    {
      projectId: input.projectId,
      actorId: input.actorId,
      characterId: input.characterId,
      asOf: input.asOf
    }
  )
  return {
    entries: [...result.items, ...result.pinned].map((item) => item.entry),
    empty: result.empty,
    degraded: result.degraded
  }
}

const memoryRetrieveOwn = defineTool({
  toolId: 'T10',
  name: 'memory.retrieve_own',
  version: '1.0.0',
  family: 'knowledge',
  summary: '检索本人私有记忆，返回引用与叙事序；空结果不算失败',
  actors: ['character'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['character_id', 'as_of'],
  input: z.strictObject({
    query: Query,
    kinds: z.array(MemoryKindSchema).min(1).max(4).optional(),
    top_k: z.number().int().min(1).max(8).default(5)
  }),
  output: MemoryOutput,
  limits: limitsFor('knowledge', { maxCallsPerTurn: 3 }),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  selfOnly: true,
  handler: async (args, ctx, services) => {
    const characterId = requireCharacter(ctx.runtime.character_id)
    const found = await searchMemory(services.repos, services.embedder ?? null, {
      projectId: ctx.runtime.project_id,
      actorId: ctx.runtime.actor_id,
      characterId,
      query: args.query,
      ...(args.kinds === undefined ? {} : { kinds: args.kinds }),
      topK: args.top_k,
      asOf: ctx.runtime.as_of
    })
    return {
      data: {
        hit_count: found.entries.length,
        items: found.entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          text: entry.text,
          learned_seq: entry.learnedSeq,
          importance: entry.importance
        }))
      },
      refs: found.entries.map((entry) => makeRef('memory', entry.id, entry.text, entry.learnedSeq)),
      degraded: found.degraded
    }
  }
})

const memoryRetrieveAudit = defineTool({
  toolId: 'T11',
  name: 'memory.retrieve_audit',
  version: '1.0.0',
  family: 'knowledge',
  summary: '审批按角色审计私有记忆，返回最小证据并标明用途 issue_ref',
  actors: ['reviewer'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['as_of'],
  input: z.strictObject({
    character_id: Id,
    query: Query,
    top_k: z.number().int().min(1).max(5).default(5),
    issue_ref: z.string().min(1).max(80)
  }),
  output: MemoryOutput.extend({ issue_ref: z.string() }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: async (args, ctx, services) => {
    const character = services.repos.character.get(args.character_id)
    const inProject = character !== null && character.projectId === ctx.runtime.project_id
    const found = inProject
      ? await searchMemory(services.repos, services.embedder ?? null, {
          projectId: ctx.runtime.project_id,
          actorId: ctx.runtime.actor_id,
          characterId: args.character_id,
          query: args.query,
          topK: args.top_k,
          asOf: ctx.runtime.as_of
        })
      : { entries: [], empty: true, degraded: 'empty' as const }
    return {
      data: {
        issue_ref: args.issue_ref,
        hit_count: found.entries.length,
        items: found.entries.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          text: entry.text,
          learned_seq: entry.learnedSeq,
          importance: entry.importance
        }))
      },
      refs: found.entries.map((entry) => makeRef('memory', entry.id, entry.text, entry.learnedSeq)),
      degraded: found.degraded
    }
  }
})

const canonItem = z.strictObject({
  kind: z.enum(['canon', 'fact']),
  id: Id,
  title: z.string().nullable(),
  text: z.string()
})

const canonSearchPublic = defineTool({
  toolId: 'T12',
  name: 'canon.search_public',
  version: '1.0.0',
  family: 'knowledge',
  summary: '检索公共设定与已揭示事实；不返回私有记忆 ID，不返回未揭示事实',
  actors: ['planner', 'orchestrator', 'character', 'narrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['as_of'],
  input: z.strictObject({ query: Query, top_k: z.number().int().min(1).max(5).default(5) }),
  output: z.strictObject({ hit_count: z.number().int(), items: z.array(canonItem) }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const outlines = services.repos.outline
      .listByProject(ctx.runtime.project_id)
      .filter((node) => node.status === 'approved')
      .map((node) => ({
        kind: 'canon' as const,
        id: node.id,
        title: node.title,
        text: `${node.title}\n${node.content}`,
        ...scoreText(`${node.title}\n${node.content}`, args.query)
      }))
    const facts = services.repos.world
      .listByProject(ctx.runtime.project_id)
      .filter((fact) => readerKnownAt(fact, ctx.runtime.as_of))
      .map((fact) => ({
        kind: 'fact' as const,
        id: fact.id,
        title: null,
        text: `${fact.subject} ${fact.predicate} ${fact.object}`,
        ...scoreText(`${fact.subject} ${fact.predicate} ${fact.object}`, args.query)
      }))

    const items = [...outlines, ...facts]
      .filter((item) => item.hits > 0)
      .sort(
        (left, right) =>
          right.score - left.score || right.hits - left.hits || left.id.localeCompare(right.id)
      )
      .slice(0, args.top_k)

    return {
      data: {
        hit_count: items.length,
        items: items.map((item) => ({ kind: item.kind, id: item.id, title: item.title, text: item.text }))
      },
      refs: items.map((item) => makeRef(item.kind === 'canon' ? 'canon' : 'fact', item.id, item.text)),
      degraded: items.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const FactItem = z.strictObject({
  id: Id,
  subject: z.string(),
  predicate: z.string(),
  object: z.string(),
  truth: z.string(),
  visibility: z.string(),
  known_by: z.array(z.string()),
  reveal_seq: z.number().int().nullable(),
  valid_from_seq: z.number().int(),
  valid_to_seq: z.number().int().nullable()
})

function factItem(fact: WorldFactRecord): z.infer<typeof FactItem> {
  return {
    id: fact.id,
    subject: fact.subject,
    predicate: fact.predicate,
    object: fact.object,
    truth: fact.truth,
    visibility: fact.visibility,
    known_by: parseJson<string[]>(fact.knownByJson, []),
    reveal_seq: fact.revealSeq,
    valid_from_seq: fact.validFromSeq,
    valid_to_seq: fact.validToSeq
  }
}

/**
 * 当前章序（PHASE-13 M1-19）：定稿正文与审计通道都按「本章及更早」截断。
 * `chapterId` 为空（规划台）时返回 null，表示不做章级限制——那时还没有定稿章。
 */
function currentChapterOrd(services: { repos: Repos }, ctx: { chapterId: string | null }): number | null {
  if (!ctx.chapterId) return null
  return services.repos.chapter.get(ctx.chapterId)?.ord ?? null
}

const worldGetLimited = defineTool({
  toolId: 'T13',
  name: 'world.get_limited',
  version: '1.0.0',
  family: 'knowledge',
  summary: '返回本人已知与公开的世界事实；不能查未来章节，不返回秘密事实',
  actors: ['character'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['character_id'],
  input: z.strictObject({ as_of: z.number().int().min(0).optional() }),
  output: z.strictObject({ as_of: z.number().int(), facts: z.array(FactItem) }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const characterId = requireCharacter(ctx.runtime.character_id)
    const asOf = clampAsOf(args.as_of, ctx.runtime.as_of)
    const candidates = services.repos.world
      .listByProject(ctx.runtime.project_id)
      .filter((fact) => factValidAt(fact, asOf))
    const facts = candidates.filter((fact) => {
      const knownBy = parseJson<string[]>(fact.knownByJson, [])
      if (knownBy.includes(characterId)) return true
      return fact.visibility === 'public' && (fact.revealSeq === null || fact.revealSeq <= asOf)
    })
    return {
      data: { as_of: asOf, facts: facts.map(factItem) },
      refs: facts.map((fact) => makeRef('fact', fact.id, `${fact.subject} ${fact.predicate} ${fact.object}`)),
      filteredCount: candidates.length - facts.length,
      degraded: facts.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const worldGetReaderKnown = defineTool({
  toolId: 'T14',
  name: 'world.get_reader_known',
  version: '1.0.0',
  family: 'knowledge',
  summary: '返回读者已知投影：只含 reveal_seq 不晚于 as_of 的公开事实，旁白唯一事实来源',
  actors: ['orchestrator', 'narrator'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ as_of: z.number().int().min(0).optional() }),
  output: z.strictObject({ as_of: z.number().int(), facts: z.array(FactItem) }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const asOf = clampAsOf(args.as_of, ctx.runtime.as_of)
    const facts = services.repos.world
      .listByProject(ctx.runtime.project_id)
      .filter((fact) => readerKnownAt(fact, asOf))
      .filter((fact) => factValidAt(fact, asOf))
    return {
      data: { as_of: asOf, facts: facts.map(factItem) },
      refs: facts.map((fact) => makeRef('fact', fact.id, `${fact.subject} ${fact.predicate} ${fact.object}`)),
      degraded: facts.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const worldGetObjective = defineTool({
  toolId: 'T15',
  name: 'world.get_objective',
  version: '1.0.0',
  family: 'knowledge',
  summary: '返回全量客观事实（含秘密），只用于排戏、审计与记忆抽取',
  actors: ['orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({
    as_of: z.number().int().min(0).optional(),
    subjects: z.array(z.string().min(1).max(80)).min(1).max(20).optional()
  }),
  output: z.strictObject({ as_of: z.number().int(), facts: z.array(FactItem) }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const asOf = clampAsOf(args.as_of, ctx.runtime.as_of)
    const subjects = args.subjects ? new Set(args.subjects) : null
    const facts = services.repos.world
      .listByProject(ctx.runtime.project_id)
      .filter((fact) => factValidAt(fact, asOf))
      .filter((fact) => !subjects || subjects.has(fact.subject))
    return {
      data: { as_of: asOf, facts: facts.map(factItem) },
      refs: facts.map((fact) => makeRef('fact', fact.id, `${fact.subject} ${fact.predicate} ${fact.object}`)),
      degraded: facts.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const BeliefItem = z.strictObject({
  id: Id,
  fact_id: Id.nullable(),
  belief_text: z.string(),
  confidence: z.number(),
  learned_seq: z.number().int()
})

const beliefGetOwn = defineTool({
  toolId: 'T16',
  name: 'belief.get_own',
  version: '1.0.0',
  family: 'knowledge',
  summary: '返回本人信念；信念可错、可矛盾，不自动升格为世界事实',
  actors: ['character'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  injected: ['character_id'],
  input: z.strictObject({}),
  output: z.strictObject({ beliefs: z.array(BeliefItem) }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  selfOnly: true,
  handler: (_args, ctx, services) => {
    const characterId = requireCharacter(ctx.runtime.character_id)
    const beliefs = services.repos.belief.listByCharacter(characterId).filter((belief) => belief.status === 'active')
    return {
      data: {
        beliefs: beliefs.map((belief) => ({
          id: belief.id,
          fact_id: belief.factId,
          belief_text: belief.beliefText,
          confidence: belief.confidence,
          learned_seq: belief.learnedSeq
        }))
      },
      refs: beliefs.map((belief) => makeRef('belief', belief.id, belief.beliefText, belief.learnedSeq)),
      degraded: beliefs.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const beliefGetForCharacter = defineTool({
  toolId: 'T17',
  name: 'belief.get_for_character',
  version: '1.0.0',
  family: 'knowledge',
  summary: '读取指定角色信念，用于排戏与泄漏判定；不得写进正文',
  actors: ['orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ character_id: Id }),
  output: z.strictObject({ character_id: Id, beliefs: z.array(BeliefItem) }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const character = services.repos.character.get(args.character_id)
    const inProject = character !== null && character.projectId === ctx.runtime.project_id
    const beliefs = inProject
      ? services.repos.belief.listByCharacter(args.character_id).filter((belief) => belief.status === 'active')
      : []
    return {
      data: {
        character_id: args.character_id,
        beliefs: beliefs.map((belief) => ({
          id: belief.id,
          fact_id: belief.factId,
          belief_text: belief.beliefText,
          confidence: belief.confidence,
          learned_seq: belief.learnedSeq
        }))
      },
      refs: beliefs.map((belief) => makeRef('belief', belief.id, belief.beliefText, belief.learnedSeq)),
      degraded: beliefs.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const EdgeItem = z.strictObject({
  id: Id,
  from_id: Id,
  to_id: Id,
  axis: z.string(),
  value: z.number(),
  since_seq: z.number().int()
})

const relationshipGetEdges = defineTool({
  toolId: 'T18',
  name: 'relationship.get_edges',
  version: '1.0.0',
  family: 'knowledge',
  summary: '读取信任、亲密、张力边；角色实例只能看与本人相关的边',
  actors: ['orchestrator', 'character', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({
    character_id: Id.optional(),
    axis: z.enum(['trust', 'intimacy', 'tension']).optional()
  }),
  output: z.strictObject({ edges: z.array(EdgeItem) }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  selfOnly: true,
  handler: (args, ctx, services) => {
    const isCharacterInstance = ctx.runtime.actor_id.startsWith('character:')
    const target = isCharacterInstance ? ctx.runtime.character_id : args.character_id
    const edges = target
      ? services.repos.relationship.listActiveFor(target)
      : services.repos.relationship.listActiveAll()
    const filtered = args.axis ? edges.filter((edge) => edge.axis === args.axis) : edges
    return {
      data: {
        edges: filtered.map((edge) => ({
          id: edge.id,
          from_id: edge.fromId,
          to_id: edge.toId,
          axis: edge.axis,
          value: edge.value,
          since_seq: edge.sinceSeq
        }))
      },
      degraded: filtered.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const manuscriptSearchFinal = defineTool({
  toolId: 'T19',
  name: 'manuscript.search_final',
  version: '1.0.0',
  family: 'knowledge',
  summary: '检索定稿正文，返回章、拍与引用；初稿不进入检索',
  actors: ['orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({
    query: Query,
    limit: z.number().int().min(1).max(8).default(5),
    chapter_id: Id.optional()
  }),
  output: z.strictObject({
    hit_count: z.number().int(),
    items: z.array(
      z.strictObject({ chapter_id: Id, beat_id: Id, quote: z.string(), seq: z.number().int().nullable() })
    )
  }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const maxOrd = currentChapterOrd(services, ctx)
    const requested =
      args.chapter_id === undefined ? null : services.repos.chapter.get(args.chapter_id)
    if (args.chapter_id !== undefined && (!requested || requested.projectId !== ctx.runtime.project_id)) {
      throw new AppError('invalid_args', '章节不存在', { chapterId: args.chapter_id })
    }
    if (requested && maxOrd !== null && requested.ord > maxOrd) {
      // PHASE-13 M1-19：定稿检索不能从第 3 章读到第 4 章以后。
      throw new AppError('invalid_args', '不能检索本章之后的定稿', {
        chapterOrd: requested.ord,
        currentOrd: maxOrd
      })
    }
    const chapters = services.repos.chapter
      .listByProject(ctx.runtime.project_id)
      .filter((chapter) => chapter.finalRevisionId !== null)
      .filter((chapter) => maxOrd === null || chapter.ord <= maxOrd)
      .filter((chapter) => !args.chapter_id || chapter.id === args.chapter_id)

    const hits = chapters.flatMap((chapter) =>
      services.repos.revision
        .manifest(chapter.finalRevisionId!)
        .map((row) => ({ chapterId: chapter.id, row, ...scoreText(row.body, args.query) }))
        .filter((hit) => hit.hits > 0)
    )

    const items = hits
      .sort(
        (left, right) =>
          right.score - left.score || right.hits - left.hits || left.row.beatOrd - right.row.beatOrd
      )
      .slice(0, args.limit)
      .map((hit) => {
        const beat = services.repos.beat.get(hit.row.beatId)
        return {
          chapter_id: hit.chapterId,
          beat_id: hit.row.beatId,
          quote: hit.row.body,
          seq: beat?.seq ?? null
        }
      })

    return {
      data: { hit_count: items.length, items },
      refs: items.map((item) => makeRef('manuscript', item.beat_id, item.quote, item.seq ?? undefined)),
      degraded: items.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const FinalBeat = z.strictObject({
  beat_id: Id,
  speaker_type: z.string(),
  speaker_id: z.string(),
  body: z.string()
})

const manuscriptGetFinalChapter = defineTool({
  toolId: 'T20',
  name: 'manuscript.get_final_chapter',
  version: '1.0.0',
  family: 'knowledge',
  summary: '读取定稿全文；无定稿返回空，不回退到草稿',
  actors: ['orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ chapter_id: Id }),
  output: z.strictObject({
    chapter_id: Id,
    found: z.boolean(),
    revision_id: Id.nullable(),
    beats: z.array(FinalBeat)
  }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const chapter = services.repos.chapter.get(args.chapter_id)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      throw new AppError('invalid_args', '章节不存在', { chapterId: args.chapter_id })
    }
    const maxOrd = currentChapterOrd(services, ctx)
    if (maxOrd !== null && chapter.ord > maxOrd) {
      // PHASE-13 M1-19：审批第 3 章读不到第 4 章以后的定稿。
      throw new AppError('invalid_args', '不能读取本章之后的定稿', {
        chapterOrd: chapter.ord,
        currentOrd: maxOrd
      })
    }
    if (chapter.finalRevisionId === null) {
      return { data: { chapter_id: args.chapter_id, found: false, revision_id: null, beats: [] }, degraded: 'empty' as const }
    }
    const beats = services.repos.revision.manifest(chapter.finalRevisionId).map((row) => ({
      beat_id: row.beatId,
      speaker_type: row.speakerType,
      speaker_id: row.speakerId,
      body: row.body
    }))
    return {
      data: { chapter_id: chapter.id, found: true, revision_id: chapter.finalRevisionId, beats },
      degraded: beats.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const draftGetChapter = defineTool({
  toolId: 'T21',
  name: 'draft.get_chapter',
  version: '1.0.0',
  family: 'knowledge',
  summary: '按 revision 读取初稿正文；只读，revision 必须属于本项目当前章',
  actors: ['reviewer'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ revision_id: Id }),
  output: z.strictObject({
    revision_id: Id,
    chapter_id: Id,
    kind: z.string(),
    content_hash: z.string(),
    beats: z.array(FinalBeat)
  }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M0',
  handler: (args, ctx, services) => {
    const revision = services.repos.revision.get(args.revision_id)
    if (!revision) throw new AppError('stale_revision', 'revision not found')
    const chapter = services.repos.chapter.get(revision.chapterId)
    if (!chapter || chapter.projectId !== ctx.runtime.project_id) {
      throw new AppError('stale_revision', 'revision not in project')
    }
    if (revision.kind !== 'draft' || chapter.currentRevisionId !== revision.id) {
      throw new AppError('stale_revision', 'revision is not the current draft')
    }
    const beats = services.repos.revision.manifest(revision.id).map((row) => ({
      beat_id: row.beatId,
      speaker_type: row.speakerType,
      speaker_id: row.speakerId,
      body: row.body
    }))
    return {
      data: {
        revision_id: revision.id,
        chapter_id: chapter.id,
        kind: revision.kind,
        content_hash: revision.contentHash,
        beats
      },
      degraded: beats.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

const notImplemented = (name: string): never => {
  throw new AppError('tool_unavailable', `${name} 按里程碑开关未启用`)
}

/** T22（P1）：契约完整，enabled=false，不在任何 M0 白名单。 */
const foreshadowListOpen = defineTool({
  toolId: 'T22',
  name: 'foreshadow.list_open',
  version: '1.0.0',
  family: 'knowledge',
  summary: '列出未回收伏笔与埋设章（P1），只报节奏，不报逻辑错误',
  actors: ['orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ as_of: z.number().int().min(0).optional() }),
  output: z.strictObject({
    items: z.array(z.strictObject({ id: Id, text: z.string(), planted_chapter_id: Id.nullable() }))
  }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'P1',
  handler: () => notImplemented('foreshadow.list_open')
})

/** T23（M1 / PHASE-12）：三轴分开返回；as_of 不越章水位。 */
const timelineQuery = defineTool({
  toolId: 'T23',
  name: 'timeline.query',
  version: '1.1.0',
  family: 'knowledge',
  summary: '按章查询时间线：故事时间、叙事序与时间轴分轴返回，闪回不参与先后判定',
  actors: ['orchestrator', 'reviewer', 'memory'],
  sideEffect: 'none',
  agentCallable: true,
  requiresGate: null,
  idempotency: 'natural',
  input: z.strictObject({ chapter_id: Id.optional(), as_of: z.number().int().min(0).optional() }),
  output: z.strictObject({
    chapter_id: Id,
    idx: z.number().int(),
    story_start: z.string().nullable(),
    story_end: z.string().nullable(),
    scenes: z.array(
      z.strictObject({
        scene_id: Id,
        ord: z.number().int(),
        timeline: z.enum(['main', 'flashback', 'dream']),
        story_start: z.string().nullable(),
        story_end: z.string().nullable()
      })
    ),
    timeline: z.array(
      z.strictObject({
        seq: z.number().int(),
        story_time: z.string().nullable(),
        timeline: z.enum(['main', 'flashback', 'dream'])
      })
    )
  }),
  limits: limitsFor('knowledge'),
  degrade: degradeFor('knowledge'),
  audit: AUDIT,
  milestone: 'M1',
  enabled: true,
  handler: (args, ctx, services) => {
    const chapterId = args.chapter_id ?? ctx.chapterId
    if (!chapterId) throw new AppError('invalid_args', 'chapter context missing')
    if (args.as_of !== undefined && args.as_of > ctx.runtime.as_of) {
      throw new AppError('stale_revision', `as_of ${args.as_of} 超过运行时水位 ${ctx.runtime.as_of}`, {
        asOf: args.as_of,
        asOfCeiling: ctx.runtime.as_of
      })
    }
    const view = queryTimeline(services.repos, {
      projectId: ctx.runtime.project_id,
      chapterId,
      asOf: args.as_of ?? ctx.runtime.as_of
    })
    return {
      data: {
        chapter_id: view.chapterId,
        idx: view.idx,
        story_start: view.storyStart,
        story_end: view.storyEnd,
        scenes: view.scenes.map((scene) => ({
          scene_id: scene.sceneId,
          ord: scene.ord,
          timeline: scene.timeline,
          story_start: scene.storyStart,
          story_end: scene.storyEnd
        })),
        timeline: view.timeline.map((row) => ({
          seq: row.seq,
          story_time: row.storyTime,
          timeline: row.timeline
        }))
      },
      refs: view.scenes
        .filter((scene) => scene.storyStart !== null)
        .map((scene) => makeRef('outline', scene.sceneId, `${scene.timeline} · ${scene.storyStart ?? ''}`)),
      degraded: view.timeline.length === 0 ? ('empty' as const) : ('none' as const)
    }
  }
})

export const KNOWLEDGE_TOOLS = [
  memoryRetrieveOwn,
  memoryRetrieveAudit,
  canonSearchPublic,
  worldGetLimited,
  worldGetReaderKnown,
  worldGetObjective,
  beliefGetOwn,
  beliefGetForCharacter,
  relationshipGetEdges,
  manuscriptSearchFinal,
  manuscriptGetFinalChapter,
  draftGetChapter,
  foreshadowListOpen,
  timelineQuery
]

export { MEMORY_KINDS }
