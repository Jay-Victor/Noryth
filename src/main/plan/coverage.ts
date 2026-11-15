import { parseBlueprintMeta, type BlueprintMeta, type CoverageGap } from '../../shared/schema/blueprint'
import type { Repos } from '../db/repos'

/**
 * 覆盖检查（PHASE-15 M1-11 / PRD §5.1 覆盖检查 P1）。
 *
 * M1 只做确定性四类规则，不调模型、不猜语义：
 *   1. `key_event_unlanded`  卷纲关键事件没有章落点 → 阻断
 *   2. `character_uncast`    卷纲主要角色没有任何出场章 → 阻断
 *   3. `mainline_gap`        主线推进间隔 > 5 章 → 建议
 *   4. `pov_missing`         章纲 POV 不在角色表 / 已归档 → 阻断
 *
 * 另给一条 `meta_unannotated` 建议：`meta_json` 全空的老项目只做结构校验，
 * 不因为「没标注」被卡在 G1 外面（PHASE-15 §5.1）。
 *
 * 阻断与建议的分界（PHASE-15 §7 回退）：只有「明确冲突」才阻断——
 * 关键事件没有章可演、角色不在任何章出场、POV 角色不存在；节奏类只建议。
 */

/** 主线推进的最大间隔（章）；超过只给建议。 */
export const MAINLINE_MAX_GAP = 5

export interface CoverageNode {
  id: string
  parentId: string | null
  kind: 'main' | 'volume' | 'chapter'
  ord: number
  title: string
  metaJson: string
}

export interface CoverageCharacter {
  id: string
  name: string
  /** 已归档角色不能当 POV（archived 只存在于正式 character 表）。 */
  archived: boolean
}

export interface CoverageInput {
  nodes: readonly CoverageNode[]
  characters: readonly CoverageCharacter[]
}

interface ChapterOrderEntry {
  node: CoverageNode
  meta: BlueprintMeta
  order: number
}

function orderOf(nodes: readonly CoverageNode[]): Map<string, number> {
  const volumes = nodes
    .filter((node) => node.kind === 'volume')
    .slice()
    .sort((left, right) => left.ord - right.ord)
  const volumeIndex = new Map(volumes.map((node, index) => [node.id, index]))
  const chapters = nodes
    .filter((node) => node.kind === 'chapter')
    .slice()
    .sort((left, right) => {
      const leftVolume = left.parentId === null ? -1 : (volumeIndex.get(left.parentId) ?? -1)
      const rightVolume = right.parentId === null ? -1 : (volumeIndex.get(right.parentId) ?? -1)
      return leftVolume - rightVolume || left.ord - right.ord
    })
  return new Map(chapters.map((node, index) => [node.id, index + 1]))
}

/** 卷的子树里所有章节点（按大纲层级，不看 ord）。 */
function chaptersOfVolume(nodes: readonly CoverageNode[], volumeId: string): CoverageNode[] {
  return nodes.filter((node) => node.kind === 'chapter' && node.parentId === volumeId)
}

