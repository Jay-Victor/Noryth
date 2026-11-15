import { AppError } from '../../shared/domain/app-error'
import type { ChapterRecord } from '../db/repos/chapter'
import type { Repos } from '../db/repos'
import type { Db } from '../db/project-db'
import { newId } from '../db/repos/common'
import type { ChatAdapter, ChatMessage, ChatResult, ChatToolCall } from '../model/adapter'
import type { CapabilitiesLookup } from '../model/bindings'
import type { RegistrySnapshot } from '../tools/registry'
import { RepoAuditSink } from '../tools/audit'
import { TurnBudget } from '../tools/budget'
import { RepoIdempotencyStore } from '../tools/idempotency'
import { invokeTool, type TurnContext } from '../tools/invoke'
import { resolveToolset } from '../tools/resolve'
import { TurnRefRegistry } from '../tools/turn-refs'
import type { ToolResult, ToolServices } from '../tools/types'
import { MEMORY_ANSWER_CONTRACT, TOOL_MATERIAL_RULE } from '../agents/prompts/contract'
import { MEMORY_PROMPT } from '../agents/prompts/memory'
import { resolveChapterAsOf } from '../context/sources'
import type { Embedder } from './embed/types'
import { buildExtractionInput, parseProposalJson, submitProposalItems, type SubmitProposalsResult } from './extract'

/**
 * 记忆运行时（PHASE-09 H1/H2）。
 *
 * 与审批运行时同构：没有 beat，工具集是 memory 基线，输出是提案而不是正文。
 * 差异：
 *   - 输入只取定稿快照（revision_manifest），提示词里就带 `[beat_id]` 与原文；
 *   - 提案落库走 `submitProposalItems`（证据 + 分类的同一收口）；
 *   - **永不写记忆库**：memory.apply 只由作者 G7 触发。
 *
 * 两种模式：
 *   extract 抽取固化提案（定稿后自动/手动）
 *   discuss 作者追问来源、为什么重要、与哪条冲突；不改库
 */

export type MemoryTurnMode = 'extract' | 'discuss'

export interface MemoryTurnDeps {
  db: Db
  repos: Repos
  registry: RegistrySnapshot
  adapter: ChatAdapter
  capabilitiesLookup?: CapabilitiesLookup
  embedder?: Embedder | null
  gateSecret?: string
  signal?: AbortSignal
  maxRounds?: number
  hooks?: {
    onText?: (delta: string, full: string) => void
    onToolCall?: (call: ChatToolCall, result: ToolResult) => void
  }
}

export interface MemoryTurnOptions {
  chapterId: string
  jobId: string
  mode: MemoryTurnMode
  text?: string
  messageId?: string
  /** 抽取必须绑定定稿 revision（job.expected_revision）。 */
  revisionId?: string
}

export interface MemoryTurnOutcome {
  turnId: string
  reply: string
  toolCalls: number
  itemCount: number
  dropped: SubmitProposalsResult['dropped']
  downgraded: SubmitProposalsResult['downgraded']
  mismatches: number
  degraded: string | null
}

