import { existsSync, unlinkSync } from 'node:fs'
import { AppError, isAppError } from '../../shared/domain/app-error'
import {
  PLAN_COVERAGE_NOTE,
  PlanMessageMetaSchema,
  parseCharacterCard,
  type PlanCharacterAddInput,
  type PlanCharacterSaveInput,
  type PlanChoiceRequest,
  type PlanChooseInput,
  type PlanEvent,
  type PlanFactAddInput,
  type PlanFactSaveInput,
  type PlanG1Preview,
  type PlanG1Result,
  type PlanMessageMeta,
  type PlanMessageView,
  type PlanModelStatus,
  type PlanProposalApplyResult,
  type PlanProposalView,
  type PlanSaveOutlineInput,
  type PlanSaveResult,
  type PlanSendResult,
  type PlanSessionCreateInput,
  type PlanSessionView,
  type PlanState
} from '../../shared/schema/plan'
import type { Settings } from '../../shared/schema/project'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { PlanMessageRecord, PlanSessionRecord } from '../db/repos/plan'
import type { ChoiceOption, ChoiceResolver } from '../tools/types'
import { ModelError } from '../model/adapter'
import type { RegistrySnapshot } from '../tools/registry'
import { addPlanCharacter, addPlanFact, removeOutlineNode, removePlanCharacter, removePlanFact, saveCharacterCard, saveOutlineNode, addOutlineNode, savePlanFact } from './draft'
import { confirmG1, g1Preview, retrySetup } from './g1'
import { plannerModel, plannerModelStatus, type PlannerModel } from './model'
import { applyProposal } from './proposals'
import { runPlanMessage } from './runtime'

/**
 * 规划台服务（PHASE-06 E1–E5）。
 *
 * IPC 只调这里；正文、角色、记忆的正式写入都不在本文件：
 * G1 写 gate/角色/世界初值，建库走 memory/namespace，提案走 plan/proposals。
 */

export interface PlanHost {
  dir: string
  db: Db
  repos: Repos
  readOnly: boolean
}

export interface PlanServiceDeps {
  host: () => PlanHost | null
  registry: RegistrySnapshot
  settings: () => Settings
  /** 未打包构建才允许假模型；测试注入。 */
  allowFakeModel: boolean
  emit: (event: PlanEvent) => void
  /** T42 选择请求：renderer 展示问题与 2–4 个选项。 */
  emitChoice: (event: PlanChoiceRequest) => void
  /** G1 / 建库重试后让 ProjectService 重新广播 setupState。 */
  onStateChange?: () => void
  /** 测试注入：覆盖模型装配（默认走 plannerModel）。 */
  model?: (host: PlanHost, settings: Settings) => PlannerModel
  log?: (message: string, details?: Record<string, unknown>) => void
}

interface RunningPlan {
  controller: AbortController
  assistantMessageId: string
}

interface PendingChoice {
  sessionId: string
  options: readonly ChoiceOption[]
  resolve: (option: ChoiceOption | null) => void
  timer: ReturnType<typeof setTimeout>
}

interface ParsedSummary {
  added?: number
  updated?: number
  removed?: number
  characters?: number
  facts?: number
  character_name?: string
  affected_chapters?: string[]
  note?: string
}

function parseMeta(json: string): PlanMessageMeta {
  try {
    const parsed: unknown = JSON.parse(json)
    const result = PlanMessageMetaSchema.safeParse(parsed)
    return result.success ? result.data : {}
  } catch {
    return {}
  }
}

function parseSummary(json: string): ParsedSummary {
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    const summary: ParsedSummary = {}
    for (const key of ['added', 'updated', 'removed', 'characters', 'facts'] as const) {
      if (typeof record[key] === 'number') summary[key] = record[key] as number
    }
    if (typeof record.character_name === 'string') summary.character_name = record.character_name
    if (Array.isArray(record.affected_chapters)) {
      summary.affected_chapters = record.affected_chapters.filter((item): item is string => typeof item === 'string')
    }
    if (typeof record.note === 'string') summary.note = record.note
    return summary
  } catch {
    return {}
  }
}

function isAborted(error: unknown): boolean {
  return error instanceof ModelError && error.aborted
}

