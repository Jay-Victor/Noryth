import { z } from 'zod'
import { defineTool, type AnyToolDefinition, type ToolDefinitionInput } from '../../../src/main/tools/define'
import type { AgentKey } from '../../../src/main/tools/types'

/** 单元测试用最小工具；只覆盖流水线，不掺业务。 */
export function makeTool(
  name: string,
  overrides: Partial<ToolDefinitionInput> = {}
): AnyToolDefinition {
  const base = {
    toolId: 'T99',
    name,
    version: '1.0.0',
    family: 'structure' as const,
    summary: '测试工具，用于验证工具层流水线',
    actors: ['planner'] as AgentKey[],
    sideEffect: 'none' as const,
    agentCallable: true,
    requiresGate: null,
    idempotency: 'natural' as const,
    input: z.strictObject({}),
    output: z.strictObject({ value: z.number() }),
    limits: { timeoutMs: 800, maxResultTokens: 2000, maxCallsPerTurn: 2 },
    degrade: ['full', 'empty'],
    audit: { logArgs: 'hash' as const, logResultIds: true },
    milestone: 'M0' as const,
    handler: () => ({ data: { value: 1 } })
  }
  const merged = { ...base, ...overrides } as unknown as ToolDefinitionInput
  return defineTool(merged) as unknown as AnyToolDefinition
}
