import { AppError } from '../../shared/domain/app-error'
import { parseCharacterCard } from '../../shared/schema/plan'
import { estimateTokens } from '../context/tokens'
import type { Repos } from '../db/repos'
import type { WriteMessageRecord } from '../db/repos/write'
import type { ChatAdapter, ChatMessage, ChatResult, ChatToolCall } from '../model/adapter'
import type { RegistrySnapshot } from '../tools/registry'
import { RepoAuditSink } from '../tools/audit'
import { TurnBudget } from '../tools/budget'
import { RepoIdempotencyStore } from '../tools/idempotency'
import { invokeTool, type TurnContext } from '../tools/invoke'
import { resolveToolset } from '../tools/resolve'
import type { ToolResult, ToolServices } from '../tools/types'
import { TurnRefRegistry } from '../tools/turn-refs'
import { ORCHESTRATE_ANSWER_CONTRACT, TOOL_MATERIAL_RULE } from '../agents/prompts/contract'
import { ORCHESTRATOR_PROMPT } from '../agents/prompts/orchestrator'
import { readStoryboardDraft } from './storyboard'

/**
 * 编排对话（PHASE-07 F1 / UI-DESIGN §5.3）。
 *
 * 与单拍 runTurn 的差异：没有 beat，输出是自然语言；只改分镜草案（T34），
 * 不写正文。调度器不在这里发牌——编排说不等于系统演。
 */

export interface OrchestratorDeps {
  repos: Repos
  registry: RegistrySnapshot
  adapter: ChatAdapter
  gateSecret: string
  allowTools?: boolean
  signal?: AbortSignal
  maxRounds?: number
  maxHistoryTokens?: number
  hooks?: {
    onText?: (delta: string, full: string) => void
    onToolCall?: (call: ChatToolCall, result: ToolResult) => void
  }
}

export interface OrchestratorOutcome {
  reply: string
  toolCalls: number
  storyboardUpdated: boolean
  rounds: number
}

const DEFAULT_MAX_ROUNDS = 4
const DEFAULT_HISTORY_TOKENS = 5_000

function chapterBrief(repos: Repos, chapterId: string): string {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) return '（章节缺失）'
  const node = repos.outline.get(chapter.outlineNodeId)
  return [
    `- 章：第 ${chapter.ord} 章「${node?.title ?? '（未命名）'}」`,
    `- 章状态：${chapter.status}`,
    `- 章纲：${node?.content?.trim().slice(0, 400) || '（空）'}`
  ].join('\n')
}

function castText(repos: Repos, projectId: string): string {
  const characters = repos.character.list(projectId)
  if (characters.length === 0) return '（还没有角色）'
  return characters
    .slice(0, 12)
    .map((character) => {
      const card = parseCharacterCard(character.cardJson)
      const voice = [card.voice.sentence_length, card.voice.catchphrase].filter((part) => part.trim().length > 0).join('；')
      return `- ${character.id}「${character.name}」欲望：${card.want || '空'}；恐惧：${card.fear || '空'}；禁忌：${card.taboo || '空'}；语气：${voice || '空'}`
    })
    .join('\n')
}

function storyboardText(repos: Repos, chapterId: string): string {
  const draft = readStoryboardDraft(repos, chapterId)
  if (!draft) return '（本章还没有分镜草案；需要先提案）'
  const lines = draft.scenes.map((scene, index) => {
    const exit = typeof scene.exit === 'string' ? scene.exit : JSON.stringify(scene.exit ?? null)
    const beats = scene.beats
      .map((beat, beatIndex) => `    ${beatIndex + 1}. ${beat.speaker_type}:${beat.speaker_id} — ${beat.intent.slice(0, 60)}`)
      .join('\n')
    return [
      `  场景 ${index + 1}（${scene.location}）：${scene.goal}`,
      `    在场者：${scene.participants.join('、')}`,
      `    出口：${exit}`,
      beats
    ].join('\n')
  })
  return [`（草案 rev ${draft.rev}）`, ...lines].join('\n')
}

function progressText(repos: Repos, chapterId: string): string {
  const scenes = repos.scene.listByChapter(chapterId)
  if (scenes.length === 0) return '（还没开演）'
  return scenes
    .map((entry) => {
      const beats = repos.beat.listLiveByScene(entry.scene.id)
      const confirmed = beats.filter((beat) => beat.status === 'confirmed' || beat.status === 'author_edited').length
      return `- 场景 ${entry.chapterOrd} ${entry.scene.location}：${confirmed}/${beats.length} 拍已确认，状态 ${entry.scene.status}`
    })
    .join('\n')
}