function messageView(message: PlanMessageRecord): PlanMessageView {
  return {
    id: message.id,
    sessionId: message.sessionId,
    role: message.role,
    kind: message.kind,
    body: message.body,
    status: message.status,
    meta: parseMeta(message.metaJson),
    attempt: message.attempt,
    retryOf: message.retryOf,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt
  }
}

export class PlanService {
  private readonly running = new Map<string, RunningPlan>()
  private readonly pendingChoices = new Map<string, PendingChoice>()
  private eventSeq = 0
  private choiceSeq = 0
  /** 最近一次 getState/send 的会话；系统卡片跟随当前会话。 */
  private activeSessionId: string | null = null

  constructor(private readonly deps: PlanServiceDeps) {}

  getState(input: { sessionId?: string } = {}): PlanState {
    const host = this.requireHost()
    let project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')

    // 崩溃恢复：G1 已锁蓝图但建库没走完（setup_state 仍是 pending）→ 标 failed，
    // 让规划台显示 setup_incomplete 与重试入口，而不是把半成品当 pending。
    if (!host.readOnly && project.blueprintLockedAt !== null && project.setupState === 'pending') {
      host.repos.project.setSetupState(project.id, 'failed')
      project = host.repos.project.getById(project.id) ?? project
      this.deps.onStateChange?.()
    }

    this.recoverStreaming(host, project.id)

    const sessions = host.repos.planSession.listByProject(project.id, { status: 'active' })
    const requested = input.sessionId
    const active =
      (requested ? sessions.find((session) => session.id === requested) : undefined) ?? sessions[0] ?? null
    this.activeSessionId = active?.id ?? null
    const messages = active ? host.repos.planMessage.listBySession(active.id).map(messageView) : []
    const proposals = host.repos.proposal
      .listByProject(project.id)
      .slice(-50)
      .reverse()
      .map((proposal) => this.proposalView(proposal.id, proposal.kind, proposal.status, proposal.summaryJson, proposal.createdAt))

    const namespaces = host.repos.namespace.listByProject(project.id)
    const g1 = g1Preview(host.repos)
    const metadata = host.repos.project.metadata(project.id)

    return {
      projectId: project.id,
      setupState: project.setupState,
      readOnly: host.readOnly,
      blueprint: {
        version: project.blueprintVersion,
        lockedAt: project.blueprintLockedAt,
        nodes: host.repos.outline.listByProject(project.id).map((node) => ({
          id: node.id,
          parentId: node.parentId,
          kind: node.kind,
          ord: node.ord,
          title: node.title,
          content: node.content,
          status: node.status,
          version: node.version
        }))
      },
      characters: host.repos.planCharacter.listByProject(project.id).map((character) => ({
        id: character.id,
        name: character.name,
        card: parseCharacterCard(character.cardJson),
        cardVersion: character.cardVersion,
        ord: character.ord,
        status: character.status,
        registeredCharacterId: character.registeredCharacterId
      })),
      facts: host.repos.planFact.listByProject(project.id).map((fact) => ({
        id: fact.id,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        visibility: fact.visibility,
        ord: fact.ord,
        status: fact.status
      })),
      sessions: sessions.map((session) => this.sessionView(host.repos, session)),
      activeSessionId: active?.id ?? null,
      messages,
      proposals,
      namespaces: {
        privateCount: namespaces.filter((item) => item.kind === 'private').length,
        publicCount: namespaces.filter((item) => item.kind === 'public').length,
        isolationVerified: metadata.isolation_verified === true
      },
      g1,
      coverage: { enabled: false, note: PLAN_COVERAGE_NOTE, items: [] },
      model: this.modelStatus(host)
    }
  }

  createSession(input: PlanSessionCreateInput): PlanSessionView {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')
    const count = host.repos.planSession.listByProject(project.id).length
    const session = host.repos.planSession.insert({
      projectId: project.id,
      title: input.title ?? (count === 0 ? '立项' : `规划 · 第 ${count + 1} 次`)
    })
    this.activeSessionId = session.id
    return this.sessionView(host.repos, session)
  }

