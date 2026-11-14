import { AppError } from '../../shared/domain/app-error'
import {
  VOICE_LABELS,
  parseCharacterCard,
  missingVoiceFields,
  type PlanG1Preview,
  type PlanG1Result
} from '../../shared/schema/plan'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { withTransaction } from '../db/tx'
import { registerRoster } from '../agents/roster'
import { ensureNamespaces, type EnsureNamespaceOptions } from '../memory/namespace'
import { applyInitialFacts } from '../memory/setup'

/**
 * G1 蓝图确认（PHASE-06 E4 / PRD §2.3）。
 *
 * 顺序不可交换：校验 → 写 gate_record → 注册角色 → 写世界初值 → 锁定蓝图
 * → 建命名空间 + 隔离自检 → setup_state=complete。
 *
 * 建库失败不回滚蓝图：角色/初值/锁定都已提交，项目标 failed，重试只补建库。
 * G1 是长期授权，重复确认不会写第二条 gate_record。
 */

export interface G1Counts {
  characters: number
  mains: number
  volumes: number
  chapters: number
  facts: number
  namespaces: number
}

export function g1Counts(repos: Repos): G1Counts {
  const project = repos.project.get()
  if (!project) {
    return { characters: 0, mains: 0, volumes: 0, chapters: 0, facts: 0, namespaces: 0 }
  }
  const nodes = repos.outline.listByProject(project.id)
  return {
    characters: repos.planCharacter.listByProject(project.id).length,
    mains: nodes.filter((node) => node.kind === 'main').length,
    volumes: nodes.filter((node) => node.kind === 'volume').length,
    chapters: nodes.filter((node) => node.kind === 'chapter').length,
    facts: repos.planFact.listByProject(project.id).length,
    namespaces: repos.namespace.listByProject(project.id).length
  }
}

/** 阻断项按「结构 → 角色卡顺序」返回；UI 只显示第一条，其余在影响预览里列出。 */
export function g1Blockers(repos: Repos): string[] {
  const project = repos.project.get()
  if (!project) return ['项目不存在']
  if (project.blueprintLockedAt !== null) return []

  const blockers: string[] = []
  const counts = g1Counts(repos)
  if (counts.mains < 1) blockers.push('至少需要 1 条主线')
  if (counts.volumes < 1) blockers.push('至少需要 1 卷')
  if (counts.chapters < 1) blockers.push('至少需要 1 章')
  if (counts.characters < 1) blockers.push('至少需要 1 个角色')

  const characters = repos.planCharacter.listByProject(project.id)
  for (const character of characters) {
    const card = parseCharacterCard(character.cardJson)
    if (card.identity.trim().length === 0) blockers.push(`角色「${character.name}」缺少身份`)
    const missingVoice = missingVoiceFields(card)
    if (missingVoice.length > 0) {
      blockers.push(`角色「${character.name}」缺少 voice：${VOICE_LABELS[missingVoice[0]!]}`)
    }
    if (card.want.trim().length === 0) blockers.push(`角色「${character.name}」缺少欲望`)
    if (card.fear.trim().length === 0) blockers.push(`角色「${character.name}」缺少恐惧`)
    if (card.taboo.trim().length === 0) blockers.push(`角色「${character.name}」缺少禁忌`)
  }

  const facts = repos.planFact.listByProject(project.id)
  const seen = new Map<string, string>()
  for (const fact of facts) {
    const key = `${fact.subject}|${fact.predicate}`
    const previous = seen.get(key)
    if (previous !== undefined && previous !== fact.object) {
      blockers.push(`世界初值冲突：${fact.subject} 的「${fact.predicate}」有两个值`)
    }
    seen.set(key, fact.object)
    const current = repos.world.current(fact.subject, fact.predicate)
    if (current && current.object !== fact.object) {
      blockers.push(`世界初值冲突：${fact.subject} 的「${fact.predicate}」与已有事实不一致`)
    }
  }

  return blockers
}

export function g1Preview(repos: Repos): PlanG1Preview {
  const project = repos.project.get()
  const blockers = g1Blockers(repos)
  return {
    blockers,
    firstBlocker: blockers[0] ?? null,
    locked: project?.blueprintLockedAt !== null && project?.blueprintLockedAt !== undefined,
    lockedAt: project?.blueprintLockedAt ?? null,
    counts: g1Counts(repos)
  }
}

function gateIdOf(repos: Repos, projectId: string): string | null {
  return repos.gate.listByEntity('project', projectId).find((gate) => gate.gateId === 'G1')?.id ?? null
}

function namespaceViews(repos: Repos, projectId: string): PlanG1Result['namespaces'] {
  return repos.namespace.listByProject(projectId).map((namespace) => ({
    characterId: namespace.characterId,
    kind: namespace.kind,
    name: namespace.name
  }))
}

function completeSetup(repos: Repos, projectId: string): void {
  repos.project.setSetupState(projectId, 'complete')
  repos.project.mergeMetadata(projectId, {
    isolation_verified: true,
    setup_completed_at: new Date().toISOString()
  })
}

