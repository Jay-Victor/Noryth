import { AppError } from '../../shared/domain/app-error'
import type { PlanMessageMeta } from '../../shared/schema/plan'
import { estimateTokens } from '../context/tokens'
import type { Repos } from '../db/repos'
import type { PlanMessageRecord } from '../db/repos/plan'
import type { ChatAdapter, ChatMessage, ChatResult, ChatToolCall } from '../model/adapter'
import type { RegistrySnapshot } from '../tools/registry'
import { RepoAuditSink } from '../tools/audit'
import { TurnBudget } from '../tools/budget'
import { RepoIdempotencyStore } from '../tools/idempotency'
import { invokeTool, type TurnContext } from '../tools/invoke'
import { resolveToolset } from '../tools/resolve'
import type { ToolResult, ToolServices, ChoiceResolver } from '../tools/types'
import { TurnRefRegistry } from '../tools/turn-refs'
import { PLAN_ANSWER_CONTRACT, TOOL_MATERIAL_RULE } from '../agents/prompts/contract'
import { PLANNER_PROMPT } from '../agents/prompts/planner'
import { parseCharacterCard, missingVoiceFields, VOICE_LABELS } from '../../shared/schema/plan'

/**
 * 规划会话运行时（PHASE-06 E1）。
 *
 * 与单拍 runTurn 的差异：
 * - 没有 chapter/beat，上下文来自项目蓝图、角色卡、公共设定与会话历史；
 * - 输出是自然语言，不套信封；提案只通过工具写 `agent_proposal`；
 * - 模型不可用时降级为「仅讨论」，不伪造提案。
 */

export interface PlanRuntimeDeps {
  repos: Repos
  registry: RegistrySnapshot
  adapter: ChatAdapter
  gateSecret: string
  /** 模型能力：tools=false 时只讨论，不传 tools，也不假装提交提案。 */
  allowTools?: boolean
  /** T42 作者选择通道；未挂载时工具返回 tool_unavailable。 */
  choices?: ChoiceResolver
  maxRounds?: number
  maxHistoryTokens?: number
  signal?: AbortSignal
  hooks?: {
    onText?: (delta: string, full: string) => void
    onToolCall?: (call: ChatToolCall, result: ToolResult) => void
    onRetryReset?: () => void
  }
}

export interface PlanRunInput {
  sessionId: string
  assistantMessageId: string
}

export interface PlanRunOutcome {
  text: string
  proposalIds: string[]
  label: 'discussion' | 'draft'
  meta: PlanMessageMeta
  toolCalls: number
  rounds: number
}

const DEFAULT_MAX_ROUNDS = 4
const DEFAULT_HISTORY_TOKENS = 6_000

function outlineText(repos: Repos, projectId: string): string {
  const nodes = repos.outline.listByProject(projectId)
  if (nodes.length === 0) return '（还没有大纲节点）'
  const childrenOf = (parentId: string | null) =>
    nodes.filter((node) => node.parentId === parentId).sort((left, right) => left.ord - right.ord)
  const lines: string[] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const node of childrenOf(parentId)) {
      const content = node.content.trim().length > 0 ? ` — ${node.content.trim().slice(0, 160)}` : ''
      lines.push(`${'  '.repeat(depth)}- [${node.kind}] ${node.title}（${node.status}）${content}`)
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  return lines.join('\n')
}

function characterText(repos: Repos, projectId: string): string {
  const characters = repos.planCharacter.listByProject(projectId)
  if (characters.length === 0) return '（还没有角色卡）'
  return characters
    .map((character) => {
      const card = parseCharacterCard(character.cardJson)
      const missing = missingVoiceFields(card)
      const voice = missing.length === 0 ? 'voice 齐全' : `缺 voice：${missing.map((key) => VOICE_LABELS[key]).join('、')}`
      return [
        `- ${character.name}（card v${character.cardVersion}，${voice}）`,
        `  身份：${card.identity || '（空）'}`,
        `  欲望：${card.want || '（空）'}；恐惧：${card.fear || '（空）'}；禁忌：${card.taboo || '（空）'}`
      ].join('\n')
    })
    .join('\n')
}

function factText(repos: Repos, projectId: string): string {
  const facts = repos.planFact.listByProject(projectId)
  if (facts.length === 0) return '（还没有世界初值）'
  return facts
    .map((fact) => `- ${fact.subject} / ${fact.predicate} = ${fact.object}（${fact.visibility}）`)
    .join('\n')
}

export function buildPlanSystemPrompt(repos: Repos, projectId: string): string {
  const project = repos.project.getById(projectId)
  if (!project) throw new AppError('project_not_found', 'project row missing')
  return [
    PLANNER_PROMPT.prefix,
    PLAN_ANSWER_CONTRACT,
    TOOL_MATERIAL_RULE,
    '',
    '【项目】',
    `标题：${project.title}`,
    `题材：${project.genre || '（未填）'}；视角：${project.pov}；目标篇幅：${project.targetWords ?? '（未定）'}`,
    `G1：${project.blueprintLockedAt === null ? '未确认' : `已确认（v${project.blueprintVersion}）`}`,
    '',
    '【蓝图】',
    outlineText(repos, projectId),
    '',
    '【角色卡】',
    characterText(repos, projectId),
    '',
    '【世界初值】',
    factText(repos, projectId)
  ].join('\n')
}

