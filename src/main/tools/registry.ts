import type { AnyToolDefinition } from './define'
import { assertToolDefinition } from './define'
import type { AgentKey } from './types'
import type { AgentInstanceKey } from './types'
import { sha256Hex } from '../crypto'

/**
 * 注册表：工具契约的唯一目录（PRD §4.9.2）。
 * - 名称唯一是硬失败（A4）；其余 A1–A5 问题只剔除该工具。
 * - toolset_version = 全部 name@version 排序后 sha256，写进 job 与 turn_metric。
 */

export interface UnavailableTool {
  name: string
  reason: string
}

export class RegistrySnapshot {
  private readonly baselineCache = new Map<AgentKey, readonly AnyToolDefinition[]>()

  constructor(
    readonly tools: ReadonlyMap<string, AnyToolDefinition>,
    readonly all: readonly AnyToolDefinition[],
    readonly version: string,
    readonly at: string,
    readonly unavailable: readonly UnavailableTool[]
  ) {}

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** 基线：enabled + 非系统 + agent_callable + actors 含该 Agent；按 name 排序。 */
  baselineFor(agent: AgentKey): readonly AnyToolDefinition[] {
    const cached = this.baselineCache.get(agent)
    if (cached) return cached
    const tools = this.all
      .filter((tool) => tool.enabled && !tool.system && tool.agentCallable && tool.actors.includes(agent))
      .sort((left, right) => left.name.localeCompare(right.name))
    this.baselineCache.set(agent, tools)
    return tools
  }
}

export function computeToolsetVersion(tools: readonly AnyToolDefinition[]): string {
  const manifest = tools
    .map((tool) => `${tool.name}@${tool.version}`)
    .sort()
    .join('\n')
  return sha256Hex(manifest)
}

export interface BuildRegistryOptions {
  /** 固定时钟，测试可复现。 */
  at?: string
}

export function buildRegistry(
  manifests: readonly AnyToolDefinition[],
  options: BuildRegistryOptions = {}
): RegistrySnapshot {
  const at = options.at ?? new Date().toISOString()
  const byName = new Map<string, AnyToolDefinition>()
  const unavailable: UnavailableTool[] = []
  const duplicates = new Set<string>()

  for (const tool of manifests) {
    if (byName.has(tool.name)) {
      duplicates.add(tool.name)
      continue
    }
    const errors = [...tool.validationErrors, ...assertToolDefinition(tool)]
    if (errors.length > 0) {
      unavailable.push({ name: tool.name, reason: errors.join(' | ') })
      continue
    }
    // 里程碑关闭的工具只保留契约，不注册（调用即 tool_not_found）。
    if (!tool.enabled) continue
    byName.set(tool.name, tool)
  }

  if (duplicates.size > 0) {
    throw new Error(`A4: 工具名称重复 ${[...duplicates].sort().join(', ')}`)
  }

  const version = computeToolsetVersion(manifests)
  return new RegistrySnapshot(byName, manifests, version, at, unavailable)
}

/** 解析期的角色键：'character:<id>' 只影响收窄，不改变基线。 */
export function baseAgentOf(agentKey: AgentInstanceKey): AgentKey {
  const colon = agentKey.indexOf(':')
  return (colon === -1 ? agentKey : agentKey.slice(0, colon)) as AgentKey
}
