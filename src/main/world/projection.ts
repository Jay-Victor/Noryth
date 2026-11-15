import type {
  CharacterBeliefRecord,
  RelationshipEdgeRecord,
  WorldFactRecord
} from '../db/repos/world'

/**
 * as-of 投影（PHASE-13 M1-3 / PRD §7.2 / DEV-PLAN §5.6）。
 *
 * 世界状态不是一张可变大表，而是 `world_fact` + `character_belief` +
 * `relationship_edge` 在某个叙事序（as_of）上的**纯函数投影**。
 *
 * 三条规则写在代码里，不写在调用方：
 *   1. 事实有效期用事实自身的 `valid_from_seq / valid_to_seq` 判（PRD §7.3「事实有效期」）；
 *   2. 读者已知只由 `visibility='public'` + `reveal_seq <= as_of` 决定，与客观事实是否有效无关；
 *   3. as_of 之后才产生的事实不算「被隐藏」，而是「还不存在」——UI 分开统计，避免
 *      「读者未知」与「不存在」混为一谈（PHASE-13 §5.3）。
 *
 * 本模块不读时钟、不碰数据库，因此可以在任何进程/测试里复算。
 */

export interface WorldFactView {
  id: string
  subject: string
  predicate: string
  object: string
  truth: 'objective' | 'claim'
  visibility: 'public' | 'secret'
  knownBy: string[]
  revealSeq: number | null
  validFromSeq: number
  validToSeq: number | null
  sourceType: string
  sourceId: string | null
  /** 读者已通过正文看到这条事实（只影响旁白/读者视图）。 */
  readerKnown: boolean
  /** 公开但还没揭示：读者不知道，不代表事实不存在。 */
  pendingReveal: boolean
}

export interface WorldBeliefView {
  id: string
  characterId: string
  factId: string | null
  beliefText: string
  confidence: number
  learnedSeq: number
  sourceType: string
  status: string
}

export interface WorldEdgeView {
  id: string
  fromId: string
  toId: string
  axis: 'trust' | 'intimacy' | 'tension'
  value: number
  sinceSeq: number
  validToSeq: number | null
  sourceType: string
  sourceId: string | null
}

export interface WorldProjection {
  asOf: number
  facts: WorldFactView[]
  beliefs: WorldBeliefView[]
  edges: WorldEdgeView[]
  counts: {
    /** 在 as_of 有效的事实总数（含客观与声称）。 */
    facts: number
    objective: number
    claim: number
    beliefs: number
    edges: number
    /** 在 as_of 之后才产生的事实条数（「还不存在」）。 */
    futureFacts: number
    /** 已存在但读者还没看到（公开未揭示 / 秘密）。 */
    notYetRevealed: number
    readerKnown: number
  }
}

export interface ProjectWorldInput {
  asOf: number
  facts: readonly WorldFactRecord[]
  beliefs: readonly CharacterBeliefRecord[]
  edges: readonly RelationshipEdgeRecord[]
}

export function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** 事实在 as_of 是否有效：只看事实自身的有效期，不看叙事阅读顺序。 */
export function factValidAt(
  fact: Pick<WorldFactRecord, 'validFromSeq' | 'validToSeq'>,
  asOf: number
): boolean {
  return fact.validFromSeq <= asOf && (fact.validToSeq === null || fact.validToSeq > asOf)
}

/**
 * 读者已知：公开且已揭示。
 * `reveal_seq` 为空表示「永不自动揭示」——即便章节已经写到后面，也不进读者视图。
 */
export function readerKnownAt(
  fact: Pick<WorldFactRecord, 'visibility' | 'revealSeq'>,
  asOf: number
): boolean {
  return fact.visibility === 'public' && fact.revealSeq !== null && fact.revealSeq <= asOf
}

