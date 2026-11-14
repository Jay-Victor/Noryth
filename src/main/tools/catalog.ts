import raw from './tool-catalog.json'

export const AGENT_KEYS = ['planner', 'orchestrator', 'character', 'narrator', 'reviewer', 'memory'] as const
export type AgentKey = (typeof AGENT_KEYS)[number]

export type ToolFamily = 'structure' | 'knowledge' | 'verify' | 'propose' | 'interaction'
export type SideEffect = 'none' | 'propose' | 'execute' | 'commit'
export type GateId = 'G1' | 'G5' | 'G6' | 'G7' | 'author_confirm'
export type Milestone = 'M0' | 'P1' | 'M1' | 'M2'

export interface ToolCatalogEntry {
  id: string
  name: string
  version: string
  family: ToolFamily
  summary: string
  actors: AgentKey[]
  sideEffect: SideEffect
  agentCallable: boolean
  requiresGate: GateId | null
  idempotency: 'natural' | 'key_required'
  m0: boolean
  milestone: Milestone
  /** 仅阶段 3 起：单轮调用上限覆盖 */
  limits?: { maxCallsPerTurn?: number }
  /** 系统能力：注册但不进任何 Agent 工具列表 */
  system?: boolean
}

interface CatalogFile {
  version: number
  tools: ToolCatalogEntry[]
  system: ToolCatalogEntry[]
}

const catalog = raw as unknown as CatalogFile

export const TOOLS: readonly ToolCatalogEntry[] = catalog.tools
export const SYSTEM_CAPABILITIES: readonly ToolCatalogEntry[] = catalog.system.map((entry) => ({
  ...entry,
  system: true
}))
export const ALL_ENTRIES: readonly ToolCatalogEntry[] = [...TOOLS, ...SYSTEM_CAPABILITIES]

export const M0_TOOLS: readonly ToolCatalogEntry[] = TOOLS.filter((tool) => tool.m0)

export function allowlistFor(agent: AgentKey): string[] {
  return M0_TOOLS.filter((tool) => tool.actors.includes(agent))
    .map((tool) => tool.name)
    .sort()
}

export const ALLOWLIST: Record<AgentKey, string[]> = {
  planner: allowlistFor('planner'),
  orchestrator: allowlistFor('orchestrator'),
  character: allowlistFor('character'),
  narrator: allowlistFor('narrator'),
  reviewer: allowlistFor('reviewer'),
  memory: allowlistFor('memory')
}

/** PRD §4.11 的 M0 有效工具数（阶段 1 只作为断言值，阶段 3 由注册表测试复用）。 */
export const M0_COUNTS: Record<AgentKey, number> = {
  planner: 8,
  orchestrator: 16,
  character: 9,
  narrator: 5,
  reviewer: 17,
  memory: 13
}

const SEMVER = /^\d+\.\d+\.\d+$/
const NAME = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/

/** 构建期断言（DEV-PLAN §6.2 A1–A5 的当前可执行子集）。 */
export function catalogIntegrityErrors(): string[] {
  const errors: string[] = []
  const seen = new Map<string, string>()

  for (const entry of ALL_ENTRIES) {
    if (!NAME.test(entry.name)) errors.push(`${entry.id}: 名称不合规 ${entry.name}`)
    if (!SEMVER.test(entry.version)) errors.push(`${entry.id}: 版本不是 semver ${entry.version}`)
    if (seen.has(entry.name)) errors.push(`${entry.id}: 与 ${seen.get(entry.name)} 重名 ${entry.name}`)
    seen.set(entry.name, entry.id)
    if (entry.summary.length < 8 || entry.summary.length > 120) {
      errors.push(`${entry.id}: summary 长度 ${entry.summary.length} 超出 8–120`)
    }
    if (entry.sideEffect === 'commit' && entry.agentCallable) {
      errors.push(`${entry.id}: commit 工具不得 agent_callable`)
    }
    if (entry.requiresGate !== null && entry.sideEffect === 'none') {
      errors.push(`${entry.id}: 有闸门却是只读工具`)
    }
    if (entry.actors.some((actor) => !AGENT_KEYS.includes(actor))) {
      errors.push(`${entry.id}: 未知 agent`)
    }
    if (!entry.system && entry.actors.length === 0) {
      errors.push(`${entry.id}: Agent 工具 actors 不能为空`)
    }
    if (entry.system && entry.actors.length > 0) {
      errors.push(`${entry.id}: 系统能力不得出现在 Agent 白名单`)
    }
    if (!entry.system && !entry.agentCallable) {
      errors.push(`${entry.id}: 42 个 Agent 工具必须 agent_callable`)
    }
  }

  for (const [agent, expected] of Object.entries(M0_COUNTS) as Array<[AgentKey, number]>) {
    const actual = ALLOWLIST[agent].length
    if (actual !== expected) errors.push(`${agent}: M0 工具数 ${actual} != ${expected}`)
  }
  if (M0_TOOLS.length !== 36) errors.push(`M0 工具总数 ${M0_TOOLS.length} != 36`)
  if (TOOLS.length !== 42) errors.push(`Agent 工具总数 ${TOOLS.length} != 42`)

  return errors
}
