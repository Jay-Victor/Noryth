import type { AnyToolDefinition } from '../define'
import { STRUCTURE_TOOLS } from './structure'
import { KNOWLEDGE_TOOLS } from './knowledge'
import { VERIFY_TOOLS } from './verify'
import { PROPOSE_TOOLS } from './propose'
import { INTERACTION_TOOLS } from './interaction'
import { SYSTEM_TOOLS } from '../system'

/** 42 个 Agent 工具（含 6 个里程碑开关）+ 8 个系统能力。 */
export const AGENT_TOOLS: readonly AnyToolDefinition[] = [
  ...STRUCTURE_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...VERIFY_TOOLS,
  ...PROPOSE_TOOLS,
  ...INTERACTION_TOOLS
] as unknown as AnyToolDefinition[]

export const ALL_MANIFESTS: readonly AnyToolDefinition[] = [
  ...AGENT_TOOLS,
  ...SYSTEM_TOOLS
] as unknown as AnyToolDefinition[]

export { SYSTEM_TOOLS }