/** 信念在 as_of 是否成立：只按学习序截断；信念没有 valid_to（靠 status 软失效）。 */
export function beliefActiveAt(
  belief: Pick<CharacterBeliefRecord, 'status' | 'learnedSeq'>,
  asOf: number
): boolean {
  return belief.status === 'active' && belief.learnedSeq <= asOf
}

/** 关系边在 as_of 是否有效。 */
export function edgeValidAt(
  edge: Pick<RelationshipEdgeRecord, 'sinceSeq' | 'validToSeq'>,
  asOf: number
): boolean {
  return edge.sinceSeq <= asOf && (edge.validToSeq === null || edge.validToSeq > asOf)
}

function byKey(left: { subject: string; predicate: string; object: string }, right: { subject: string; predicate: string; object: string }): number {
  return (
    left.subject.localeCompare(right.subject) ||
    left.predicate.localeCompare(right.predicate) ||
    left.object.localeCompare(right.object)
  )
}

/**
 * 事实 / 信念 / 边三组投影。排序固定为 `(subject, predicate, object, id)`，
 * 同一输入两次调用输出完全一致（DEV-PLAN §7.3 确定性要求）。
 */
export function projectWorld(input: ProjectWorldInput): WorldProjection {
  const asOf = Math.max(0, Math.trunc(input.asOf))
  const facts: WorldFactView[] = []
  const beliefs: WorldBeliefView[] = []
  const edges: WorldEdgeView[] = []
  let futureFacts = 0
  let notYetRevealed = 0
  let readerKnown = 0

  for (const fact of input.facts) {
    if (!factValidAt(fact, asOf)) {
      if (fact.validFromSeq > asOf) futureFacts += 1
      continue
    }
    const known = readerKnownAt(fact, asOf)
    if (known) readerKnown += 1
    else notYetRevealed += 1
    facts.push({
      id: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      truth: fact.truth,
      visibility: fact.visibility,
      knownBy: parseStringArray(fact.knownByJson),
      revealSeq: fact.revealSeq,
      validFromSeq: fact.validFromSeq,
      validToSeq: fact.validToSeq,
      sourceType: fact.sourceType,
      sourceId: fact.sourceId,
      readerKnown: known,
      pendingReveal: !known && fact.visibility === 'public'
    })
  }

  for (const belief of input.beliefs) {
    if (!beliefActiveAt(belief, asOf)) continue
    beliefs.push({
      id: belief.id,
      characterId: belief.characterId,
      factId: belief.factId,
      beliefText: belief.beliefText,
      confidence: belief.confidence,
      learnedSeq: belief.learnedSeq,
      sourceType: belief.sourceType,
      status: belief.status
    })
  }

  for (const edge of input.edges) {
    if (!edgeValidAt(edge, asOf)) continue
    edges.push({
      id: edge.id,
      fromId: edge.fromId,
      toId: edge.toId,
      axis: edge.axis,
      value: edge.value,
      sinceSeq: edge.sinceSeq,
      validToSeq: edge.validToSeq,
      sourceType: edge.sourceType,
      sourceId: edge.sourceId
    })
  }

  facts.sort((left, right) => byKey(left, right) || left.id.localeCompare(right.id))
  beliefs.sort(
    (left, right) => left.characterId.localeCompare(right.characterId) || left.learnedSeq - right.learnedSeq || left.id.localeCompare(right.id)
  )
  edges.sort(
    (left, right) =>
      left.fromId.localeCompare(right.fromId) ||
      left.toId.localeCompare(right.toId) ||
      left.axis.localeCompare(right.axis) ||
      left.id.localeCompare(right.id)
  )

  const objective = facts.filter((fact) => fact.truth === 'objective').length
  return {
    asOf,
    facts,
    beliefs,
    edges,
    counts: {
      facts: facts.length,
      objective,
      claim: facts.length - objective,
      beliefs: beliefs.length,
      edges: edges.length,
      futureFacts,
      notYetRevealed,
      readerKnown
    }
  }
}