export function analyzeCoverage(input: CoverageInput): CoverageGap[] {
  const { nodes, characters } = input
  const gaps: CoverageGap[] = []
  const characterById = new Map(characters.map((character) => [character.id, character]))
  const chapterOrder = orderOf(nodes)
  const chapters = nodes.filter((node) => node.kind === 'chapter')
  const volumes = nodes.filter((node) => node.kind === 'volume')
  const chapterById = new Map(chapters.map((node) => [node.id, node]))

  for (const volume of volumes) {
    const meta = parseBlueprintMeta(volume.metaJson)
    const volumeChapters = chaptersOfVolume(nodes, volume.id)
    const volumeChapterIds = new Set(volumeChapters.map((node) => node.id))

    for (const event of meta.key_events ?? []) {
      const target = event.chapter_node_id === undefined ? null : chapterById.get(event.chapter_node_id) ?? null
      if (target !== null && volumeChapterIds.has(target.id)) continue
      const where =
        target === null
          ? event.chapter_node_id === undefined
            ? '还没有指定落点章'
            : `落点章 ${event.chapter_node_id} 不存在`
          : `落点章「${target.title}」不在本卷内`
      gaps.push({
        code: 'key_event_unlanded',
        severity: 'error',
        node_id: volume.id,
        node_title: volume.title,
        character_id: null,
        message: `卷「${volume.title}」的关键事件「${event.text}」${where}`
      })
    }

    for (const characterId of meta.character_ids ?? []) {
      const character = characterById.get(characterId)
      const name = character?.name ?? characterId
      const appears = volumeChapters.some((chapter) => {
        const chapterMeta = parseBlueprintMeta(chapter.metaJson)
        return (chapterMeta.character_ids ?? []).includes(characterId)
      })
      if (appears) continue
      gaps.push({
        code: 'character_uncast',
        severity: 'error',
        node_id: volume.id,
        node_title: volume.title,
        character_id: characterId,
        message: `角色「${name}」在卷「${volume.title}」里没有任何出场章`
      })
    }
  }

  const mainline = chapters
    .map<ChapterOrderEntry>((node) => ({ node, meta: parseBlueprintMeta(node.metaJson), order: chapterOrder.get(node.id) ?? 0 }))
    .filter((entry) => entry.meta.mainline === true)
    .sort((left, right) => left.order - right.order)
  for (let index = 1; index < mainline.length; index += 1) {
    const previous = mainline[index - 1]!
    const current = mainline[index]!
    const gap = current.order - previous.order
    if (gap <= MAINLINE_MAX_GAP) continue
    gaps.push({
      code: 'mainline_gap',
      severity: 'warn',
      node_id: current.node.id,
      node_title: current.node.title,
      character_id: null,
      message: `主线在第 ${previous.order} 章到第 ${current.order} 章之间断了 ${gap - 1} 章`
    })
  }

  for (const chapter of chapters) {
    const meta = parseBlueprintMeta(chapter.metaJson)
    const povId = meta.pov_character_id
    if (povId === undefined) continue
    const character = characterById.get(povId)
    if (!character) {
      gaps.push({
        code: 'pov_missing',
        severity: 'error',
        node_id: chapter.id,
        node_title: chapter.title,
        character_id: povId,
        message: `章「${chapter.title}」的 POV 角色 ${povId} 不在角色表`
      })
      continue
    }
    if (character.archived) {
      gaps.push({
        code: 'pov_missing',
        severity: 'error',
        node_id: chapter.id,
        node_title: chapter.title,
        character_id: character.id,
        message: `章「${chapter.title}」的 POV 角色「${character.name}」已归档`
      })
    }
  }

  const annotated = (node: CoverageNode): boolean => {
    const meta = parseBlueprintMeta(node.metaJson)
    return (
      (meta.key_events?.length ?? 0) > 0 ||
      (meta.character_ids?.length ?? 0) > 0 ||
      meta.pov_character_id !== undefined ||
      meta.mainline !== undefined
    )
  }
  const unannotated = [...volumes, ...chapters].filter((node) => !annotated(node))
  if (unannotated.length > 0) {
    gaps.push({
      code: 'meta_unannotated',
      severity: 'warn',
      node_id: 'project',
      node_title: '项目',
      character_id: null,
      message: `${unannotated.length} 个卷/章未标注结构化纲要素；覆盖检查只做了结构校验`
    })
  }

  return gaps
}

/** 只有 error 才禁 G1；warn 只计数（PRD §6.3）。 */
export function coverageBlockers(gaps: readonly CoverageGap[]): string[] {
  return gaps.filter((gap) => gap.severity === 'error').map((gap) => gap.message)
}

/** T26 的 scope：按问题落在哪类节点上过滤（project = 全部）。 */
export function filterCoverageByScope(
  gaps: readonly CoverageGap[],
  scope: 'volume' | 'chapter' | 'project',
  nodes: readonly CoverageNode[]
): CoverageGap[] {
  if (scope === 'project') return [...gaps]
  const kindOf = new Map(nodes.map((node) => [node.id, node.kind]))
  return gaps.filter((gap) => {
    if (gap.node_id === 'project') return false
    return kindOf.get(gap.node_id) === scope
  })
}

/** 覆盖检查开关存在 `project.metadata_json.coverage_gate`；默认开（PHASE-15 §7）。 */
export function coverageGateEnabled(metadata: Record<string, unknown>): boolean {
  return metadata.coverage_gate !== false
}

/** 从 repos 收集检查输入：结构化标注只来自 `outline_node.meta_json`。 */
export function gatherCoverageInput(repos: Repos, projectId: string): CoverageInput {
  const nodes = repos.outline.listByProject(projectId).map((node) => ({
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    ord: node.ord,
    title: node.title,
    metaJson: node.metaJson
  }))
  const characters = new Map<string, CoverageCharacter>()
  for (const character of repos.character.list(projectId)) {
    characters.set(character.id, {
      id: character.id,
      name: character.name,
      archived: character.status === 'archived'
    })
  }
  for (const draft of repos.planCharacter.listByProject(projectId)) {
    if (characters.has(draft.id)) continue
    characters.set(draft.id, { id: draft.id, name: draft.name, archived: false })
  }
  return { nodes, characters: [...characters.values()] }
}

/** 项目当前的覆盖检查结果（G1 阻断、规划台面板与 T26 共用同一份规则）。 */
export function coverageGaps(repos: Repos, projectId: string): CoverageGap[] {
  return analyzeCoverage(gatherCoverageInput(repos, projectId))
}