function resultOf(repos: Repos, projectId: string, gateId: string | null, registeredCount: number): PlanG1Result {
  const project = repos.project.getById(projectId)
  if (!project) throw new AppError('project_not_found', 'project row missing')
  const metadata = repos.project.metadata(projectId)
  return {
    gateId,
    setupState: project.setupState,
    blueprintVersion: project.blueprintVersion,
    lockedAt: project.blueprintLockedAt,
    registeredCount,
    namespaces: namespaceViews(repos, projectId),
    isolationVerified: metadata.isolation_verified === true,
    setupError: project.setupState === 'failed' ? '命名空间未建好，可重试' : null
  }
}

function registerCharacters(repos: Repos, projectId: string): number {
  return registerRoster(repos, projectId)
}

/**
 * G1 后蓝图锁定，章节点必须变成可执行的 chapter 行（阶段 07 分镜的锚点）。
 * 幂等：按 outline_node_id 跳过已存在章；ord 续接现有最大值。
 */
function ensureChapters(repos: Repos, projectId: string): number {
  const chapters = repos.chapter.listByProject(projectId)
  const linked = new Set(chapters.map((chapter) => chapter.outlineNodeId))
  let ord = chapters.reduce((max, chapter) => Math.max(max, chapter.ord), 0)
  let created = 0
  const nodes = repos.outline.listByProject(projectId)
  const volumes = new Map(nodes.filter((node) => node.kind === 'volume').map((node) => [node.id, node.ord]))
  const chapterNodes = nodes
    .filter((node) => node.kind === 'chapter')
    .sort((left, right) => {
      const leftVolume = left.parentId === null ? -1 : (volumes.get(left.parentId) ?? -1)
      const rightVolume = right.parentId === null ? -1 : (volumes.get(right.parentId) ?? -1)
      return leftVolume - rightVolume || left.ord - right.ord
    })
  for (const node of chapterNodes) {
    if (linked.has(node.id)) continue
    ord += 1
    repos.chapter.insert({
      projectId,
      outlineNodeId: node.id,
      ord,
      status: 'planned'
    })
    created += 1
  }
  return created
}

export interface ConfirmG1Options {
  /** 测试/E2E 注入的建库失败钩子；只影响命名空间阶段。 */
  failHook?: () => boolean
  failAfter?: number
}

export function confirmG1(db: Db, repos: Repos, options: ConfirmG1Options = {}): PlanG1Result {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')

  let gateId = gateIdOf(repos, project.id)
  let registeredCount = repos.character.list(project.id, { status: 'active' }).length

  if (project.blueprintLockedAt === null) {
    const blockers = g1Blockers(repos)
    if (blockers.length > 0) {
      throw new AppError('invalid_args', blockers[0]!, { blockers })
    }

    withTransaction(db, () => {
      const gate = repos.gate.insert({
        projectId: project.id,
        gateId: 'G1',
        entityType: 'project',
        entityId: project.id,
        decision: 'approve',
        actor: 'author',
        payloadJson: JSON.stringify({
          blueprint_version: Math.max(1, project.blueprintVersion),
          characters: repos.planCharacter.listByProject(project.id).length,
          facts: repos.planFact.listByProject(project.id).length,
          expected_namespaces: repos.planCharacter.listByProject(project.id).length + 1
        })
      })
      gateId = gate.id

      for (const node of repos.outline.listByProject(project.id)) {
        if (node.status !== 'locked') repos.outline.update(node.id, { status: 'locked' })
      }
      ensureChapters(repos, project.id)
      registeredCount = registerCharacters(repos, project.id)
      applyInitialFacts(repos, project.id)
      repos.project.lockBlueprint(project.id)
      repos.project.setSetupState(project.id, 'pending')
    })
  }

  const namespaceOptions: EnsureNamespaceOptions = {}
  if (options.failHook !== undefined) namespaceOptions.failHook = options.failHook
  if (options.failAfter !== undefined) namespaceOptions.failAfter = options.failAfter
  try {
    const namespaces = ensureNamespaces(repos, project.id, namespaceOptions)
    if (!namespaces.isolationVerified) {
      throw new AppError('isolation_violation', '记忆隔离自检未通过', {
        cross_character: 'nonzero'
      })
    }
    completeSetup(repos, project.id)
  } catch (error) {
    repos.project.setSetupState(project.id, 'failed')
    if (error instanceof AppError) throw error
    throw new AppError('setup_incomplete', '命名空间创建失败，可重试', {
      message: error instanceof Error ? error.message : String(error)
    })
  }

  return resultOf(repos, project.id, gateId, registeredCount)
}

/** 建库失败后的重试：不重复写 gate_record，只补命名空间 + 自检。 */
export function retrySetup(repos: Repos, options: ConfirmG1Options = {}): PlanG1Result {
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')
  if (project.blueprintLockedAt === null) {
    throw new AppError('invalid_args', '蓝图还没有通过 G1')
  }
  ensureChapters(repos, project.id)
  try {
    const namespaces = ensureNamespaces(repos, project.id, options)
    if (!namespaces.isolationVerified) {
      throw new AppError('isolation_violation', '记忆隔离自检未通过')
    }
    completeSetup(repos, project.id)
  } catch (error) {
    repos.project.setSetupState(project.id, 'failed')
    if (error instanceof AppError) throw error
    throw new AppError('setup_incomplete', '命名空间创建失败，可重试')
  }
  const gateId = gateIdOf(repos, project.id)
  return resultOf(repos, project.id, gateId, repos.character.list(project.id, { status: 'active' }).length)
}
