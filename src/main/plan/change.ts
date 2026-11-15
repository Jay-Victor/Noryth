import { z } from 'zod'
import { AppError } from '../../shared/domain/app-error'
import {
  BlueprintOpSchema,
  CharacterCardChangeSchema,
  type BlueprintChangeView,
  type BlueprintMeta,
  type ImpactResult
} from '../../shared/schema/blueprint'
import { normalizeCharacterCard, withPublicFields } from '../../shared/schema/plan'
import type { Repos } from '../db/repos'
import type { BlueprintChangeRecord } from '../db/repos/blueprint-change'
import { computeImpact, summarizeOps } from './impact'
import { parseBlueprintMeta } from '../../shared/schema/blueprint'

/**
 * G1 后的蓝图变更流程（PHASE-15 M1-8 / §5.2）。
 *
 *   T31 提案（或作者直接给 ops）→ T29 影响分析（必须）
 *   → blueprint_change(status=proposed) → 作者确认 → 应用 outline / 角色卡
 *   → 受影响章 invalidated_at（只标记，不改正文）
 *
 * 三条硬规则：
 * 1. 未跑影响分析或影响记录为空 → `invalid_args`，不能「假装没影响」。
 * 2. 应用不改正文、不建 revision、不自动重跑下游。
 * 3. G1 前不用本流程（作者走「应用建议」改草案）；G1 后草案路径拒绝。
 */

const ChangePayloadSchema = z.strictObject({
  ops: z.array(BlueprintOpSchema).max(50),
  character_card: CharacterCardChangeSchema.optional()
})
type ChangePayload = z.infer<typeof ChangePayloadSchema>

export interface ChangeHost {
  /** 事务由调用方控制（PlanService 用 withTransaction 包住 applyChange）。 */
  repos: Repos
}

function requireProject(
  repos: Repos,
  projectId: string
): { id: string; blueprintLockedAt: string | null; blueprintVersion: number } {
  const project = repos.project.getById(projectId)
  if (!project) throw new AppError('project_not_found', 'project row missing')
  return project
}

function parsePayload(json: string): ChangePayload {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new AppError('internal_error', '变更记录不是合法 JSON')
  }
  const parsed = ChangePayloadSchema.safeParse(raw)
  if (!parsed.success) {
    throw new AppError('internal_error', '变更记录不符合契约', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.'))
    })
  }
  return parsed.data
}

function parseImpact(json: string): ImpactResult | null {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (record.analyzed !== true) return null
  if (!Array.isArray(record.chapters) || !Array.isArray(record.memory_entries) || !Array.isArray(record.relationships)) {
    return null
  }
  return record as unknown as ImpactResult
}

function viewOf(repos: Repos, change: BlueprintChangeRecord): BlueprintChangeView {
  const payload = parsePayload(change.opsJson)
  const impact = parseImpact(change.impactJson)
  return {
    id: change.id,
    status: change.status,
    proposalId: change.proposalId,
    actor: change.actor,
    createdAt: change.createdAt,
    appliedAt: change.appliedAt,
    ops: payload.ops,
    impact,
    summary: summarizeOps(payload.ops, payload.character_card ? 1 : 0)
  }
}

/** 影响面数据快照：只在需要时加载「章 → 发言人」。 */
function impactOf(host: ChangeHost, projectId: string, payload: ChangePayload): ImpactResult {
  const chapters = host.repos.chapter.listByProject(projectId)
  const characterId = payload.character_card?.character_id
  let speakersByChapter: Map<string, string[]> | undefined
  if (characterId !== undefined) {
    speakersByChapter = new Map(
      chapters.map((chapter) => [
        chapter.id,
        host.repos.beat.listLiveByChapter(chapter.id).map((beat) => beat.speakerId)
      ])
    )
  }
  return computeImpact(
    {
      nodes: host.repos.outline.listByProject(projectId),
      chapters,
      memories: host.repos.memory.listByProject(projectId, { status: 'active' }),
      edges: host.repos.relationship.listByProject(projectId),
      ...(speakersByChapter === undefined ? {} : { speakersByChapter }),
      now: new Date().toISOString()
    },
    {
      ...(payload.ops.length === 0 ? {} : { ops: payload.ops }),
      ...(characterId === undefined ? {} : { characterId })
    }
  )
}

