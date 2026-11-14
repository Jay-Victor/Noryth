import type { AgentInstanceKey, AgentKey } from './types'

/**
 * 单轮预算（PRD §4.9.4）：先查单工具上限，再查 Agent 单轮合计上限。
 * 项目策略只能调低，不能调高（防误配烧钱）。
 */
export const AGENT_TURN_LIMITS: Record<AgentKey, number> = {
  planner: 8,
  orchestrator: 8,
  character: 6,
  narrator: 4,
  reviewer: 12,
  memory: 8
}

export function baseAgentOf(agentKey: AgentInstanceKey): AgentKey {
  const colon = agentKey.indexOf(':')
  const base = colon === -1 ? agentKey : agentKey.slice(0, colon)
  return base as AgentKey
}

export interface TurnBudgetOptions {
  /** 项目策略的总上限；只能比默认值更低。 */
  totalLimit?: number
}

export class TurnBudget {
  private total = 0
  private readonly perTool = new Map<string, number>()
  readonly agentKey: AgentInstanceKey
  readonly limit: number

  constructor(agentKey: AgentInstanceKey, options: TurnBudgetOptions = {}) {
    this.agentKey = agentKey
    const base = AGENT_TURN_LIMITS[baseAgentOf(agentKey)] ?? 0
    const requested = options.totalLimit
    this.limit = requested === undefined ? base : Math.min(base, Math.max(0, Math.trunc(requested)))
  }

  /** 返回 false 表示超限；超限不消耗计数。 */
  take(toolName: string, maxCallsPerTool: number): boolean {
    const used = this.perTool.get(toolName) ?? 0
    if (used >= maxCallsPerTool) return false
    if (this.total >= this.limit) return false
    this.perTool.set(toolName, used + 1)
    this.total += 1
    return true
  }

  get used(): number {
    return this.total
  }

  usedFor(toolName: string): number {
    return this.perTool.get(toolName) ?? 0
  }
}