function requireFinalChapter(repos: Repos, chapterId: string): { chapter: ChapterRecord; revisionId: string } {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} not found`)
  if (chapter.status !== 'finalized' || chapter.finalRevisionId === null) {
    throw new AppError('invalid_args', '只有定稿章节才能抽取记忆', { status: chapter.status })
  }
  return { chapter, revisionId: chapter.finalRevisionId }
}

function beatBlock(repos: Repos, chapterId: string): string {
  const input = buildExtractionInput(repos, chapterId)
  if (input.beats.length === 0) return '（定稿为空）'
  return input.beats
    .map((beat) => {
      const name =
        beat.speakerType === 'narrator' ? '旁白' : (repos.character.get(beat.speakerId)?.name ?? beat.speakerId)
      return `[${beat.id}] ${name}：${beat.body}`
    })
    .join('\n')
}

function castBlock(repos: Repos, chapterId: string): string {
  const input = buildExtractionInput(repos, chapterId)
  if (input.characters.length === 0) return '（还没有注册角色）'
  return input.characters
    .map((character) => `- ${character.id}「${character.name}」卡：${character.cardJson.slice(0, 240)}`)
    .join('\n')
}

function stateBlock(repos: Repos, chapterId: string): string {
  const input = buildExtractionInput(repos, chapterId)
  const lines: string[] = []
  lines.push('【已有客观事实】')
  lines.push(
    input.facts.length === 0
      ? '（暂无）'
      : input.facts
          .slice(0, 24)
          .map((fact) => `- ${fact.id}｜${fact.subject}｜${fact.predicate}｜${fact.object}${fact.validToSeq === null ? '' : `（已失效于 ${fact.validToSeq}）`}`)
          .join('\n')
  )
  lines.push('', '【已有角色信念】')
  lines.push(
    input.beliefs.length === 0
      ? '（暂无）'
      : input.beliefs
          .slice(0, 24)
          .map((belief) => `- ${belief.characterId}｜${belief.text}`)
          .join('\n')
  )
  lines.push('', '【已有关系边】')
  lines.push(
    input.edges.length === 0
      ? '（暂无）'
      : input.edges
          .slice(0, 24)
          .map((edge) => `- ${edge.fromId}→${edge.toId}｜${edge.axis}｜${edge.value}`)
          .join('\n')
  )
  lines.push('', '【已有记忆摘要】（避免重复提）')
  const memories = input.characters.flatMap((character) =>
    repos.memory
      .listByCharacter(character.id, { status: 'active' })
      .slice(-10)
      .map((entry) => `- ${character.name}｜${entry.kind}｜${entry.text.slice(0, 80)}`)
  )
  lines.push(memories.length === 0 ? '（暂无）' : memories.join('\n'))
  return lines.join('\n')
}

export function buildMemoryPrompt(
  repos: Repos,
  input: { chapterId: string; mode: MemoryTurnMode }
): string {
  const { chapter } = requireFinalChapter(repos, input.chapterId)
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')
  const node = repos.outline.get(chapter.outlineNodeId)
  const task =
    input.mode === 'extract'
      ? [
          '【本轮任务】记忆固化抽取',
          '- 逐条读完定稿，产出可审阅的固化提案：新增记忆、事实/声称、关系变化。',
          '- 每条必须带 source_beat_id 与 evidence_quote（原文连续子串）。',
          '- 台词只能进 belief 或 world_fact(truth="claim")；objective 事实只从旁白叙述来。',
          '- 用 memory.proposal.submit 提交一次；所有条目一次给出。'
        ].join('\n')
      : [
          '【本轮任务】记忆台讨论',
          '- 解释提案来源、为什么重要、与哪条既有记忆冲突。',
          '- 回答引用章节标题与 [beat_id]；不要提出新的写入，也不要调用 memory.apply。',
          '- 不超过 6 句。'
        ].join('\n')
  return [
    MEMORY_PROMPT.prefix,
    MEMORY_ANSWER_CONTRACT,
    TOOL_MATERIAL_RULE,
    '',
    '【项目】',
    `${project.title}（${project.genre || '未填'}，${project.pov}）`,
    '',
    '【本章】',
    `- 第 ${chapter.ord} 章「${node?.title ?? '（未命名）'}」`,
    `- 状态：${chapter.status}；定稿 revision：${chapter.finalRevisionId ?? '（无）'}`,
    '',
    '【定稿正文】（beat_id｜说话人｜正文）',
    beatBlock(repos, input.chapterId),
    '',
    '【角色】',
    castBlock(repos, input.chapterId),
    '',
    stateBlock(repos, input.chapterId),
    '',
    task
  ].join('\n')
}

function historyMessages(repos: Repos, chapterId: string, maxMessages = 10): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = repos.memoryMessage
    .list(repos.project.get()?.id ?? '', chapterId, maxMessages)
    .filter((message) => message.role !== 'system' && message.body.trim().length > 0)
  return messages.map((message) => ({
    role: message.role === 'author' ? 'user' : 'assistant',
    content: message.body
  }))
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

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** 允许 ```json 包裹与前后解释；与审批台同一策略。 */
export function extractProposalJsonText(text: string): unknown | null {
  const trimmed = text.trim()
  if (trimmed.length === 0) return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed
  const direct = tryParse(candidate)
  if (direct !== null) return direct
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return tryParse(candidate.slice(start, end + 1))
}

