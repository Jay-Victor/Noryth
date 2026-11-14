import { z } from 'zod'
import { AppError } from '../../shared/domain/app-error'
import { normalizeCharacterCard, withPublicFields } from '../../shared/schema/plan'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { AgentProposalRecord } from '../db/repos/plan'
import { withTransaction } from '../db/tx'

/**
 * 提案应用（PHASE-06 §5.1 / E2）。
 *
 * 对话只写 `agent_proposal`；作者点「应用建议」后，本模块把提案落到草案表。
 * 蓝图提案是唯一能改 `outline_node` 的规划路径；G1 锁定后直接拒绝。
 */

const BlueprintAdd = z.strictObject({
  op: z.literal('add'),
  parent_id: z.string().min(1).nullable(),
  parent_ref: z.string().min(1).max(40).optional(),
  ref: z.string().min(1).max(40).optional(),
  kind: z.enum(['main', 'volume', 'chapter']),
  ord: z.number().int().min(0).max(10_000),
  title: z.string().min(1).max(200),
  content: z.string().max(20_000).optional()
})

const BlueprintUpdate = z.strictObject({
  op: z.literal('update'),
  node_id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  content: z.string().max(20_000).optional()
})

const BlueprintRemove = z.strictObject({ op: z.literal('remove'), node_id: z.string().min(1) })

const BlueprintOp = z.discriminatedUnion('op', [BlueprintAdd, BlueprintUpdate, BlueprintRemove])

const BlueprintPayload = z.strictObject({ ops: z.array(BlueprintOp).min(1).max(50) })

const RosterPayload = z.strictObject({
  roster: z.strictObject({
    characters: z.array(z.strictObject({ name: z.string(), card: z.record(z.string(), z.unknown()) })),
    initial_facts: z.array(
      z.strictObject({
        subject: z.string(),
        predicate: z.string(),
        object: z.string(),
        visibility: z.string()
      })
    )
  })
})

const CharacterCardPayload = z.strictObject({
  character_id: z.string().min(1).nullable(),
  target: z.enum(['plan', 'character']).optional(),
  card: z.record(z.string(), z.unknown())
})

export interface ApplyProposalResult {
  proposalId: string
  status: 'applied'
  blueprintVersion: number
  charactersCreated: number
  factsCreated: number
  nodesCreated: number
  affectedChapters: string[]
}

function parsePayload<T>(schema: z.ZodType<T>, proposal: AgentProposalRecord): T {
  let raw: unknown
  try {
    raw = JSON.parse(proposal.payloadJson)
  } catch {
    throw new AppError('internal_error', '提案 payload 不是合法 JSON', { proposalId: proposal.id })
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('invalid_args', '提案 payload 不符合契约', {
      proposalId: proposal.id,
      issues: parsed.error.issues.map((issue) => issue.path.join('.'))
    })
  }
  return parsed.data
}

function affectedChaptersOf(repos: Repos, projectId: string, characterId: string): string[] {
  return repos.chapter
    .listByProject(projectId)
    .filter((chapter) =>
      repos.beat.listLiveByChapter(chapter.id).some((beat) => beat.speakerId === characterId)
    )
    .map((chapter) => chapter.id)
}