function historyMessages(
  messages: readonly PlanMessageRecord[],
  assistantMessageId: string,
  maxTokens: number
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const usable = messages.filter(
    (message) =>
      message.id !== assistantMessageId &&
      message.role !== 'system' &&
      message.body.trim().length > 0 &&
      (message.status === 'done' || message.status === 'stopped')
  )
  const selected: Array<{ role: 'user' | 'assistant'; content: string }> = []
  let total = 0
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    const message = usable[index]!
    const content = message.body.trim()
    const tokens = estimateTokens(content)
    if (selected.length > 0 && total + tokens > maxTokens) break
    selected.unshift({ role: message.role === 'author' ? 'user' : 'assistant', content })
    total += tokens
  }
  return selected
}

function proposalIdsOf(result: ToolResult): string[] {
  if (!result.ok || result.data === null || typeof result.data !== 'object') return []
  const data = result.data as Record<string, unknown>
  const ids: string[] = []
  for (const key of ['proposal_id', 'card_draft_id', 'roster_id']) {
    const value = data[key]
    if (typeof value === 'string' && value.length > 0) ids.push(value)
  }
  return ids
}

function toolPayload(result: ToolResult): string {
  return JSON.stringify({
    data: result.data ?? null,
    refs: result.refs,
    degraded: result.degraded,
    truncated: result.truncated,
    ...(result.error === undefined ? {} : { error: result.error })
  })
}

export async function runPlanMessage(deps: PlanRuntimeDeps, input: PlanRunInput): Promise<PlanRunOutcome> {
  const project = deps.repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')

  const system = buildPlanSystemPrompt(deps.repos, project.id)
  const messages = deps.repos.planMessage.listBySession(input.sessionId)
  const history = historyMessages(messages, input.assistantMessageId, deps.maxHistoryTokens ?? DEFAULT_HISTORY_TOKENS)
  const chat: ChatMessage[] = [{ role: 'system', content: system }, ...history]

  const toolset = resolveToolset('planner', {}, deps.registry)
  const tools = deps.allowTools === false ? [] : toolset.toModelTools()
  const services: ToolServices = {
    repos: deps.repos,
    now: () => Date.now(),
    ...(deps.choices === undefined ? {} : { choices: deps.choices })
  }
  const turnContext: TurnContext = {
    projectId: project.id,
    jobId: `plan_${input.sessionId}`,
    turnId: `pturn_${input.assistantMessageId}`,
    actorId: 'planner',
    characterId: null,
    asOf: project.seqHead,
    epoch: project.writeEpoch,
    expectedRevision: null,
    gateToken: null,
    chapterId: null,
    beatId: null,
    mode: 'interactive'
  }
  const budget = new TurnBudget('planner')
  const audit = new RepoAuditSink(deps.repos.toolCall)
  const idempotency = new RepoIdempotencyStore(deps.repos.toolCall)
  const turnRefs = new TurnRefRegistry()

  let toolCalls = 0
  let rounds = 0
  const proposalIds: string[] = []

  for (let round = 0; round < (deps.maxRounds ?? DEFAULT_MAX_ROUNDS); round += 1) {
    rounds += 1
    let roundText = ''
    const result: ChatResult = await deps.adapter.stream(
      {
        messages: chat,
        stream: true,
        ...(tools.length > 0 ? { tools, toolChoice: 'auto' as const } : {}),
        temperature: 0.7,
        signal: deps.signal,
        meta: { agentKey: 'planner' }
      },
      {
        onText: (delta, text) => {
          roundText = text
          deps.hooks?.onText?.(delta, text)
        },
        onReset: () => {
          roundText = ''
          deps.hooks?.onRetryReset?.()
        }
      }
    )

    if (result.toolCalls.length === 0) {
      const uniqueProposalIds = [...new Set(proposalIds)]
      return {
        text: roundText.length > 0 ? roundText : result.text,
        proposalIds: uniqueProposalIds,
        label: uniqueProposalIds.length > 0 ? 'draft' : 'discussion',
        meta: {
          label: uniqueProposalIds.length > 0 ? 'draft' : 'discussion',
          ...(uniqueProposalIds.length > 0 ? { proposal_ids: uniqueProposalIds } : {}),
          usage: {
            tokens_in: result.usage?.promptTokens ?? null,
            tokens_out: result.usage?.completionTokens ?? null
          },
          model: result.model
        },
        toolCalls,
        rounds
      }
    }

    chat.push({
      role: 'assistant',
      content: result.text,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments }
      }))
    } as never)

    for (const call of result.toolCalls) {
      const parsed = ((): unknown => {
        try {
          return JSON.parse(call.arguments.trim().length === 0 ? '{}' : call.arguments)
        } catch {
          return {}
        }
      })()
      const toolResult = await invokeTool(
        { callId: call.id, tool: call.name, args: parsed },
        turnContext,
        { toolset, budget, audit, idempotency, gateSecret: deps.gateSecret, turnRefs },
        services
      )
      toolCalls += 1
      proposalIds.push(...proposalIdsOf(toolResult))
      deps.hooks?.onToolCall?.(call, toolResult)
      chat.push({
        role: 'tool',
        content: `<tool_result tool="${call.name}" call_id="${call.id}" ok="${String(toolResult.ok)}">\n${toolPayload(toolResult)}\n</tool_result>`
      })
    }
  }

  throw new AppError('tool_protocol_error', '规划对话的工具轮数超过上限')
}