export interface AnalyzeChangeInput {
  projectId: string
  ops?: readonly unknown[]
  characterCard?: { character_id: string; card: Record<string, unknown> }
  proposalId?: string | null
  actor: string
}

/**
 * 影响分析（T29 与作者路径共用）。
 *
 * 每次都写一条新的 `blueprint_change`（status=proposed）：分析结果必须可追溯，
 * 不能只在内存里算一次就应用。同一次提案重复分析会产生多条记录，
 * 作者应用的是自己点的那一条。
 */
export function analyzeChange(host: ChangeHost, input: AnalyzeChangeInput): BlueprintChangeView {
  // 分析本身是只读的（只写一条变更记录），G1 前也允许规划 Agent 预演影响；
  // 「应用」才要求蓝图已锁定（见 applyChange）。
  requireProject(host.repos, input.projectId)

  const ops = (input.ops ?? []).map((op) => {
    const parsed = BlueprintOpSchema.safeParse(op)
    if (!parsed.success) {
      throw new AppError('invalid_args', '变更 op 不符合契约', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.'))
      })
    }
    return parsed.data
  })
  if (ops.length === 0 && input.characterCard === undefined) {
    throw new AppError('invalid_args', '变更没有内容：至少给一条 op 或一张角色卡')
  }

  const payload: ChangePayload = {
    ops,
    ...(input.characterCard === undefined
      ? {}
      : { character_card: { character_id: input.characterCard.character_id, card: input.characterCard.card } })
  }

  // 结构校验放在分析前：不合法的变更不该产生一条「看起来可行」的记录。
  validateForProject(host.repos, input.projectId, payload)
  if (payload.character_card !== undefined) {
    const target =
      host.repos.planCharacter.get(payload.character_card.character_id) ??
      host.repos.character.get(payload.character_card.character_id)
    if (!target || target.projectId !== input.projectId) {
      throw new AppError('invalid_args', `character ${payload.character_card.character_id} not in project`)
    }
  }

  const impact = impactOf(host, input.projectId, payload)
  const record = host.repos.blueprintChange.insert({
    projectId: input.projectId,
    proposalId: input.proposalId ?? null,
    opsJson: JSON.stringify(payload),
    impactJson: JSON.stringify(impact),
    actor: input.actor
  })
  return viewOf(host.repos, record)
}

/** 只做「能不能应用」的结构校验；不写库。 */
function validateForProject(repos: Repos, projectId: string, payload: ChangePayload): void {
  const nodes = repos.outline.listByProject(projectId)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const refs = new Map<string, string>()
  const chapterByNode = new Map(repos.chapter.listByProject(projectId).map((chapter) => [chapter.outlineNodeId, chapter]))

  for (const op of payload.ops) {
    if (op.op === 'add') {
      let parentId = op.parent_id
      if (op.parent_ref !== undefined) {
        if (op.parent_id !== null) {
          throw new AppError('invalid_args', 'parent_id 与 parent_ref 只能给一个')
        }
        const resolved = refs.get(op.parent_ref)
        if (!resolved) throw new AppError('invalid_args', `parent_ref ${op.parent_ref} 未定义`)
        parentId = resolved
      }
      const parent = parentId === null ? null : byId.get(parentId) ?? null
      if (parentId !== null && parent === null) {
        throw new AppError('invalid_args', `parent ${parentId} not in project`)
      }
      if (op.kind === 'main' && parent !== null) throw new AppError('invalid_args', '主线必须是根节点')
      if (op.kind === 'volume' && parent?.kind !== 'main') throw new AppError('invalid_args', '卷必须挂在主线下')
      if (op.kind === 'chapter' && parent?.kind !== 'volume') throw new AppError('invalid_args', '章必须挂在卷下')
      if (op.ref !== undefined) {
        if (refs.has(op.ref)) throw new AppError('invalid_args', `提案内 ref 重复 ${op.ref}`)
        refs.set(op.ref, `pending_${op.ref}`)
      }
      continue
    }
    const node = byId.get(op.node_id)
    if (!node) throw new AppError('invalid_args', `outline node ${op.node_id} not in project`)
    if (op.op === 'update') {
      if (op.title === undefined && op.content === undefined && op.meta === undefined) {
        throw new AppError('invalid_args', 'update 至少需要 title / content / meta 之一')
      }
      continue
    }
    if (nodes.some((candidate) => candidate.parentId === node.id)) {
      throw new AppError('invalid_args', `节点 ${node.id} 还有子节点，不能删除`)
    }
    if (chapterByNode.has(node.id)) {
      throw new AppError('invalid_args', `节点 ${node.id} 已关联章节，不能删除`)
    }
  }
}

