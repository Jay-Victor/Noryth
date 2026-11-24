import { AppError } from '../../shared/domain/app-error'
import type { DimensionKey, ReportDraft } from '../../shared/schema/report'
import { DIMENSION_LABELS, DimensionKeySchema, ReportDraftSchema, dimensionsForBlocking } from '../../shared/schema/report'
import { resolveChapterAsOf } from '../context/sources'
import type { ChapterRecord } from '../db/repos/chapter'
import type { PatchRecord } from '../db/repos/patch'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { newId } from '../db/repos/common'
import type { ChatAdapter, ChatMessage, ChatResult, ChatToolCall } from '../model/adapter'
import { resolveBinding, type CapabilitiesLookup } from '../model/bindings'
import type { RoutingTrace } from '../../shared/schema/routing'
import { capabilitiesFor } from '../model/presets'
import { promptTokensOf, recordTurnMetric, simpleContextJson, sumUsages } from '../model/usage'
import { PROMPT_VERSION } from '../agents/prompts'
import type { RegistrySnapshot } from '../tools/registry'
import { RepoAuditSink } from '../tools/audit'
import { TurnBudget } from '../tools/budget'
import { RepoIdempotencyStore } from '../tools/idempotency'
import { invokeTool, type TurnContext } from '../tools/invoke'
import { resolveToolset } from '../tools/resolve'
import { TurnRefRegistry } from '../tools/turn-refs'
import type { ToolResult, ToolServices } from '../tools/types'
import { REVIEW_ANSWER_CONTRACT, TOOL_MATERIAL_RULE } from '../agents/prompts/contract'
import { REVIEWER_PROMPT } from '../agents/prompts/reviewer'
import { latestReport, parseReportRecord, submitPlainReport, submitReport } from './report'

/**
 * 审批运行时（PHASE-08 G1/G2/G4）。
 *
 * 与单拍 runTurn 的差异：没有 beat，工具集是 reviewer 基线，输出是报告/建议/patch。
 * 与编排对话的差异：它可以写 approval_report 与 patch（提案表），但**永远不写正文**：
 * 正文只由 DocController 在作者逐条接受后落盘。
 *
 * 四种模式：
 *   report  全量报告（G4）
 *   recheck 只跑受影响维度（G4 复检），scope 写进 approval_report
 *   patch   产出 patch 提案（需要 G5 令牌；T36 由 invoke 校验）
 *   discuss 讨论；不改稿、不出新报告
 */

export type ReviewTurnMode = 'report' | 'recheck' | 'patch' | 'discuss'

export interface ReviewTurnDeps {
  db: Db
  repos: Repos
  registry: RegistrySnapshot
  adapter: ChatAdapter
  /** 审批本次实际使用的绑定（PHASE-16 §5.3）；省略 = 配置的 reviewer 绑定。 */
  binding?: { provider: string; model: string }
  /** 异构缺失等运行级降级：写进报告 degraded（不阻断）。 */
  heteroDegraded?: string | null
  /** 路由切换留痕（PHASE-21）：写进 context_json.routing；异构直选第二家时为 null。 */
  routingTrace?: RoutingTrace | null
  gateSecret: string
  capabilitiesLookup?: CapabilitiesLookup
  signal?: AbortSignal
  maxRounds?: number
  hooks?: {
    onText?: (delta: string, full: string) => void
    onToolCall?: (call: ChatToolCall, result: ToolResult) => void
  }
}

export interface ReviewTurnOptions {
  chapterId: string
  /** 消息行 id；turn_id 由它派生，流式事件与审计用它对齐。 */
  messageId: string
  mode: ReviewTurnMode
  scope?: readonly DimensionKey[]
  text?: string
  /** patch 模式必须由服务先建 job（G5 令牌绑定 job_id）。 */
  jobId?: string
  gateToken?: string | null
}