export async function runMemoryTurn(
  deps: MemoryTurnDeps,
  options: MemoryTurnOptions
): Promise<MemoryTurnOutcome> {
  const repos = deps.repos
  const { chapter, revisionId } = requireFinalChapter(repos, options.chapterId)
  if (options.revisionId !== undefined && options.revisionId !== revisionId) {
    throw new AppError('stale_revision', 'job 绑定的 revision 不是当前定稿', {
      expected: revisionId,
      actual: options.revisionId
    })
  }
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')

  const system = buildMemoryPrompt(repos, { chapterId: chapter.id, mode: options.mode })
  const userText =
    options.text?.trim() ||
    (options.mode === 'extract' ? '请从这份定稿中抽取记忆固化提案。' : '请解释这些提案。')

  const chat: ChatMessage[] = [
    { role: 'system', content: system },
    ...historyMessages(repos, chapter.id),
    { role: 'user', content: userText }
  ]

  const toolset = resolveToolset('memory', {}, deps.registry)
  const tools = toolset.toModelTools()
  const services: ToolServices = {
    repos,
    now: () => Date.now(),
    ...(deps.embedder === undefined || deps.embedder === null ? {} : { embedder: deps.embedder })
  }

  const turnId = `memturn_${options.messageId ?? newId('msg')}`
  const turnContext: TurnContext = {
    projectId: project.id,
    jobId: options.jobId,
    turnId,
    actorId: 'memory',
    characterId: null,
    asOf: resolveChapterAsOf(repos, chapter, 'write'),
    epoch: project.writeEpoch,
    expectedRevision: revisionId,
    gateToken: null,
    chapterId: chapter.id,
    beatId: null,
    mode: 'batch'
  }

  const budget = new TurnBudget('memory')
  const audit = new RepoAuditSink(repos.toolCall)
  const idempotency = new RepoIdempotencyStore(repos.toolCall)
  const turnRefs = new TurnRefRegistry()

  let toolCalls = 0
  let toolSubmitted = false
  let finalText = ''
  let submitOutcome: SubmitProposalsResult | null = null

  for (let round = 0; round < (deps.maxRounds ?? 4); round += 1) {
    let roundText = ''
    const result: ChatResult = await deps.adapter.stream(
      {
        messages: chat,
        stream: true,
        ...(tools.length > 0 ? { tools, toolChoice: 'auto' as const } : {}),
        temperature: options.mode === 'discuss' ? 0.5 : 0.2,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        meta: { agentKey: 'memory' }
      },
      {
        onText: (delta, text) => {
          roundText = text
          deps.hooks?.onText?.(delta, text)
        },
        onReset: () => {
          roundText = ''
        }
      }
    )

    if (result.toolCalls.length === 0) {
      finalText = roundText.length > 0 ? roundText : result.text
      break
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
      const parsed = tryParse(call.arguments.trim().length === 0 ? '{}' : call.arguments) ?? {}
      const toolResult = await invokeTool(
        { callId: call.id, tool: call.name, args: parsed },
        turnContext,
        { toolset, budget, audit, idempotency, gateSecret: deps.gateSecret ?? 'memory-run', turnRefs },
        services
      )
      toolCalls += 1
      if (call.name === 'memory.proposal.submit' && toolResult.ok) {
        toolSubmitted = true
        const data = toolResult.data as
          | { item_count?: unknown; dropped?: unknown; downgraded?: unknown; mismatches?: unknown }
          | null
        submitOutcome = {
          inserted: [],
          dropped: Array.isArray(data?.dropped) ? (data.dropped as SubmitProposalsResult['dropped']) : [],
          downgraded: Array.isArray(data?.downgraded) ? (data.downgraded as SubmitProposalsResult['downgraded']) : [],
          mismatches: typeof data?.mismatches === 'number' ? data.mismatches : 0
        }
      }
      deps.hooks?.onToolCall?.(call, toolResult)
      chat.push({
        role: 'tool',
        content: `<tool_result tool="${call.name}" call_id="${call.id}" ok="${String(toolResult.ok)}">\n${toolPayload(toolResult)}\n</tool_result>`
      })
    }
  }

  let degraded: string | null = null
  if (options.mode === 'extract' && !toolSubmitted) {
    const parsed = extractProposalJsonText(finalText)
    const items = parseProposalJson(parsed)
    if (items === null || items.length === 0) {
      degraded = 'schema_fallback'
    } else {
      submitOutcome = submitProposalItems(repos, {
        projectId: project.id,
        jobId: options.jobId,
        chapterId: chapter.id,
        revisionId,
        actor: 'memory',
        items
      })
    }
  }

  const stored = repos.memoryProposal.listByJob(project.id, options.jobId)
  return {
    turnId,
    reply: finalText,
    toolCalls,
    itemCount: stored.length,
    dropped: submitOutcome?.dropped ?? [],
    downgraded: submitOutcome?.downgraded ?? [],
    mismatches: submitOutcome?.mismatches ?? 0,
    degraded
  }
}

/**
 * Key 解析统一在 `model/keys.ts`（设置页 safeStorage 优先，环境变量兜底）；
 * 记忆台不再维护第二份实现，避免两套口径。
 */