function mergeMeta(existing: BlueprintMeta, patch: NonNullable<Extract<ChangePayload['ops'][number], { op: 'update' }>['meta']>): BlueprintMeta {
  const next: BlueprintMeta = { ...existing }
  if (patch.key_events !== undefined) next.key_events = patch.key_events
  if (patch.character_ids !== undefined) next.character_ids = patch.character_ids
  if (patch.mainline !== undefined) next.mainline = patch.mainline
  if (patch.pov_character_id !== undefined) {
    if (patch.pov_character_id === null) delete next.pov_character_id
    else next.pov_character_id = patch.pov_character_id
  }
  return next
}

function metaJsonOf(meta: BlueprintMeta): string {
  const out: Record<string, unknown> = {}
  if (meta.key_events !== undefined) out.key_events = meta.key_events
  if (meta.character_ids !== undefined) out.character_ids = meta.character_ids
  if (meta.pov_character_id !== undefined) out.pov_character_id = meta.pov_character_id
  if (meta.mainline !== undefined) out.mainline = meta.mainline
  return JSON.stringify(out)
}

export interface ApplyChangeInput {
  projectId: string
  changeId: string
  /** 默认 true：标记受影响章（只标记，不改正文）。 */
  markChapters?: boolean
}

export interface ApplyChangeResult {
  change: BlueprintChangeView
  blueprintVersion: number
  invalidatedChapters: string[]
}

/**
 * 应用变更。必须先有一条带 `analyzed: true` 的影响记录（PHASE-15 §5.2）。
 *
 * 应用本身不产生 revision：正文与章状态都不动，只有 outline / 角色卡、
 * `blueprint_change`、`chapter.invalidated_at` 与一条系统提示会变。
 */
