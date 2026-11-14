import type { ModelToolDescriptor, AnyToolDefinition, ToolLimits } from './define'
import { toModelTool } from './define'
import type { RegistrySnapshot } from './registry'
import { baseAgentOf } from './registry'
import type { AgentInstanceKey, AgentKey } from './types'
import { AGENT_KEYS } from './types'

/**
 * 授权解析（PRD §4.9.3 / DEV-PLAN §6.3）：
 *   有效工具集 = 角色基线 ∩ 实例收窄 ∩ 项目策略
 * 未授权 = 不存在：不返回「无权限」，硬调返回 tool_not_found。
 */

export interface ToolPolicy {
  /** P1：按项目禁用；M0 默认空。 */
  disabledTools?: readonly string[]
  /** 项目可调低 Agent 单轮合计上限；只能调低。 */
  totalLimit?: number
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {}

export class ResolvedToolset {
  private readonly byName: Map<string, AnyToolDefinition>

  constructor(
    readonly agentKey: AgentInstanceKey,
    readonly version: string,
    readonly tools: readonly AnyToolDefinition[],
    readonly resolvedAt: string
  ) {
    this.byName = new Map(tools.map((tool) => [tool.name, tool]))
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.byName.get(name)
  }

  names(): string[] {
    return this.tools.map((tool) => tool.name)
  }

  toModelTools(): ModelToolDescriptor[] {
    return this.tools.map((tool) => toModelTool(tool))
  }
}

/** 角色实例：self_only 工具裁掉 character_id 参数，身份改由注入提供。 */
export function narrowForInstance(tool: AnyToolDefinition, agentKey: AgentInstanceKey): AnyToolDefinition {
  if (!agentKey.startsWith('character:') || !tool.selfOnly) return tool
  const characterId = agentKey.slice('character:'.length)
  if (characterId.length === 0) throw new Error('character 实例键缺少 character_id')

  const shape = tool.input.shape as Record<string, unknown>
  const input = 'character_id' in shape ? tool.input.omit({ character_id: true }) : tool.input
  const injected = tool.injected.includes('character_id')
    ? tool.injected
    : [...tool.injected, 'character_id']

  return {
    ...tool,
    input: input as AnyToolDefinition['input'],
    injected
  }
}

export function resolveToolset(
  agentKey: AgentInstanceKey,
  policy: ToolPolicy,
  snapshot: RegistrySnapshot
): ResolvedToolset {
  const base = baseAgentOf(agentKey)
  if (!(AGENT_KEYS as readonly string[]).includes(base)) throw new Error(`未知 Agent: ${agentKey}`)
  if (agentKey.startsWith('character:') && agentKey.length <= 'character:'.length) {
    throw new Error('character 实例键缺少 character_id')
  }

  const disabled = new Set(policy.disabledTools ?? [])
  const tools = snapshot
    .baselineFor(base as AgentKey)
    .filter((tool) => !disabled.has(tool.name))
    .map((tool) => narrowForInstance(tool, agentKey))

  return new ResolvedToolset(agentKey, snapshot.version, tools, snapshot.at)
}

/** 仅用于测试与阶段 04 的按 job 降额：克隆一份改 limits，不影响注册表。 */
export function withToolLimit(
  toolset: ResolvedToolset,
  name: string,
  patch: Partial<ToolLimits>
): ResolvedToolset {
  const tools = toolset.tools.map((tool) =>
    tool.name === name ? { ...tool, limits: { ...tool.limits, ...patch } } : tool
  )
  return new ResolvedToolset(toolset.agentKey, toolset.version, tools, toolset.resolvedAt)
}