  renameSession(input: { sessionId: string; title: string }): PlanSessionView {
    const host = this.requireWritable()
    const session = this.requireSession(host, input.sessionId)
    return this.sessionView(host.repos, host.repos.planSession.rename(session.id, input.title))
  }

  archiveSession(input: { sessionId: string }): { archived: boolean } {
    const host = this.requireWritable()
    const session = this.requireSession(host, input.sessionId)
    if (this.running.has(session.id)) throw new AppError('invalid_args', '生成中不能归档会话')
    host.repos.planSession.archive(session.id)
    if (this.activeSessionId === session.id) this.activeSessionId = null
    return { archived: true }
  }

  send(input: { sessionId: string; text: string }): PlanSendResult {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')
    const session = this.requireSession(host, input.sessionId)
    if (this.running.has(session.id)) {
      throw new AppError('invalid_args', '本会话已有回复在进行中，请先停止')
    }

    const userMessage = host.repos.planMessage.insert({
      sessionId: session.id,
      projectId: project.id,
      role: 'author',
      body: input.text
    })
    const assistant = host.repos.planMessage.insert({
      sessionId: session.id,
      projectId: project.id,
      role: 'planner',
      status: 'streaming',
      metaJson: JSON.stringify({ label: 'discussion' })
    })
    host.repos.planSession.touch(session.id)
    this.activeSessionId = session.id

    void this.startRun(host, project.id, session.id, assistant.id)

    return {
      sessionId: session.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistant.id,
      status: 'streaming'
    }
  }

  stop(input: { sessionId: string }): { stopped: boolean } {
    const running = this.running.get(input.sessionId)
    if (!running) return { stopped: false }
    this.resolveChoices(input.sessionId)
    running.controller.abort()
    return { stopped: true }
  }

  /** 项目切换/关闭前由 IPC 检查：生成中不允许换库，避免写入已关闭的连接。 */
  isBusy(): boolean {
    return this.running.size > 0
  }

  retry(input: { messageId: string }): PlanSendResult {
    const host = this.requireWritable()
    const message = host.repos.planMessage.get(input.messageId)
    if (!message || message.role !== 'planner') throw new AppError('invalid_args', '只能重试规划 Agent 的消息')
    if (message.status !== 'stopped' && message.status !== 'failed') {
      throw new AppError('invalid_args', '只有已停止或失败的回复可以重试')
    }
    if (this.running.has(message.sessionId)) throw new AppError('invalid_args', '本会话已有回复在进行中')
    const session = this.requireSession(host, message.sessionId)
    const author = host.repos.planMessage.previousAuthor(session.id, message.id)
    if (!author) throw new AppError('invalid_args', '找不到这条回复对应的作者消息')

    const previousMeta = parseMeta(message.metaJson)
    const meta: PlanMessageMeta = {
      ...previousMeta,
      label: 'discussion',
      ...(message.body.trim().length > 0 ? { previous_body: message.body } : {})
    }
    host.repos.planMessage.restart(message.id, JSON.stringify(meta))
    this.activeSessionId = session.id
    this.emit({
      projectId: session.projectId,
      sessionId: session.id,
      messageId: message.id,
      seq: this.nextSeq(),
      phase: 'start'
    })
    void this.startRun(host, session.projectId, session.id, message.id)

    return {
      sessionId: session.id,
      userMessageId: author.id,
      assistantMessageId: message.id,
      status: 'streaming'
    }
  }

  saveOutline(input: PlanSaveOutlineInput): PlanSaveResult {
    return saveOutlineNode(this.requireWritable().repos, input)
  }

  addOutline(input: Parameters<typeof addOutlineNode>[1]): { id: string; version: number } {
    return addOutlineNode(this.requireWritable().repos, input)
  }

  removeOutline(input: { nodeId: string }): { removed: boolean } {
    return removeOutlineNode(this.requireWritable().repos, input.nodeId)
  }

  saveCharacter(input: PlanCharacterSaveInput): PlanSaveResult & { cardVersion: number; affectedChapters: string[] } {
    return saveCharacterCard(this.requireWritable().repos, input)
  }

  addCharacter(input: PlanCharacterAddInput): { id: string; cardVersion: number } {
    return addPlanCharacter(this.requireWritable().repos, input)
  }