export interface ReviewTurnOutcome {
  jobId: string
  turnId: string
  reply: string
  toolCalls: number
  rounds: number
  reportId: string | null
  patchIds: string[]
  /** 报告是否降级（schema 失败）。 */
  degraded: string | null
}

const DEFAULT_MAX_ROUNDS = 4

function chapterBrief(repos: Repos, chapter: ChapterRecord): string {
  const node = repos.outline.get(chapter.outlineNodeId)
  return [
    `- 章：第 ${chapter.ord} 章「${node?.title ?? '（未命名）'}」`,
    `- 章状态：${chapter.status}`,
    `- 当前 revision：${chapter.currentRevisionId ?? '（无）'}`,
    `- 章纲：${node?.content?.trim() || '（空）'}`
  ].join('\n')
}

function castText(repos: Repos, projectId: string): string {
  const characters = repos.character.list(projectId)
  if (characters.length === 0) return '（还没有注册角色）'
  return characters
    .slice(0, 16)
    .map((character) => `- ${character.id}「${character.name}」卡：${character.cardJson.slice(0, 300)}`)
    .join('\n')
}

/** 初稿块：beat_id 必须在提示词里可见，模型才能给出可定位的 issue。 */
export function draftBlock(repos: Repos, chapterId: string): string {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter || chapter.currentRevisionId === null) return '（本章还没有草稿）'
  const members = repos.revision.manifest(chapter.currentRevisionId)
  if (members.length === 0) return '（本章草稿为空）'
  return members
    .map((member) => {
      const name =
        member.speakerType === 'narrator'
          ? '旁白'
          : (repos.character.get(member.speakerId)?.name ?? member.speakerId)
      return `[${member.beatId}] ${name}：${member.body}`
    })
    .join('\n')
}

function reportText(repos: Repos, chapterId: string): string {
  const record = latestReport(repos, chapterId)
  if (!record) return '（本章还没有审批报告）'
  const report = parseReportRecord(record)
  const lines = [`- 第 ${report.round} 轮：${report.verdict}`]
  for (const issue of report.blocking) {
    lines.push(
      `  - 阻断 ${issue.issue_id}（${issue.type}）${issue.beat_id}：${issue.evidence || issue.why}`
    )
  }
  for (const issue of report.suggestions.slice(0, 8)) {
    lines.push(`  - 建议 ${issue.issue_id}（${issue.type}）${issue.beat_id}：${issue.why}`)
  }
  return lines.join('\n')
}

function patchText(patches: readonly PatchRecord[]): string {
  if (patches.length === 0) return '（本轮还没有 patch）'
  return patches
    .map(
      (patch) =>
        `- ${patch.id}｜${patch.beatId}｜${patch.status}｜issue ${patch.issueRef}｜理由：${patch.reason}`
    )
    .join('\n')
}

function modeRule(mode: ReviewTurnMode, scope: readonly DimensionKey[]): string {
  if (mode === 'report') {
    return [
      '- 这是 G4 全量审批：按检查表审完整章。',
      '- 先调用 draft.get_chapter（或直接使用下方初稿）核对正文；可调用 consistency.check 做确定性检查。',
      '- 报告用 report.submit 提交；最终答复也必须是同一个 JSON 报告对象。',
      '- 每条阻断必须带 beat_id 与原文 evidence；没有证据的怀疑放 suggestions。'
    ].join('\n')
  }
  if (mode === 'recheck') {
    const names = scope.map((key) => DIMENSION_LABELS[key]).join('、')
    return [
      `- 这是修订后的复检：只检查这些维度：${names}。`,
      '- 不要重复上一轮已解决的问题；没有新问题就给 pass。',
      '- 报告用 report.submit 提交；最终答复也必须是同一个 JSON 报告对象。'
    ].join('\n')
  }
  if (mode === 'patch') {
    return [
      '- 作者已授权修订（G5）。用 patch.propose 提交结构化 patch。',
      '- 只改已有拍：before 必须与当前正文逐字一致（允许全半角/行尾空白差异），after 是改后的整拍正文。',
      '- 不加拍、不加场景、不改分镜；每处修改必须引用 issue_ref（iss_xx）。',
      '- 同一 issue_ref 再提案必须给出新的 reason；不要重复上一轮已被拒绝的 patch。'
    ].join('\n')
  }
  return [
    '- 这是与作者的讨论：解释报告、指出依据、给出可选改法。',
    '- 讨论阶段不改稿：不要调用 patch.propose，除非作者已经授权修订。',
    '- 回答不超过 6 句；引用问题用 issue_id。'
  ].join('\n')
}

