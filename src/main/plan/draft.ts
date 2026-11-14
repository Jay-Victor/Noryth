import { AppError } from '../../shared/domain/app-error'
import {
  CharacterCardSchema,
  emptyCharacterCard,
  withPublicFields,
  type CharacterCard,
  type PlanAddOutlineInput,
  type PlanFactAddInput,
  type PlanFactSaveInput,
  type PlanSaveOutlineInput,
  type PlanSaveResult
} from '../../shared/schema/plan'
import type { Repos } from '../db/repos'
import type { PlanFactVisibility } from '../db/repos/plan'

/**
 * 蓝图 / 角色卡 / 世界观草稿的写入（PHASE-06 E2/E3）。
 *
 * 规划页所有手工编辑都走这里：G1 之前可改，G1 之后只读（改卡走 T32 提案）。
 * 这条路径不写 `outline_node` 以外的正式实体；角色与事实在 G1 才注册。
 */

function requireProject(repos: Repos): { id: string; locked: boolean; readOnly: boolean } {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')
  return { id: project.id, locked: project.blueprintLockedAt !== null, readOnly: false }
}

function requireEditable(repos: Repos): string {
  const project = requireProject(repos)
  if (project.locked) {
    throw new AppError('invalid_args', '蓝图已锁定；修改必须走变更提案')
  }
  return project.id
}

function outlineOf(repos: Repos, projectId: string, nodeId: string) {
  const node = repos.outline.get(nodeId)
  if (!node || node.projectId !== projectId) {
    throw new AppError('invalid_args', `outline node ${nodeId} not in project`)
  }
  return node
}

export function affectedChaptersFor(repos: Repos, projectId: string, characterId: string): string[] {
  return repos.chapter
    .listByProject(projectId)
    .filter((chapter) =>
      repos.beat.listLiveByChapter(chapter.id).some((beat) => beat.speakerId === characterId)
    )
    .map((chapter) => chapter.id)
}

export function saveOutlineNode(repos: Repos, input: PlanSaveOutlineInput): PlanSaveResult {
  const projectId = requireEditable(repos)
  const node = outlineOf(repos, projectId, input.nodeId)
  if (input.title === undefined && input.content === undefined) {
    throw new AppError('invalid_args', '至少需要 title 或 content')
  }
  const updated = repos.outline.update(node.id, {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.content === undefined ? {} : { content: input.content })
  })
  return { saved: true, version: updated.version, updatedAt: updated.updatedAt }
}

export function addOutlineNode(repos: Repos, input: PlanAddOutlineInput): { id: string; version: number } {
  const projectId = requireEditable(repos)
  let parent = null
  if (input.parentId !== null) {
    parent = outlineOf(repos, projectId, input.parentId)
  }
  if (input.kind === 'main' && parent !== null) throw new AppError('invalid_args', '主线必须是根节点')
  if (input.kind === 'volume' && parent?.kind !== 'main') {
    throw new AppError('invalid_args', '卷必须挂在主线下')
  }
  if (input.kind === 'chapter' && parent?.kind !== 'volume') {
    throw new AppError('invalid_args', '章必须挂在卷下')
  }
  const siblings = parent === null ? repos.outline.listByProject(projectId).filter((node) => node.parentId === null) : repos.outline.children(parent.id)
  const ord = input.ord ?? (siblings.reduce((max, node) => Math.max(max, node.ord), -1) + 1)
  if (siblings.some((node) => node.ord === ord)) {
    throw new AppError('invalid_args', `同级 ord ${ord} 已存在`)
  }
  const node = repos.outline.insert({
    projectId,
    parentId: parent?.id ?? null,
    kind: input.kind,
    ord,
    title: input.title,
    content: input.content ?? ''
  })
  return { id: node.id, version: node.version }
}