export function buildOrchestratorPrompt(repos: Repos, chapterId: string): string {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${chapterId} not found`)
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')
  return [
    ORCHESTRATOR_PROMPT.prefix,
    ORCHESTRATE_ANSWER_CONTRACT,
    TOOL_MATERIAL_RULE,
    '',
    '【项目】',
    `${project.title}（${project.genre || '未填'}，${project.pov}）`,
    '',
    '【本章】',
    chapterBrief(repos, chapterId),
    '',
    '【角色】',
    castText(repos, project.id),
    '',
    '【分镜草案】',
    storyboardText(repos, chapterId),
    '',
    '【进度】',
    progressText(repos, chapterId),
    '',
    '【规则】',
    '- 只讨论场次、节奏、在场者与出口条件；不改正文、不替角色说话。',
    '- 结构改动必须调用 storyboard.propose；不要用文字描述代替工具调用。',
    '- 出口条件必须是 DSL：fact(...) / rel(from, to, axis, cmp, value) / beats(n) / all / any / not。'
  ].join('\n')
}

function historyMessages(
  messages: readonly WriteMessageRecord[],
  maxTokens: number
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const usable = messages.filter((message) => message.role !== 'system' && message.body.trim().length > 0)
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

function toolPayload(result: ToolResult): string {
  return JSON.stringify({
    data: result.data ?? null,
    refs: result.refs,
    degraded: result.degraded,
    truncated: result.truncated,
    ...(result.error === undefined ? {} : { error: result.error })
  })
}

export async function runOrchestratorTurn(
  deps: OrchestratorDeps,
  input: { chapterId: string; messageId: string; text: string }
): Promise<OrchestratorOutcome> {
  const chapter = deps.repos.chapter.get(input.chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
  const project = deps.repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')

  const system = buildOrchestratorPrompt(deps.repos, chapter.id)
  const history = historyMessages(
    deps.repos.writeMessage.listByChapter(chapter.id),
    deps.maxHistoryTokens ?? DEFAULT_HISTORY_TOKENS
  )
  const chat: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: input.text }
  ]

  const toolset = resolveToolset('orchestrator', {}, deps.registry)
  const tools = deps.allowTools === false ? [] : toolset.toModelTools()
  const services: ToolServices = { repos: deps.repos, now: () => Date.now() }
  const turnContext: TurnContext = {
    projectId: project.id,
    jobId: `write_${chapter.id}`,
    turnId: `oturn_${input.messageId}`,
    actorId: 'orchestrator',
    characterId: null,
    asOf: project.seqHead,
    epoch: project.writeEpoch,
    expectedRevision: chapter.currentRevisionId,
    gateToken: null,
    chapterId: chapter.id,
    beatId: null,
    mode: 'interactive'
  }

  const budget = new TurnBudget('orchestrator')
  const audit = new RepoAuditSink(deps.repos.toolCall)
  const idempotency = new RepoIdempotencyStore(deps.repos.toolCall)
  const turnRefs = new TurnRefRegistry()

  let toolCalls = 0
  let storyboardUpdated = false

  for (let round = 0; round < (deps.maxRounds ?? DEFAULT_MAX_ROUNDS); round += 1) {
    let roundText = ''
    const result: ChatResult = await deps.adapter.stream(
      {
        messages: chat,
        stream: true,
        ...(tools.length > 0 ? { tools, toolChoice: 'auto' as const } : {}),
        temperature: 0.6,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        meta: { agentKey: 'orchestrator' }
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
      return {
        reply: roundText.length > 0 ? roundText : result.text,
        toolCalls,
        storyboardUpdated,
        rounds: round + 1
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
      if (call.name === 'storyboard.propose' && toolResult.ok) storyboardUpdated = true
      deps.hooks?.onToolCall?.(call, toolResult)
      chat.push({
        role: 'tool',
        content: `<tool_result tool="${call.name}" call_id="${call.id}" ok="${String(toolResult.ok)}">\n${toolPayload(toolResult)}\n</tool_result>`
      })
    }
  }

  throw new AppError('tool_protocol_error', '编排对话的工具轮数超过上限')
}
