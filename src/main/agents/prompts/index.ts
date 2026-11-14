import type { ChatMessage } from '../../model/adapter'
import { FALLBACK_INSTRUCTION } from '../../model/json-fallback'
import type { ContextBundle, CtxBlock } from '../../context/budget'
import { sha256Hex } from '../../crypto'
import { baseAgentOf } from '../../tools/registry'
import type { AgentInstanceKey, AgentKey } from '../../tools/types'
import { CHARACTER_PROMPT } from './character'
import { MEMORY_PROMPT } from './memory'
import { NARRATOR_PROMPT } from './narrator'
import { ORCHESTRATOR_PROMPT } from './orchestrator'
import { PLANNER_PROMPT } from './planner'
import { REVIEWER_PROMPT } from './reviewer'
import { TOOL_MATERIAL_RULE } from './contract'

/**
 * 六个 Agent 的提示词与渲染（DEV-PLAN §7.9）。
 *
 * 结构：
 *   [SYSTEM] 角色/任务/输出契约/禁则 + L0 章级 + L1 场景（稳定前缀）
 *   [USER]   角色卡 → pinned → refs → 最近拍 → 意图 → L3 旁观者（动态）
 *
 * 稳定前缀里不出现时间戳、job id、拍 id；工具只走 API 的 tools 数组。
 */

export interface AgentPrompt {
  key: AgentKey
  title: string
  prefix: string
  contract: string
}

export const AGENT_PROMPTS: Record<AgentKey, AgentPrompt> = {
  planner: PLANNER_PROMPT,
  orchestrator: ORCHESTRATOR_PROMPT,
  character: CHARACTER_PROMPT,
  narrator: NARRATOR_PROMPT,
  reviewer: REVIEWER_PROMPT,
  memory: MEMORY_PROMPT
}

/** 提示词版本：内容一变，job 的 prompt_version 就变，便于回放定位。 */
export const PROMPT_VERSION = sha256Hex(
  Object.values(AGENT_PROMPTS)
    .map((prompt) => `${prompt.key}:${prompt.prefix}\n${prompt.contract}`)
    .sort()
    .join('\n---\n')
)

export interface RenderPromptInput {
  agentKey: AgentInstanceKey
  bundle: ContextBundle
  /** 模型不支持工具调用时，用 JSON 回退协议替换最终答复契约。 */
  jsonFallback?: boolean
}

export interface RenderedPrompt {
  messages: ChatMessage[]
  system: string
  user: string
  prefixHash: string
}

function layerRank(block: CtxBlock): number {
  return block.layer === 'L0' ? 0 : block.layer === 'L1' ? 1 : 2
}

function renderBlocks(blocks: readonly CtxBlock[]): string {
  return [...blocks]
    .sort(
      (left, right) =>
        layerRank(left) - layerRank(right) ||
        left.priority - right.priority ||
        left.id.localeCompare(right.id)
    )
    .map((block) => `[${block.id}]\n${block.text}`)
    .join('\n\n')
}

export function renderPrompt(input: RenderPromptInput): RenderedPrompt {
  const agent = baseAgentOf(input.agentKey)
  const prompt = AGENT_PROMPTS[agent]
  if (!prompt) throw new Error(`未知 Agent 提示词：${agent}`)

  const stableBlocks = input.bundle.blocks.filter((block) => block.layer === 'L0' || block.layer === 'L1')
  const dynamicBlocks = input.bundle.blocks.filter((block) => block.layer !== 'L0' && block.layer !== 'L1')

  const sections = [
    prompt.prefix,
    input.jsonFallback ? FALLBACK_INSTRUCTION : prompt.contract,
    TOOL_MATERIAL_RULE
  ]
  const stableText = renderBlocks(stableBlocks)
  if (stableText.length > 0) sections.push(`[上下文·稳定]\n${stableText}`)

  const system = sections.join('\n\n')
  const dynamicText = renderBlocks(dynamicBlocks)
  const task =
    agent === 'character' || agent === 'narrator'
      ? '现在按输出契约给出本拍结果。'
      : '现在按输出契约给出结果。'
  const user = [dynamicText, task].filter((part) => part.length > 0).join('\n\n')

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    system,
    user,
    prefixHash: sha256Hex(system)
  }
}