  removeCharacter(input: { characterId: string }): { removed: boolean } {
    return removePlanCharacter(this.requireWritable().repos, input.characterId)
  }

  saveFact(input: PlanFactSaveInput): PlanSaveResult {
    return savePlanFact(this.requireWritable().repos, input)
  }

  addFact(input: PlanFactAddInput): { id: string; ord: number } {
    return addPlanFact(this.requireWritable().repos, input)
  }

  removeFact(input: { factId: string }): { removed: boolean } {
    return removePlanFact(this.requireWritable().repos, input.factId)
  }

  applyProposal(input: { proposalId: string }): PlanProposalApplyResult {
    const host = this.requireWritable()
    const result = applyProposal(host.db, host.repos, input.proposalId)
    this.appendSystemCard(host, 'draft', `已应用提案：新增 ${result.nodesCreated} 个节点、${result.charactersCreated} 个角色、${result.factsCreated} 条世界初值。`, {
      proposal_ids: [input.proposalId],
      label: 'draft'
    })
    return result
  }

  rejectProposal(input: { proposalId: string }): { rejected: boolean } {
    const host = this.requireWritable()
    const proposal = host.repos.proposal.get(input.proposalId)
    if (!proposal || proposal.projectId !== this.projectId(host)) {
      throw new AppError('invalid_args', '提案不存在')
    }
    if (proposal.status !== 'draft') throw new AppError('invalid_args', '提案已处理')
    host.repos.proposal.setStatus(proposal.id, 'rejected')
    this.appendSystemCard(host, 'draft', '已拒绝提案；草案未改动。', { proposal_ids: [proposal.id], label: 'discussion' })
    return { rejected: true }
  }

  /** T42 作者选择：只解析本项目的挂起请求；未知/过期选项一律 invalid_args。 */
  choose(input: PlanChooseInput): { chosen: boolean } {
    const host = this.requireWritable()
    const pending = this.pendingChoices.get(input.choiceId)
    if (!pending) throw new AppError('invalid_args', '选择已过期')
    if (pending.sessionId !== this.activeSessionId) {
      const session = host.repos.planSession.get(pending.sessionId)
      if (!session || session.projectId !== this.projectId(host)) {
        throw new AppError('invalid_args', '选择已过期')
      }
    }
    this.pendingChoices.delete(input.choiceId)
    clearTimeout(pending.timer)
    const option = pending.options.find((item) => item.id === input.optionId) ?? null
    pending.resolve(option)
    return { chosen: option !== null }
  }

  g1Preview(): PlanG1Preview {
    return g1Preview(this.requireHost().repos)
  }

  confirmG1(): PlanG1Result {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')
    try {
      const result = confirmG1(host.db, host.repos, { failHook: this.failureHook() })
      this.appendSystemCard(host, 'g1', `G1 已确认：${result.registeredCount} 个角色，${result.namespaces.length} 个命名空间。`, {
        label: 'draft'
      })
      this.deps.onStateChange?.()
      this.log('plan_g1_complete', { projectId: project.id, namespaces: result.namespaces.length })
      return result
    } catch (error) {
      const code = isAppError(error) ? error.code : 'setup_incomplete'
      const message = error instanceof Error ? error.message : String(error)
      this.appendSystemCard(host, 'g1', `G1 未完成：${message}`, {
        error_code: code,
        error_message: message
      })
      this.deps.onStateChange?.()
      this.log('plan_g1_failed', { projectId: project.id, code, message })
      throw error
    }
  }

  retrySetup(): PlanG1Result {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')
    try {
      const result = retrySetup(host.repos, { failHook: this.failureHook() })
      this.appendSystemCard(host, 'g1', `建库重试成功：${result.namespaces.length} 个命名空间，隔离自检通过。`, {
        label: 'draft'
      })
      this.deps.onStateChange?.()
      return result
    } catch (error) {
      const code = isAppError(error) ? error.code : 'setup_incomplete'
      const message = error instanceof Error ? error.message : String(error)
      this.appendSystemCard(host, 'g1', `建库重试失败：${message}`, { error_code: code, error_message: message })
      this.deps.onStateChange?.()
      throw error
    }
  }