export function applyChange(host: ChangeHost, input: ApplyChangeInput): ApplyChangeResult {
  const project = requireProject(host.repos, input.projectId)
  if (project.blueprintLockedAt === null) {
    throw new AppError('invalid_args', '蓝图还没有通过 G1；请先「应用建议」改草案')
  }
  const change = host.repos.blueprintChange.get(input.changeId)
  if (!change || change.projectId !== project.id) {
    throw new AppError('invalid_args', '变更记录不存在')
  }
  if (change.status !== 'proposed') {
    throw new AppError('invalid_args', `变更状态为 ${change.status}，不能重复应用`)
  }
  const impact = parseImpact(change.impactJson)
  if (impact === null) {
    throw new AppError('invalid_args', '还没有跑影响分析（T29）；不能假装没有影响', {
      changeId: change.id,
      reason: 'impact_missing'
    })
  }
  const payload = parsePayload(change.opsJson)

  let blueprintVersion = project.blueprintVersion
  const invalidatedChapters: string[] = []

  // 事务由调用方（service）提供；这里依赖 repos 的同步执行与 withTransaction 的原子性。
  const refs = new Map<string, string>()
  for (const op of payload.ops) {
    if (op.op === 'add') {
      let parentId = op.parent_id
      if (op.parent_ref !== undefined) {
        const resolved = refs.get(op.parent_ref)
        if (!resolved) throw new AppError('invalid_args', `parent_ref ${op.parent_ref} 未定义`)
        parentId = resolved
      }
      const meta = op.meta === undefined ? {} : mergeMeta({}, op.meta)
      const node = host.repos.outline.insert({
        projectId: project.id,
        parentId,
        kind: op.kind,
        ord: op.ord,
        title: op.title,
        content: op.content ?? '',
        status: 'locked',
        metaJson: metaJsonOf(meta)
      })
      if (op.ref !== undefined) refs.set(op.ref, node.id)
      continue
    }
    const node = host.repos.outline.get(op.node_id)
    if (!node || node.projectId !== project.id) {
      throw new AppError('invalid_args', `outline node ${op.node_id} not in project`)
    }
    if (op.op === 'update') {
      const meta = op.meta === undefined ? undefined : mergeMeta(parseBlueprintMeta(node.metaJson), op.meta)
      host.repos.outline.update(node.id, {
        ...(op.title === undefined ? {} : { title: op.title }),
        ...(op.content === undefined ? {} : { content: op.content }),
        ...(meta === undefined ? {} : { metaJson: metaJsonOf(meta) })
      })
      continue
    }
    if (host.repos.outline.children(node.id).length > 0) {
      throw new AppError('invalid_args', `节点 ${node.id} 还有子节点，不能删除`)
    }
    if (host.repos.chapter.listByProject(project.id).some((chapter) => chapter.outlineNodeId === node.id)) {
      throw new AppError('invalid_args', `节点 ${node.id} 已关联章节，不能删除`)
    }
    host.repos.outline.remove(node.id)
  }

  if (payload.character_card !== undefined) {
    const card = withPublicFields(normalizeCharacterCard(payload.character_card.card))
    const planCharacter = host.repos.planCharacter.get(payload.character_card.character_id)
    const registered = host.repos.character.get(payload.character_card.character_id)
    if (planCharacter) host.repos.planCharacter.updateCard(planCharacter.id, JSON.stringify(card))
    if (registered) host.repos.character.updateCard(registered.id, JSON.stringify(card))
    if (planCharacter?.registeredCharacterId) {
      const target = host.repos.character.get(planCharacter.registeredCharacterId)
      if (target) host.repos.character.updateCard(target.id, JSON.stringify(card))
    }
  }

  if (payload.ops.length > 0) blueprintVersion = host.repos.project.bumpBlueprintVersion(project.id)

  const reason = `蓝图变更：${payload.ops.length} 处结构改动${payload.character_card ? ' + 1 张角色卡' : ''}（${change.id}）`
  if (input.markChapters !== false) {
    for (const chapter of impact.chapters) {
      host.repos.chapter.markInvalidated(chapter.id, reason)
      invalidatedChapters.push(chapter.id)
      host.repos.writeMessage.insert({
        projectId: project.id,
        chapterId: chapter.id,
        role: 'system',
        kind: 'text',
        body: `${reason}。本章被标为「待重审」：正文与已定稿版本都没有改动，重写或忽略由作者决定。`,
        metaJson: JSON.stringify({ kind: 'blueprint_change', change_id: change.id })
      })
    }
  }

  host.repos.blueprintChange.setStatus(change.id, 'applied', new Date().toISOString())
  if (change.proposalId !== null) {
    const proposal = host.repos.proposal.get(change.proposalId)
    if (proposal && proposal.status === 'draft') host.repos.proposal.setStatus(proposal.id, 'applied')
  }

  const updated = host.repos.blueprintChange.get(change.id)!
  return {
    change: viewOf(host.repos, updated),
    blueprintVersion,
    invalidatedChapters
  }
}

export function rejectChange(host: ChangeHost, projectId: string, changeId: string): BlueprintChangeView {
  const change = host.repos.blueprintChange.get(changeId)
  if (!change || change.projectId !== projectId) {
    throw new AppError('invalid_args', '变更记录不存在')
  }
  if (change.status !== 'proposed') {
    throw new AppError('invalid_args', `变更状态为 ${change.status}，不能拒绝`)
  }
  host.repos.blueprintChange.setStatus(changeId, 'rejected')
  return viewOf(host.repos, host.repos.blueprintChange.get(changeId)!)
}

export function listChanges(repos: Repos, projectId: string): BlueprintChangeView[] {
  return repos.blueprintChange.listByProject(projectId).map((change) => viewOf(repos, change))
}

/** 作者忽略标脏：只清两列，不动正文、不动状态。 */
export function dismissInvalidation(repos: Repos, projectId: string, chapterId: string): { dismissed: boolean } {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter || chapter.projectId !== projectId) {
    throw new AppError('invalid_args', '本章不存在')
  }
  if (chapter.invalidatedAt === null) return { dismissed: false }
  repos.chapter.clearInvalidation(chapter.id)
  return { dismissed: true }
}