function applyBlueprint(
  db: Db,
  repos: Repos,
  projectId: string,
  proposal: AgentProposalRecord
): ApplyProposalResult {
  const payload = parsePayload(BlueprintPayload, proposal)
  const project = repos.project.getById(projectId)
  if (!project) throw new AppError('project_not_found', 'project row missing')
  if (project.blueprintLockedAt !== null) {
    throw new AppError('invalid_args', '蓝图已锁定；修改必须先走变更流程')
  }

  let nodesCreated = 0
  withTransaction(db, () => {
    const refs = new Map<string, string>()
    for (const op of payload.ops) {
      if (op.op === 'add') {
        let parentId: string | null = op.parent_id
        if (op.parent_ref !== undefined) {
          if (op.parent_id !== null) {
            throw new AppError('invalid_args', 'parent_id 与 parent_ref 只能给一个')
          }
          const resolved = refs.get(op.parent_ref)
          if (!resolved) throw new AppError('invalid_args', `parent_ref ${op.parent_ref} 未定义`)
          parentId = resolved
        }
        let parent: ReturnType<Repos['outline']['get']> = null
        if (parentId !== null) {
          parent = repos.outline.get(parentId)
          if (!parent || parent.projectId !== projectId) {
            throw new AppError('invalid_args', `parent ${parentId} not in project`)
          }
        }
        if (op.kind === 'main' && parent !== null) {
          throw new AppError('invalid_args', '主线必须是根节点')
        }
        if (op.kind === 'volume' && parent?.kind !== 'main') {
          throw new AppError('invalid_args', '卷必须挂在主线下')
        }
        if (op.kind === 'chapter' && parent?.kind !== 'volume') {
          throw new AppError('invalid_args', '章必须挂在卷下')
        }
        const node = repos.outline.insert({
          projectId,
          parentId,
          kind: op.kind,
          ord: op.ord,
          title: op.title,
          content: op.content ?? '',
          status: 'draft'
        })
        if (op.ref !== undefined) {
          if (refs.has(op.ref)) throw new AppError('invalid_args', `提案内 ref 重复 ${op.ref}`)
          refs.set(op.ref, node.id)
        }
        nodesCreated += 1
        continue
      }

      const node = repos.outline.get(op.node_id)
      if (!node || node.projectId !== projectId) {
        throw new AppError('invalid_args', `outline node ${op.node_id} not in project`)
      }
      if (op.op === 'update') {
        if (op.title === undefined && op.content === undefined) {
          throw new AppError('invalid_args', 'update 至少需要 title 或 content')
        }
        repos.outline.update(node.id, {
          ...(op.title === undefined ? {} : { title: op.title }),
          ...(op.content === undefined ? {} : { content: op.content })
        })
        continue
      }

      if (repos.outline.children(node.id).length > 0) {
        throw new AppError('invalid_args', `节点 ${node.id} 还有子节点，不能删除`)
      }
      if (repos.chapter.listByProject(projectId).some((chapter) => chapter.outlineNodeId === node.id)) {
        throw new AppError('invalid_args', `节点 ${node.id} 已关联章节，不能删除`)
      }
      repos.outline.remove(node.id)
    }

    repos.proposal.setStatus(proposal.id, 'applied')
    repos.project.bumpBlueprintVersion(projectId)
  })

  const blueprintVersion = repos.project.getById(projectId)?.blueprintVersion ?? 0
  return {
    proposalId: proposal.id,
    status: 'applied',
    blueprintVersion,
    charactersCreated: 0,
    factsCreated: 0,
    nodesCreated,
    affectedChapters: []
  }
}

function applyRoster(
  db: Db,
  repos: Repos,
  projectId: string,
  proposal: AgentProposalRecord
): ApplyProposalResult {
  const payload = parsePayload(RosterPayload, proposal)
  const project = repos.project.getById(projectId)
  if (project && project.blueprintLockedAt !== null) {
    throw new AppError('invalid_args', '蓝图已锁定；新增角色必须走变更流程')
  }
  let charactersCreated = 0
  let factsCreated = 0

  withTransaction(db, () => {
    const existingFacts = new Set(
      repos.planFact.listByProject(projectId).map((fact) => `${fact.subject}|${fact.predicate}|${fact.object}`)
    )
    for (const item of payload.roster.characters) {
      const name = item.name.trim()
      if (name.length === 0) continue
      if (repos.planCharacter.byName(projectId, name)) continue
      const card = withPublicFields(normalizeCharacterCard(item.card))
      repos.planCharacter.insert({
        projectId,
        name,
        cardJson: JSON.stringify(card)
      })
      charactersCreated += 1
    }

    for (const fact of payload.roster.initial_facts) {
      const key = `${fact.subject}|${fact.predicate}|${fact.object}`
      if (existingFacts.has(key)) continue
      existingFacts.add(key)
      repos.planFact.insert({
        projectId,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        visibility: fact.visibility === 'secret' ? 'secret' : 'public'
      })
      factsCreated += 1
    }

    repos.proposal.setStatus(proposal.id, 'applied')
    repos.project.bumpBlueprintVersion(projectId)
  })

  const blueprintVersion = repos.project.getById(projectId)?.blueprintVersion ?? 0
  return {
    proposalId: proposal.id,
    status: 'applied',
    blueprintVersion,
    charactersCreated,
    factsCreated,
    nodesCreated: 0,
    affectedChapters: []
  }
}