  private makeChoices(
    projectId: string,
    sessionId: string,
    messageId: string
  ): ChoiceResolver {
    return {
      ask: (question, options) =>
        new Promise<ChoiceOption | null>((resolve) => {
          const choiceId = `choice_${(this.choiceSeq += 1)}`
          const timer = setTimeout(() => {
            this.pendingChoices.delete(choiceId)
            resolve(null)
          }, 5 * 60 * 1000)
          this.pendingChoices.set(choiceId, { sessionId, options, resolve, timer })
          try {
            this.deps.emitChoice({
              projectId,
              sessionId,
              messageId,
              choiceId,
              question,
              options: options.map((option) => ({ id: option.id, label: option.label }))
            })
          } catch {
            this.pendingChoices.delete(choiceId)
            clearTimeout(timer)
            resolve(null)
          }
        })
    }
  }

  /** 停止/结束时取消本会话所有挂起选择，避免工具调用悬空。 */
  private resolveChoices(sessionId: string): void {
    for (const [choiceId, pending] of this.pendingChoices) {
      if (pending.sessionId !== sessionId) continue
      clearTimeout(pending.timer)
      this.pendingChoices.delete(choiceId)
      pending.resolve(null)
    }
  }

  private async startRun(host: PlanHost, projectId: string, sessionId: string, assistantMessageId: string): Promise<void> {
    if (this.running.has(sessionId)) return
    const controller = new AbortController()
    this.running.set(sessionId, { controller, assistantMessageId })
    this.emit({
      projectId,
      sessionId,
      messageId: assistantMessageId,
      seq: this.nextSeq(),
      phase: 'start'
    })

    let latest = ''
    let lastWrite = 0
    try {
      const model =
        this.deps.model?.(host, this.deps.settings()) ??
        plannerModel(host.repos, this.deps.settings(), { allowFake: this.deps.allowFakeModel })
      if (!model.status.ready) {
        throw new AppError('model_auth', '未配置规划 Agent 的 API Key；阶段 10 在设置页接入')
      }
      const outcome = await runPlanMessage(
        {
          repos: host.repos,
          registry: this.deps.registry,
          adapter: model.adapter,
          gateSecret: this.gateSecret(),
          allowTools: model.binding.capabilities?.tools !== false,
          choices: this.makeChoices(projectId, sessionId, assistantMessageId),
          signal: controller.signal,
          hooks: {
            onText: (delta, full) => {
              latest = full
              const now = Date.now()
              if (now - lastWrite >= 120) {
                lastWrite = now
                host.repos.planMessage.updateStream(assistantMessageId, full)
              }
              this.emit({
                projectId,
                sessionId,
                messageId: assistantMessageId,
                seq: this.nextSeq(),
                phase: 'delta',
                delta,
                full
              })
            },
            onRetryReset: () => {
              latest = ''
            }
          }
        },
        { sessionId, assistantMessageId }
      )
      latest = outcome.text
      host.repos.planMessage.setStatus(assistantMessageId, 'done', {
        body: latest,
        metaJson: JSON.stringify(outcome.meta)
      })
      this.emit({
        projectId,
        sessionId,
        messageId: assistantMessageId,
        seq: this.nextSeq(),
        phase: 'done',
        full: latest,
        label: outcome.label,
        proposalIds: outcome.proposalIds
      })
    } catch (error) {
      if (isAborted(error)) {
        host.repos.planMessage.setStatus(assistantMessageId, 'stopped', {
          body: latest,
          metaJson: JSON.stringify({ label: 'discussion', ...(latest.length > 0 ? { interrupted: true } : {}) })
        })
        this.emit({
          projectId,
          sessionId,
          messageId: assistantMessageId,
          seq: this.nextSeq(),
          phase: 'stopped',
          full: latest
        })
      } else {
        const code = isAppError(error) ? error.code : error instanceof ModelError ? error.code : 'internal_error'
        const message = error instanceof Error ? error.message : String(error)
        host.repos.planMessage.setStatus(assistantMessageId, 'failed', {
          body: latest,
          metaJson: JSON.stringify({ label: 'discussion', error_code: code, error_message: message })
        })
        this.emit({
          projectId,
          sessionId,
          messageId: assistantMessageId,
          seq: this.nextSeq(),
          phase: 'failed',
          code,
          message,
          full: latest
        })
      }
    } finally {
      this.resolveChoices(sessionId)
      this.running.delete(sessionId)
      host.repos.planSession.touch(sessionId)
    }
  }