export function removeOutlineNode(repos: Repos, nodeId: string): { removed: boolean } {
  const projectId = requireEditable(repos)
  const node = outlineOf(repos, projectId, nodeId)
  if (repos.outline.children(node.id).length > 0) {
    throw new AppError('invalid_args', '先删除子节点')
  }
  if (repos.chapter.listByProject(projectId).some((chapter) => chapter.outlineNodeId === node.id)) {
    throw new AppError('invalid_args', '节点已关联章节，不能删除')
  }
  repos.outline.remove(node.id)
  return { removed: true }
}

export function saveCharacterCard(
  repos: Repos,
  input: { characterId: string; card: CharacterCard }
): PlanSaveResult & { cardVersion: number; affectedChapters: string[] } {
  const projectId = requireEditable(repos)
  const character = repos.planCharacter.get(input.characterId)
  if (!character || character.projectId !== projectId) {
    throw new AppError('invalid_args', '角色不在当前项目')
  }
  const card = withPublicFields(CharacterCardSchema.parse(input.card))
  const updated = repos.planCharacter.updateCard(character.id, JSON.stringify(card))
  const registered = character.registeredCharacterId
    ? repos.character.get(character.registeredCharacterId)
    : null
  return {
    saved: true,
    version: updated.cardVersion,
    cardVersion: updated.cardVersion,
    updatedAt: updated.updatedAt,
    affectedChapters: registered ? affectedChaptersFor(repos, projectId, registered.id) : []
  }
}

export function addPlanCharacter(
  repos: Repos,
  input: { name: string; card?: CharacterCard }
): { id: string; cardVersion: number } {
  const projectId = requireEditable(repos)
  const name = input.name.trim()
  if (repos.planCharacter.byName(projectId, name)) {
    throw new AppError('invalid_args', `角色名重复：${name}`)
  }
  const card = input.card ? CharacterCardSchema.parse(input.card) : emptyCharacterCard()
  const character = repos.planCharacter.insert({
    projectId,
    name,
    cardJson: JSON.stringify(card)
  })
  return { id: character.id, cardVersion: character.cardVersion }
}

export function removePlanCharacter(repos: Repos, characterId: string): { removed: boolean } {
  const projectId = requireEditable(repos)
  const character = repos.planCharacter.get(characterId)
  if (!character || character.projectId !== projectId) {
    throw new AppError('invalid_args', '角色不在当前项目')
  }
  if (character.status === 'registered') {
    throw new AppError('invalid_args', '角色已注册，不能从规划台删除')
  }
  repos.planCharacter.remove(character.id)
  return { removed: true }
}

export function savePlanFact(repos: Repos, input: PlanFactSaveInput): PlanSaveResult {
  const projectId = requireEditable(repos)
  const fact = repos.planFact.get(input.factId)
  if (!fact || fact.projectId !== projectId) {
    throw new AppError('invalid_args', '条目不在当前项目')
  }
  const updated = repos.planFact.update(fact.id, {
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    visibility: input.visibility
  })
  return { saved: true, version: updated.ord, updatedAt: updated.updatedAt }
}

export function addPlanFact(repos: Repos, input: PlanFactAddInput): { id: string; ord: number } {
  const projectId = requireEditable(repos)
  const visibility: PlanFactVisibility = input.visibility === 'secret' ? 'secret' : 'public'
  const fact = repos.planFact.insert({
    projectId,
    subject: input.subject,
    predicate: input.predicate,
    object: input.object,
    visibility
  })
  return { id: fact.id, ord: fact.ord }
}

export function removePlanFact(repos: Repos, factId: string): { removed: boolean } {
  const projectId = requireEditable(repos)
  const fact = repos.planFact.get(factId)
  if (!fact || fact.projectId !== projectId) {
    throw new AppError('invalid_args', '条目不在当前项目')
  }
  if (fact.status === 'applied') {
    throw new AppError('invalid_args', '条目已写入世界状态，不能删除')
  }
  repos.planFact.remove(fact.id)
  return { removed: true }
}