function applyCharacterCard(
  db: Db,
  repos: Repos,
  projectId: string,
  proposal: AgentProposalRecord
): ApplyProposalResult {
  const payload = parsePayload(CharacterCardPayload, proposal)
  if (payload.character_id === null) {
    throw new AppError('invalid_args', '提案没有指定角色，无法应用')
  }
  const characterId = payload.character_id
  const card = withPublicFields(normalizeCharacterCard(payload.card))
  const planCharacter = repos.planCharacter.get(characterId)
  const character = repos.character.get(characterId)
  if (!planCharacter && !character) {
    throw new AppError('invalid_args', `character ${characterId} not in project`)
  }
  if (planCharacter && planCharacter.projectId !== projectId) {
    throw new AppError('invalid_args', `character ${characterId} not in project`)
  }
  if (character && character.projectId !== projectId) {
    throw new AppError('invalid_args', `character ${characterId} not in project`)
  }

  let affectedChapters: string[] = []
  withTransaction(db, () => {
    if (planCharacter) {
      repos.planCharacter.updateCard(planCharacter.id, JSON.stringify(card))
      if (planCharacter.registeredCharacterId) {
        const registered = repos.character.get(planCharacter.registeredCharacterId)
        if (registered) {
          repos.character.updateCard(registered.id, JSON.stringify(card))
          affectedChapters = affectedChaptersOf(repos, projectId, registered.id)
        }
      }
    } else if (character) {
      repos.character.updateCard(character.id, JSON.stringify(card))
      const linked = repos.planCharacter
        .listByProject(projectId)
        .find((item) => item.registeredCharacterId === character.id)
      if (linked) repos.planCharacter.updateCard(linked.id, JSON.stringify(card))
      affectedChapters = affectedChaptersOf(repos, projectId, character.id)
    }
    repos.proposal.setStatus(proposal.id, 'applied')
  })

  const blueprintVersion = repos.project.getById(projectId)?.blueprintVersion ?? 0
  return {
    proposalId: proposal.id,
    status: 'applied',
    blueprintVersion,
    charactersCreated: 0,
    factsCreated: 0,
    nodesCreated: 0,
    affectedChapters
  }
}

export function applyProposal(db: Db, repos: Repos, proposalId: string): ApplyProposalResult {
  const proposal = repos.proposal.get(proposalId)
  if (!proposal) throw new AppError('invalid_args', '提案不存在')
  if (proposal.status !== 'draft') {
    throw new AppError('invalid_args', `提案状态为 ${proposal.status}，不能重复应用`)
  }
  const project = repos.project.get()
  if (!project || project.id !== proposal.projectId) {
    throw new AppError('project_not_found', '提案不属于当前项目')
  }

  switch (proposal.kind) {
    case 'blueprint_patch':
      return applyBlueprint(db, repos, project.id, proposal)
    case 'roster':
      return applyRoster(db, repos, project.id, proposal)
    case 'character_card':
      return applyCharacterCard(db, repos, project.id, proposal)
    default:
      throw new AppError('invalid_args', `未知提案类型 ${proposal.kind}`)
  }
}