  private recoverStreaming(host: PlanHost, projectId: string): void {
    if (host.readOnly) return
    const runningIds = new Set([...this.running.values()].map((run) => run.assistantMessageId))
    if (runningIds.size === 0) {
      // 冷启动：没有进程内任务，流式消息一定是上次崩溃/退出留下的。
      host.repos.planMessage.markStreamingStopped(projectId)
      return
    }
    for (const session of host.repos.planSession.listByProject(projectId)) {
      for (const message of host.repos.planMessage.listBySession(session.id)) {
        if (message.status === 'streaming' && !runningIds.has(message.id)) {
          host.repos.planMessage.setStatus(message.id, 'stopped', {
            metaJson: JSON.stringify({ interrupted: true, reason: 'app_restart' })
          })
        }
      }
    }
  }

  private modelStatus(host: PlanHost): PlanModelStatus {
    return plannerModelStatus(host.repos, this.deps.settings(), this.deps.allowFakeModel)
  }

  private proposalView(
    id: string,
    kind: 'blueprint_patch' | 'roster' | 'character_card',
    status: 'draft' | 'applied' | 'rejected',
    summaryJson: string,
    createdAt: string
  ): PlanProposalView {
    return { id, kind, status, summary: parseSummary(summaryJson), createdAt }
  }

  private sessionView(repos: Repos, session: PlanSessionRecord): PlanSessionView {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastMessageAt: session.lastMessageAt,
      messageCount: repos.planMessage.countBySession(session.id)
    }
  }

  private appendSystemCard(
    host: PlanHost,
    kind: 'draft' | 'coverage' | 'g1' | 'error',
    body: string,
    meta: PlanMessageMeta = {}
  ): void {
    const project = host.repos.project.get()
    if (!project) return
    const sessions = host.repos.planSession.listByProject(project.id, { status: 'active' })
    const session =
      (this.activeSessionId ? sessions.find((item) => item.id === this.activeSessionId) : undefined) ??
      sessions[0]
    if (!session) return
    host.repos.planMessage.insert({
      sessionId: session.id,
      projectId: project.id,
      role: 'system',
      kind,
      body,
      metaJson: JSON.stringify(meta)
    })
    host.repos.planSession.touch(session.id)
  }

  private requireHost(): PlanHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '请先打开一个项目')
    return host
  }

  private requireWritable(): PlanHost {
    const host = this.requireHost()
    if (host.readOnly) throw new AppError('project_locked', '项目当前只读')
    return host
  }

  private requireSession(host: PlanHost, sessionId: string): PlanSessionRecord {
    const session = host.repos.planSession.get(sessionId)
    if (!session || session.projectId !== this.projectId(host)) {
      throw new AppError('invalid_args', '会话不在当前项目')
    }
    return session
  }

  private projectId(host: PlanHost): string {
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')
    return project.id
  }

  private failureHook(): (() => boolean) | undefined {
    if (!this.deps.allowFakeModel) return undefined
    const file = process.env.NORYTH_SETUP_FAIL_ONCE
    if (!file) return undefined
    return () => {
      if (!existsSync(file)) return false
      try {
        unlinkSync(file)
      } catch {
        // 删除失败也按一次失败处理，避免重试永远成功
      }
      return true
    }
  }

  private gateSecret(): string {
    const secret = process.env.NORYTH_GATE_SECRET
    if (secret && secret.length > 0) return secret
    return `${this.deps.host()?.dir ?? 'none'}:${this.deps.allowFakeModel ? 'dev' : 'prod'}`
  }

  private nextSeq(): number {
    this.eventSeq += 1
    return this.eventSeq
  }

  private emit(event: PlanEvent): void {
    this.deps.emit(event)
  }

  private log(message: string, details: Record<string, unknown> = {}): void {
    this.deps.log?.(message, details)
  }
}