export function buildReviewPrompt(
  repos: Repos,
  input: { chapterId: string; mode: ReviewTurnMode; scope: readonly DimensionKey[] }
): string {
  const chapter = repos.chapter.get(input.chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${input.chapterId} not found`)
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')
  const patches = repos.patch.listByRevision(chapter.currentRevisionId ?? '')
  return [
    REVIEWER_PROMPT.prefix,
    REVIEW_ANSWER_CONTRACT,
    TOOL_MATERIAL_RULE,
    '',
    '【项目】',
    `${project.title}（${project.genre || '未填'}，${project.pov}）`,
    '',
    '【本章】',
    chapterBrief(repos, chapter),
    '',
    '【角色】',
    castText(repos, project.id),
    '',
    '【初稿】（beat_id｜说话人｜正文）',
    draftBlock(repos, chapter.id),
    '',
    '【上一轮报告】',
    reportText(repos, chapter.id),
    '',
    '【本轮 patch】',
    patchText(patches),
    '',
    '【本轮任务】',
    modeRule(input.mode, input.scope)
  ].join('\n')
}

function historyMessages(
  repos: Repos,
  chapterId: string,
  maxMessages = 12
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const messages = repos.reviewMessage
    .listByChapter(chapterId)
    .filter((message) => message.role !== 'system' && message.body.trim().length > 0)
    .slice(-maxMessages)
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

/** 从最终答复里取出报告 JSON：允许 ```json 包裹与前后解释。 */
export function extractReportJson(text: string): unknown | null {
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

function tryParse(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function scopeOf(options: ReviewTurnOptions, repos: Repos, chapterId: string): DimensionKey[] {
  if (options.mode !== 'recheck') return []
  if (options.scope !== undefined && options.scope.length > 0) return [...new Set(options.scope)]
  const record = latestReport(repos, chapterId)
  const parsed = record ? parseReportRecord(record) : null
  return parsed ? dimensionsForBlocking(parsed.blocking.map((issue) => issue.type)) : []
}

export async function runReviewTurn(
  deps: ReviewTurnDeps,
  options: ReviewTurnOptions
): Promise<ReviewTurnOutcome> {
  const repos = deps.repos
  const chapter = repos.chapter.get(options.chapterId)
  if (!chapter) throw new AppError('project_not_found', `chapter ${options.chapterId} not found`)
  const project = repos.project.get()
  if (!project) throw new AppError('project_not_found', 'project row missing')
  if (chapter.status === 'finalized') {
    throw new AppError('already_finalized', '本章已定稿，审批台只读')
  }
  if (chapter.status === 'drafting' || chapter.status === 'planned' || chapter.status === 'storyboard_ready') {
    throw new AppError('invalid_args', '本章还没有完成初稿（G4 需要 draft_complete）', {
      status: chapter.status
    })
  }
  if (chapter.currentRevisionId === null) {
    throw new AppError('invalid_args', '本章还没有草稿 revision')
  }

  // PHASE-13 M1-19：审批的认知水位 = 本章 covered_until_seq，严格不 fallback seq_head。
  const asOf = resolveChapterAsOf(repos, chapter, 'review')

  const scope = scopeOf(options, repos, chapter.id)
  const system = buildReviewPrompt(repos, { chapterId: chapter.id, mode: options.mode, scope })
  const userText =
    options.text?.trim() ||
    (options.mode === 'report'
      ? '请审这一章的初稿，按契约提交报告。'
      : options.mode === 'recheck'
        ? '请复检修订后的正文，只检查指定维度。'
        : options.mode === 'patch'
          ? '请根据报告给出可逐条接受的 patch。'
          : '继续讨论。')

  const chat: ChatMessage[] = [
    { role: 'system', content: system },
    ...historyMessages(repos, chapter.id),
    { role: 'user', content: userText }
  ]

  const binding = deps.binding
    ? {
        ...resolveBinding(repos, project, 'reviewer', deps.capabilitiesLookup),
        provider: deps.binding.provider,
        model: deps.binding.model
      }
    : resolveBinding(repos, project, 'reviewer', deps.capabilitiesLookup)
  if (deps.adapter.provider !== binding.provider || deps.adapter.model !== binding.model) {
    throw new AppError('setup_incomplete', '适配器与冻结绑定不一致', {
      adapter: { provider: deps.adapter.provider, model: deps.adapter.model },
      binding: { provider: binding.provider, model: binding.model }
    })
  }
  const toolset = resolveToolset('reviewer', {}, deps.registry)
  const tools = toolset.toModelTools()
  const services: ToolServices = { repos, now: () => Date.now() }

  const jobId = options.jobId ?? newId('job')
  const turnId = `rturn_${options.messageId}`
  const turnContext: TurnContext = {
    projectId: project.id,
    jobId,
    turnId,
    actorId: 'reviewer',
    characterId: null,
    asOf,
    epoch: project.writeEpoch,
    expectedRevision: chapter.currentRevisionId,
    gateToken: options.gateToken ?? null,
    chapterId: chapter.id,
    beatId: null,
    mode: 'batch'
  }

  const budget = new TurnBudget('reviewer')
  const audit = new RepoAuditSink(repos.toolCall)
  const idempotency = new RepoIdempotencyStore(repos.toolCall)
  const turnRefs = new TurnRefRegistry()

  let toolCalls = 0
  let reportId: string | null = null
  let patchIds: string[] = []
  let finalText = ''
  /** PRD §5.3：没有跑完 consistency.check 时不能「干净地」给 pass。 */
  let consistencyChecked = false
  /** 全链路计量（PHASE-20 §5.3）：本轮所有模型调用都累计在这里。 */
  const turns: ChatResult[] = []
  const startedAt = Date.now()
  const blockTokens = promptTokensOf(
    chat.map((message) => (typeof message.content === 'string' ? message.content : ''))
  )

  try {
    for (let round = 0; round < (deps.maxRounds ?? DEFAULT_MAX_ROUNDS); round += 1) {
      let roundText = ''
      const result: ChatResult = await deps.adapter.stream(
        {
          messages: chat,
          stream: true,
          ...(tools.length > 0 ? { tools, toolChoice: 'auto' as const } : {}),
          temperature: options.mode === 'discuss' ? 0.5 : 0.2,
          ...(deps.signal === undefined ? {} : { signal: deps.signal }),
          meta: { agentKey: 'reviewer' }
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
      turns.push(result)

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
          { toolset, budget, audit, idempotency, gateSecret: deps.gateSecret, turnRefs },
          services
        )
        toolCalls += 1
        if (call.name === 'report.submit' && toolResult.ok) {
          const data = toolResult.data as { report_id?: unknown } | null
          if (typeof data?.report_id === 'string') reportId = data.report_id
        }
        if (call.name === 'patch.propose' && toolResult.ok) {
          const data = toolResult.data as { patch_ids?: unknown } | null
          if (Array.isArray(data?.patch_ids)) {
            patchIds = data.patch_ids.filter((id): id is string => typeof id === 'string')
          }
        }
        if (call.name === 'consistency.check' && toolResult.ok) consistencyChecked = true
        deps.hooks?.onToolCall?.(call, toolResult)
        chat.push({
          role: 'tool',
          content: `<tool_result tool="${call.name}" call_id="${call.id}" ok="${String(toolResult.ok)}">\n${toolPayload(toolResult)}\n</tool_result>`
        })
      }
    }
  } finally {
    // 失败也记账：模型已经消耗的 token 不能凭空消失；turn_id 稳定，重试 upsert。
    if (turns.length > 0) {
      recordTurnMetric({
        repos,
        projectId: project.id,
        jobId,
        turnId,
        agentKey: 'reviewer',
        chapterId: chapter.id,
        beatId: null,
        provider: binding.provider,
        model: binding.model,
        bindingVersion: binding.version,
        usage: sumUsages(turns.map((turn) => turn.usage)),
        capabilities: binding.capabilities ?? capabilitiesFor(binding.provider, binding.model),
        latencyMs: Date.now() - startedAt,
        firstTokenMs: turns.find((turn) => turn.firstTokenMs !== null)?.firstTokenMs ?? null,
        contextJson: simpleContextJson({
          kind: 'review',
          promptVersion: PROMPT_VERSION,
          toolsetVersion: deps.registry.version,
          blockTokens,
          ...(deps.routingTrace == null ? {} : { routing: deps.routingTrace })
        })
      })
    }
  }

  let degraded: string | null = null
  if (options.mode === 'report' || options.mode === 'recheck') {
    if (reportId === null) {
      const parsed = extractReportJson(finalText)
      const reportDraft = parsed === null ? null : ReportDraftSchema.safeParse(parsed)
      if (reportDraft?.success) {
        const submitted = submitReport(
          repos,
          {
            projectId: project.id,
            chapterId: chapter.id,
            revisionId: chapter.currentRevisionId,
            draft: reportDraft.data as ReportDraft,
            scope
          },
          deps.db
        )
        reportId = submitted.report.id
      } else {
        const plain = submitPlainReport(
          repos,
          {
            projectId: project.id,
            chapterId: chapter.id,
            revisionId: chapter.currentRevisionId,
            text: finalText.length > 0 ? finalText : '（模型没有返回可解析的报告）',
            scope
          },
          deps.db
        )
        reportId = plain.report.id
        degraded = 'schema_fallback'
      }
    }
    if (reportId !== null) {
      const record = repos.review.getReport(reportId)
      if (record) {
        // 复检范围由运行时决定（T35 的输入里没有 scope），回合结束后补记。
        if (options.mode === 'recheck' && scope.length > 0) {
          repos.review.setScope(record.id, JSON.stringify(scope))
        }
        // 异构复检留痕（PHASE-16 §5.3）：T35 不知道真实绑定，回合结束后补记 provider/model。
        repos.review.setProvider(record.id, binding.provider, binding.model)
        // 没有阻断但确定性检查没跑完/没跑：标 degraded，由作者决定是否继续（PRD §5.3）。
        // 异构缺失优先于 check_missing：验收要求 prefer 且无第二家时能读到 hetero_unavailable。
        if (record.degraded === null && deps.heteroDegraded !== undefined && deps.heteroDegraded !== null) {
          repos.review.setDegraded(record.id, deps.heteroDegraded)
        } else if (record.verdict !== 'fail' && !consistencyChecked && record.degraded === null) {
          repos.review.setDegraded(record.id, 'check_missing')
        }
        repos.reviewMessage.insert({
          projectId: project.id,
          chapterId: chapter.id,
          round: record.round,
          role: 'system',
          kind: 'report',
          body: `第 ${record.round} 轮报告：${record.verdict}`,
          metaJson: JSON.stringify({ reportId: record.id, scope, consistencyChecked })
        })
      }
    }
  }

  return {
    jobId,
    turnId,
    reply: finalText,
    toolCalls,
    rounds: 1,
    reportId,
    patchIds,
    degraded
  }
}

/** 供 UI 与测试使用：scope 的合法值。 */
export function isDimensionKey(value: string): value is DimensionKey {
  return DimensionKeySchema.safeParse(value).success
}
