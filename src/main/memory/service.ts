import { AppError } from '../../shared/domain/app-error'
import type { Settings } from '../../shared/schema/project'
import type {
  BeliefState,
  MemoryActionResult,
  MemoryAuditState,
  MemoryChapterSummary,
  MemoryEvent,
  MemoryIssueResult,
  MemoryJobSummary,
  MemoryProposalState,
  MemoryRecallResult,
  MemorySendResult,
  MemoryState,
  WorldFactState
} from '../../shared/schema/memory'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { JobRecord } from '../db/repos/job'
import type { MemoryProposalItemRecord } from '../db/repos/memory-proposal'
import { newId } from '../db/repos/common'
import { sha256Hex } from '../crypto'
import { resolveBinding } from '../model/bindings'
import type { RegistrySnapshot } from '../tools/registry'
import { chapterTransition } from '../scheduler/transitions'
import { markChapterComplete } from '../scheduler/loop'
import { confirmG2 } from '../scheduler/g2'
import { saveStoryboardDraft } from '../scheduler/storyboard'
import { commitBeat } from '../doc/commit-beat'
import { finalizeChapter } from '../doc/finalize'
import { checkAuthorGate, consumeAuthorGate, issueAuthorGate } from '../review/gates'
import { ensureNamespaces } from './namespace'
import { applyMemoryProposals, invalidateMemoryEntry, proposalJobKey } from './apply'
import type { Embedder } from './embed/types'
import type { MemoryApplyPort, MemoryApplyPortInput } from '../tools/types'
import { MemoryModelFactory } from './model'
import { invalidateRetrievalCache, retrieveOwn } from './retrieve'
import { runMemoryTurn } from './run'

/**
 * 记忆台服务（PHASE-09 H1–H5）。
 *
 * 职责边界：
 * - 抽取只写 job + 提案；apply 只由作者 G7 触发；正文永不被本服务触碰。
 * - 记忆/世界状态/向量只有一个写入口：`memory/apply.applyMemoryProposals`。
 * - 列表读取（记忆浏览/世界状态/审计）是只读投影，可以从任何章看。
 * - 同项目同一时刻只跑一个抽取任务（running 单飞），停止用 AbortController。
 */

export interface MemoryHost {
  dir: string
  db: Db
  repos: Repos
  readOnly: boolean
}

export interface MemoryServiceDeps {
  host: () => MemoryHost | null
  registry: RegistrySnapshot
  settings: () => Settings
  allowFakeModel: boolean
  gateSecret: string
  send: (event: MemoryEvent) => void
  embedder: Embedder
  fakeChunkDelayMs?: number
  log?: (message: string, details?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
}

type JobStatusView = MemoryJobSummary['status']

function parseJson(text: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : fallback
  } catch {
    return fallback
  }
}

function memoryJobKey(projectId: string, revisionId: string): string {
  return sha256Hex(`${projectId}|memory.extract|${revisionId}`)
}

function viewStatus(job: JobRecord | null): JobStatusView | null {
  if (!job) return null
  const result = job.resultJson === null ? {} : parseJson(job.resultJson)
  if (result.applied === true) return 'applied'
  if (job.status === 'succeeded') return 'proposed'
  if (job.status === 'interrupted') return 'failed'
  if (job.status === 'queued') return 'queued'
  if (job.status === 'running') return 'running'
  if (job.status === 'cancelled') return 'cancelled'
  if (job.status === 'failed') return 'failed'
  return 'proposed'
}

function resultCounts(job: JobRecord | null): { applied: number; rejected: number; mismatches: number } {
  if (!job || job.resultJson === null) return { applied: 0, rejected: 0, mismatches: 0 }
  const result = parseJson(job.resultJson)
  const apply = (result.apply_result ?? {}) as Record<string, unknown>
  return {
    applied: typeof apply.appliedCount === 'number' ? apply.appliedCount : 0,
    rejected: typeof apply.rejectedCount === 'number' ? apply.rejectedCount : 0,
    mismatches: typeof result.mismatches === 'number' ? result.mismatches : 0
  }
}

export class MemoryService {
  private running = false
  private abort: AbortController | null = null
  private readonly models: MemoryModelFactory

  constructor(private readonly deps: MemoryServiceDeps) {
    this.models = new MemoryModelFactory({
      allowFake: deps.allowFakeModel,
      getSettings: deps.settings,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.fakeChunkDelayMs === undefined ? {} : { fakeChunkDelayMs: deps.fakeChunkDelayMs })
    })
  }

  isBusy(): boolean {
    return this.running
  }

  // ── 读状态 ────────────────────────────────────────────────────────────────

  chapters(): MemoryChapterSummary[] {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) return []
    return host.repos.chapter.listByProject(project.id).map((chapter) => {
      const job = this.proposalJobOf(host.repos, project.id, chapter.finalRevisionId)
      const items = job === null ? [] : host.repos.memoryProposal.listByJob(project.id, job.id)
      const apply = (job?.resultJson ? parseJson(job.resultJson).apply_result : null) as
        | { appliedCount?: unknown }
        | null
      return {
        id: chapter.id,
        ord: chapter.ord,
        title: host.repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`,
        status: chapter.status,
        finalRevisionId: chapter.finalRevisionId,
        jobId: job?.id ?? null,
        jobStatus: viewStatus(job),
        itemCount: items.length,
        pendingCount: items.filter((item) => item.decision === 'pending').length,
        appliedCount: typeof apply?.appliedCount === 'number' ? apply.appliedCount : resultCounts(job).applied
      }
    })
  }

  state(chapterId?: string): MemoryState {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const chapters = this.chapters()
    const selected = this.selectChapter(host.repos, chapters, chapterId)
    const jobs = this.jobSummaries(host.repos, project.id)
    const job = selected === null ? null : this.proposalJobOf(host.repos, project.id, selected.finalRevisionId)
    const proposals = job === null ? [] : this.proposalStates(host.repos, job.id)
    const gateId = job?.id ?? null
    const entries = host.repos.memory.listFiltered(project.id, {})
    const chapterTitles = new Map(chapters.map((chapter) => [chapter.id, chapter.title]))
    const characters = new Map(host.repos.character.list(project.id).map((character) => [character.id, character.name]))

    const pending = proposals.filter((item) => item.decision === 'pending').length
    const accepted = proposals.filter((item) => item.decision === 'accept' || item.decision === 'edit').length
    const rejected = proposals.filter((item) => item.decision === 'reject').length
    const blockers: string[] = []
    if (job === null) blockers.push('本章还没有定稿，定稿后才会出现固化提案')
    else if (proposals.length === 0) blockers.push('提案还没有生成')
    else if (accepted === 0) blockers.push('还没有已接受的条目')
    else if (pending > 0) blockers.push(`还有 ${pending} 条未决定`)

    return {
      projectId: project.id,
      projectTitle: project.title,
      readOnly: host.readOnly,
      chapterId: selected?.id ?? null,
      chapterOrd: selected?.ord ?? 0,
      chapterTitle: selected?.title ?? '',
      chapterStatus: selected?.status ?? '',
      revisionId: selected?.finalRevisionId ?? null,
      chapters,
      jobs,
      jobId: gateId,
      jobStatus: job === null ? null : viewStatus(job),
      proposals,
      entries: entries.map((entry) => ({
        id: entry.id,
        characterId: entry.characterId,
        characterName: characters.get(entry.characterId) ?? entry.characterId,
        kind: entry.kind,
        text: entry.text,
        learnedSeq: entry.learnedSeq,
        sourceChapterId: entry.sourceChapterId,
        sourceChapterTitle: chapterTitles.get(entry.sourceChapterId) ?? entry.sourceChapterId,
        sourceBeatId: entry.sourceBeatId,
        sourceRevisionId: entry.sourceRevisionId,
        importance: entry.importance,
        pinned: entry.pinned === 1,
        validFromSeq: entry.validFromSeq,
        validToSeq: entry.validToSeq,
        status: entry.status,
        embeddingModel: entry.embeddingModel,
        createdAt: entry.createdAt
      })),
      worldFacts: host.repos.world.listByProject(project.id).map((fact) => this.factState(fact)),
      beliefs: host.repos.belief
        .listByProject(project.id)
        .map((belief) => this.beliefState(belief, characters)),
      relationships: host.repos.relationship.listActiveAll().map((edge) => ({
        id: edge.id,
        fromId: edge.fromId,
        fromName: characters.get(edge.fromId) ?? edge.fromId,
        toId: edge.toId,
        toName: characters.get(edge.toId) ?? edge.toId,
        axis: edge.axis,
        value: edge.value,
        sinceSeq: edge.sinceSeq,
        validToSeq: edge.validToSeq
      })),
      audit: host.repos.memoryAudit.listByProject(project.id, 200).map((record) => ({
        id: record.id,
        action: record.action,
        actor: record.actor,
        entityType: record.entityType,
        entityId: record.entityId,
        detail: parseJson(record.detailJson),
        createdAt: record.createdAt
      })) satisfies MemoryAuditState[],
      messages: host.repos.memoryMessage
        .list(project.id, selected?.id ?? null, 80)
        .map((message) => ({
          id: message.id,
          role: message.role,
          kind: message.kind,
          body: message.body,
          createdAt: message.createdAt
        })),
      g7: {
        allowed: !host.readOnly && gateId !== null && accepted > 0 && pending === 0,
        reason: blockers[0] ?? null,
        acceptedCount: accepted,
        pendingCount: pending,
        rejectedCount: rejected
      },
      running: this.running,
      hasProposals: proposals.length > 0,
      model: this.models.status(host.repos),
      embedding: {
        model: this.deps.embedder.model,
        dim: this.deps.embedder.dim,
        degraded: this.deps.embedder.source === 'hash',
        vectorCount: host.repos.memoryIndex.countVectors()
      }
    }
  }

  async recall(input: { characterId: string; query: string; asOf?: number; topK?: number }): Promise<MemoryRecallResult> {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const character = host.repos.character.get(input.characterId)
    if (!character || character.projectId !== project.id) {
      throw new AppError('invalid_args', '角色不在本项目', { characterId: input.characterId })
    }
    const asOf = Math.max(0, Math.min(input.asOf ?? project.seqHead, project.seqHead))
    const result = await retrieveOwn(
      host.repos,
      this.deps.embedder,
      { text: input.query, topK: input.topK ?? 5 },
      {
        projectId: project.id,
        actorId: `character:${character.id}`,
        characterId: character.id,
        asOf
      }
    )
    const mapItem = (item: (typeof result.items)[number]) => ({
      memoryId: item.entry.id,
      text: item.entry.text,
      kind: item.entry.kind,
      score: item.score,
      channel: item.channel,
      cosine: item.cosine
    })
    return {
      characterId: character.id,
      query: input.query,
      asOf,
      items: result.items.map(mapItem),
      pinned: result.pinned.map(mapItem),
      empty: result.empty,
      degraded: result.degraded,
      model: this.deps.embedder.model
    }
  }

  // ── 抽取 ──────────────────────────────────────────────────────────────────

  /**
   * 确保本章的抽取任务存在并执行。
   * - 已应用 → 不再抽；
   * - 已有提案 → 不重复抽；
   * - queued/failed → 跑（失败可重试）。
   */
  async extract(chapterId: string): Promise<MemoryActionResult> {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '已有抽取任务在跑')
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const chapter = host.repos.chapter.get(chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId })
    if (chapter.status !== 'finalized' || chapter.finalRevisionId === null) {
      throw new AppError('invalid_args', '只有定稿章节才能抽取记忆', { status: chapter.status })
    }

    const existing = this.proposalJobOf(host.repos, project.id, chapter.finalRevisionId)
    const existingItems = existing === null ? [] : host.repos.memoryProposal.listByJob(project.id, existing.id)
    const existingStatus = viewStatus(existing)
    if (existing !== null && existingStatus === 'applied') {
      return { state: this.state(chapter.id), detail: '本章记忆已固化；如需重建请走 M1 的按章重建' }
    }
    if (existing !== null && existingItems.length > 0) {
      return { state: this.state(chapter.id), detail: `已有 ${existingItems.length} 条待审阅提案` }
    }

    const job =
      existing ??
      host.repos.job.insert({
        projectId: project.id,
        type: 'memory.extract',
        status: 'queued',
        expectedRevision: chapter.finalRevisionId,
        epoch: project.writeEpoch,
        idempotencyKey: memoryJobKey(project.id, chapter.finalRevisionId),
        payloadJson: JSON.stringify({ chapterId: chapter.id, revisionId: chapter.finalRevisionId, requestedBy: 'author' })
      })

    host.repos.job.setStatus(job.id, 'running')
    this.running = true
    this.abort = new AbortController()
    this.emit({ projectId: project.id, chapterId: chapter.id, jobId: job.id, phase: 'start' })
    try {
      const outcome = await runMemoryTurn(
        {
          db: host.db,
          repos: host.repos,
          registry: this.deps.registry,
          adapter: this.models.adapter(
            resolveBinding(host.repos, project, 'memory', this.models.capabilitiesLookup())
          ),
          capabilitiesLookup: this.models.capabilitiesLookup(),
          embedder: this.deps.embedder,
          gateSecret: this.deps.gateSecret,
          ...(this.abort === null ? {} : { signal: this.abort.signal }),
          hooks: {
            onText: (delta, full) => {
              this.emit({
                projectId: project.id,
                chapterId: chapter.id,
                jobId: job.id,
                phase: 'delta',
                delta,
                full
              })
            }
          }
        },
        {
          chapterId: chapter.id,
          jobId: job.id,
          mode: 'extract',
          revisionId: chapter.finalRevisionId,
          messageId: newId('mmsg')
        }
      )
      host.repos.job.setStatus(job.id, outcome.degraded === null ? 'succeeded' : 'failed', {
        resultJson: JSON.stringify({
          item_count: outcome.itemCount,
          dropped: outcome.dropped.length,
          mismatches: outcome.mismatches,
          downgraded: outcome.downgraded.length,
          applied: false
        }),
        errorCode: outcome.degraded
      })
      host.repos.memoryMessage.insert({
        projectId: project.id,
        chapterId: chapter.id,
        jobId: job.id,
        role: 'system',
        kind: 'proposal',
        body:
          outcome.itemCount > 0
            ? `抽取完成：${outcome.itemCount} 条提案${outcome.mismatches > 0 ? `，丢弃 ${outcome.mismatches} 条证据不符` : ''}`
            : '抽取完成：没有可固化的记忆',
        meta: { itemCount: outcome.itemCount, mismatches: outcome.mismatches }
      })
      this.emit({ projectId: project.id, chapterId: chapter.id, jobId: job.id, phase: 'done' })
      this.log('memory_extract', {
        chapterId: chapter.id,
        jobId: job.id,
        items: outcome.itemCount,
        mismatches: outcome.mismatches
      })
      this.running = false
      this.abort = null
      return {
        state: this.state(chapter.id),
        detail:
          outcome.itemCount > 0
            ? `已生成 ${outcome.itemCount} 条提案，请逐条审阅`
            : '没有可固化的记忆'
      }
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'internal_error'
      host.repos.job.setStatus(job.id, 'failed', { errorCode: code })
      this.emit({ projectId: project.id, chapterId: chapter.id, jobId: job.id, phase: 'failed', code })
      throw error
    } finally {
      this.running = false
      this.abort = null
    }
  }

  // ── 讨论（不改库） ────────────────────────────────────────────────────────

  async send(input: { chapterId?: string; text: string }): Promise<MemorySendResult> {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '抽取任务进行中，请稍等')
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const state = this.state(input.chapterId)
    if (state.chapterId === null) throw new AppError('invalid_args', '还没有可讨论的章节')
    const chapter = host.repos.chapter.get(state.chapterId)!
    const job = this.proposalJobOf(host.repos, project.id, chapter.finalRevisionId)

    host.repos.memoryMessage.insert({
      projectId: project.id,
      chapterId: chapter.id,
      jobId: job?.id ?? null,
      role: 'author',
      kind: 'text',
      body: input.text
    })

    this.running = true
    this.abort = new AbortController()
    const jobId = job?.id ?? newId('job')
    try {
      const outcome = await runMemoryTurn(
        {
          db: host.db,
          repos: host.repos,
          registry: this.deps.registry,
          adapter: this.models.adapter(
            resolveBinding(host.repos, project, 'memory', this.models.capabilitiesLookup())
          ),
          capabilitiesLookup: this.models.capabilitiesLookup(),
          embedder: this.deps.embedder,
          gateSecret: this.deps.gateSecret,
          ...(this.abort === null ? {} : { signal: this.abort.signal })
        },
        { chapterId: chapter.id, jobId, mode: 'discuss', text: input.text, messageId: newId('mmsg') }
      )
      host.repos.memoryMessage.insert({
        projectId: project.id,
        chapterId: chapter.id,
        jobId: job?.id ?? null,
        role: 'memory',
        kind: 'text',
        body: outcome.reply
      })
      this.running = false
      this.abort = null
      return { state: this.state(chapter.id), reply: outcome.reply, toolCalls: outcome.toolCalls }
    } finally {
      this.running = false
      this.abort = null
    }
  }

  // ── 逐条决定（不写长期状态） ──────────────────────────────────────────────

  decide(input: { itemId: string; decision: 'accept' | 'edit' | 'reject'; editedText?: string }): MemoryActionResult {
    const host = this.requireWritable()
    return this.commitDecisions({ decisions: [input] }, host)
  }

  decideMany(input: {
    decisions: ReadonlyArray<{ itemId: string; decision: 'accept' | 'edit' | 'reject'; editedText?: string }>
  }): MemoryActionResult {
    const host = this.requireWritable()
    return this.commitDecisions(input, host)
  }

  private commitDecisions(
    input: {
      decisions: ReadonlyArray<{ itemId: string; decision: 'accept' | 'edit' | 'reject'; editedText?: string }>
    },
    host: MemoryHost
  ): MemoryActionResult {
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    let chapterId: string | null = null
    for (const decision of input.decisions) {
      const item = host.repos.memoryProposal.get(decision.itemId)
      if (!item || item.projectId !== project.id) {
        throw new AppError('invalid_args', '提案条目不存在', { itemId: decision.itemId })
      }
      if (decision.decision === 'edit' && (decision.editedText ?? '').trim().length === 0) {
        throw new AppError('invalid_args', '编辑后内容为空')
      }
      host.repos.memoryProposal.decide(decision.itemId, decision.decision, decision.editedText)
      chapterId = item.sourceChapterId
    }
    return {
      state: this.state(chapterId ?? undefined),
      detail: input.decisions.length === 1 ? '已记录决定' : `已记录 ${input.decisions.length} 条决定`
    }
  }

  // ── G7 与应用 ─────────────────────────────────────────────────────────────

  issueG7Token(chapterId?: string): MemoryIssueResult {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const state = this.state(chapterId)
    if (state.chapterId === null || state.jobId === null) {
      throw new AppError('gate_required', '本章还没有固化提案')
    }
    if (state.jobStatus === 'applied') {
      throw new AppError('gate_required', '本章记忆已固化；按章重建是 M1')
    }
    const preview = this.applyPreview(host.repos, project.id, state.jobId)
    if (!preview.allowed) throw new AppError('gate_required', preview.blockers[0] ?? '当前不能应用')
    const issued = issueAuthorGate({
      repos: host.repos,
      secret: this.deps.gateSecret,
      projectId: project.id,
      gateId: 'G7',
      entityType: 'proposal',
      entityId: state.jobId,
      revision: null,
      jobId: `author_g7_${newId('att')}`,
      actor: 'author'
    })
    return {
      token: issued.token,
      expiresAt: issued.expiresAt,
      preview: {
        chapterId: state.chapterId,
        jobId: state.jobId,
        acceptedCount: preview.accepted,
        pendingCount: preview.pending,
        rejectedCount: preview.rejected,
        blockers: preview.blockers
      }
    }
  }

  async apply(input: { chapterId?: string; token: string }): Promise<MemoryActionResult> {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const state = this.state(input.chapterId)
    if (state.chapterId === null || state.jobId === null) {
      throw new AppError('invalid_args', '本章还没有固化提案')
    }
    const proposalJobId = state.jobId
    const items = host.repos.memoryProposal.listByJob(project.id, proposalJobId)
    if (items.length === 0) throw new AppError('invalid_args', '提案为空')
    const decisions = items
      .filter((item) => item.decision !== 'pending')
      .map((item) => ({
        itemId: item.id,
        decision: item.decision === 'reject' ? ('reject' as const) : item.decision === 'edit' ? ('edit' as const) : ('accept' as const),
        editedText: item.editedText
      }))
    if (decisions.length === 0) throw new AppError('gate_required', '没有已决定的条目')
    if (decisions.some((decision) => decision.decision !== 'reject') === false) {
      throw new AppError('gate_required', '全部条目被拒绝，没有可应用的记忆')
    }

    checkAuthorGate({
      repos: host.repos,
      secret: this.deps.gateSecret,
      gateId: 'G7',
      entityType: 'proposal',
      entityId: proposalJobId,
      revision: null,
      token: input.token
    })

    const key = proposalJobKey(project.id, proposalJobId)
    const existing = host.repos.job.findByIdempotency(project.id, key)
    const applyJob =
      existing ??
      host.repos.job.insert({
        projectId: project.id,
        type: 'memory.apply',
        status: 'running',
        expectedRevision: null,
        epoch: project.writeEpoch,
        idempotencyKey: key,
        payloadJson: JSON.stringify({ proposalJobId, chapterId: state.chapterId, actor: 'author' })
      })
    if (existing !== null && existing.status === 'succeeded') {
      // 已经应用过：令牌不再消费，直接返回现存状态。
      return { state: this.state(state.chapterId), detail: '本章记忆已固化（重放）' }
    }
    try {
      const result = await applyMemoryProposals(
        host.db,
        host.repos,
        {
          projectId: project.id,
          proposalJobId,
          applyJobId: applyJob.id,
          actor: 'author',
          decisions,
          gateTokenHash: sha256Hex(input.token)
        },
        this.deps.embedder
      )
      invalidateRetrievalCache(project.id)
      host.repos.memoryMessage.insert({
        projectId: project.id,
        chapterId: state.chapterId,
        jobId: proposalJobId,
        role: 'system',
        kind: 'apply',
        body: `已应用 ${result.appliedCount} 条，拒绝 ${result.rejectedCount} 条${
          result.superseded.length > 0 ? `，取代 ${result.superseded.length} 条` : ''
        }`,
        meta: { applyJobId: applyJob.id, memoryIds: result.memoryIds }
      })
      this.log('memory_apply', {
        chapterId: state.chapterId,
        proposalJobId,
        applied: result.appliedCount,
        superseded: result.superseded.length,
        duplicate: result.duplicate
      })
      return {
        state: this.state(state.chapterId),
        detail: result.duplicate
          ? '重放：返回首次应用结果，未重复写入'
          : `已应用 ${result.appliedCount} 条记忆`
      }
    } catch (error) {
      host.repos.job.setStatus(applyJob.id, 'failed', {
        errorCode: error instanceof AppError ? error.code : 'internal_error'
      })
      throw error
    }
  }

  invalidate(input: { entryId: string; reason: string }): MemoryActionResult {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const entry = invalidateMemoryEntry(host.repos, {
      projectId: project.id,
      entryId: input.entryId,
      actor: 'author',
      reason: input.reason
    })
    invalidateRetrievalCache(project.id)
    return {
      state: this.state(entry.sourceChapterId),
      detail: '已标记失效（软失效，可追溯，不删除）'
    }
  }

  // ── 隔离回归（H5） ────────────────────────────────────────────────────────

  /**
   * 写向量之后再跑一次探针：每个角色用自己的记忆原文检索，
   * 命中集合必须全部属于本人；跨角色命中 = 0。
   * 命中任何一条别人的记忆即 `isolation_violation`。
   */
  async isolationReport(): Promise<{
    verified: boolean
    probes: Array<{ characterId: string; query: string; hits: number; foreign: number }>
  }> {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const characters = host.repos.character.list(project.id, { status: 'active' })
    const probes: Array<{ characterId: string; query: string; hits: number; foreign: number }> = []
    for (const character of characters) {
      const entries = host.repos.memory.listByCharacter(character.id, { status: 'active' })
      if (entries.length === 0) {
        probes.push({ characterId: character.id, query: '', hits: 0, foreign: 0 })
        continue
      }
      const query = entries[0]!.text.slice(0, 40)
      const result = await retrieveOwn(
        host.repos,
        this.deps.embedder,
        { text: query, topK: 8 },
        {
          projectId: project.id,
          actorId: `character:${character.id}`,
          characterId: character.id,
          asOf: project.seqHead
        }
      )
      const foreign = [...result.items, ...result.pinned].filter((item) => item.entry.characterId !== character.id).length
      probes.push({ characterId: character.id, query, hits: result.items.length + result.pinned.length, foreign })
    }
    const verified = probes.every((probe) => probe.foreign === 0)
    if (!verified) throw new AppError('isolation_violation', '跨角色检索命中他人记忆')
    // 只读探针：命名空间隔离在 G1 建库时已验证，这里只看「写向量后」的召回边界。
    return { verified, probes }
  }

  // ── 开发脚手架（未打包构建） ──────────────────────────────────────────────

  /**
   * E2E-MEMORY-01 脚手架：等价「G1 完成 + 第 1 章定稿 + 第 2 章已规划」。
   * 全部走真实原语（G2 物化、commitBeat、finalize），只是不调模型。
   * 定稿会入队 memory.extract（queued）；是否运行由页面/测试决定。
   */
  devSeed(input: { scenes?: number; beatsPerScene?: number; extraChapters?: number } = {}): MemoryState {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    if (host.repos.chapter.listByProject(project.id).length > 0) return this.state()

    const beatsPerScene = input.beatsPerScene ?? 6
    const extraChapters = input.extraChapters ?? 1
    host.repos.project.lockBlueprint(project.id)
    host.repos.project.setSetupState(project.id, 'complete')

    const cast = [
      { name: '沈昼', card: { identity: '女子', want: '找到账本', taboo: '父亲', voice: '短句' } },
      { name: '林砚', card: { identity: '男子', want: '守住祠堂', fear: '被逐出族谱', voice: '客气' } }
    ]
    const characterIds: string[] = []
    for (const person of cast) {
      const existing = host.repos.character.list(project.id).find((character) => character.name === person.name)
      if (existing) {
        characterIds.push(existing.id)
        continue
      }
      const created = host.repos.character.insert({
        projectId: project.id,
        name: person.name,
        cardJson: JSON.stringify(person.card)
      })
      characterIds.push(created.id)
    }
    const first = characterIds[0]!
    const second = characterIds[1]!

    const root = host.repos.outline.insert({
      projectId: project.id,
      parentId: null,
      kind: 'main',
      ord: 0,
      title: '主线',
      content: '账本与匣子',
      status: 'approved'
    })
    const node = host.repos.outline.insert({
      projectId: project.id,
      parentId: root.id,
      kind: 'chapter',
      ord: 1,
      title: '祠堂夜谈',
      content: '沈昼第一次听见匣子',
      status: 'approved'
    })
    const chapter = host.repos.chapter.insert({
      projectId: project.id,
      outlineNodeId: node.id,
      ord: 1,
      status: 'planned'
    })
    host.repos.world.insert({
      projectId: project.id,
      subject: '黑漆匣子',
      predicate: '位置',
      object: '祠堂供桌下面',
      truth: 'objective',
      visibility: 'secret',
      knownByJson: JSON.stringify([first]),
      validFromSeq: 0,
      sourceType: 'author'
    })
    saveStoryboardDraft(host.repos, {
      chapterId: chapter.id,
      updatedBy: 'author',
      scenes: Array.from({ length: input.scenes ?? 1 }, (_, sceneIndex) => ({
        location: `地点 ${sceneIndex + 1}`,
        participants: [first, second],
        goal: `第 ${sceneIndex + 1} 场目标`,
        entry: '',
        exit: `all(fact("黑漆匣子","位置"), beats(${beatsPerScene}))`,
        max_beats: Math.max(beatsPerScene, 4),
        beats: Array.from({ length: beatsPerScene }, (_, beatIndex) => ({
          speaker_type: beatIndex % 2 === 1 ? 'narrator' : 'character',
          speaker_id: beatIndex % 2 === 1 ? 'narrator' : beatIndex === 4 ? second : first,
          intent: `场景 ${sceneIndex + 1} 第 ${beatIndex + 1} 拍`,
          max_words: 200
        }))
      }))
    })
    confirmG2(host.db, host.repos, { chapterId: chapter.id, actor: 'author' })
    host.repos.chapter.setStatus(chapter.id, chapterTransition('storyboard_ready', 'START'))

    const lines = [
      '她把茶盏往他那边推了推，声音压得很低：「我爹书房里那只黑漆匣子，你见过没有？」',
      '他知道那匣子里装着什么，却只低头拨了拨灯芯，说：「没见过。」',
      '她把他的沉默当成回答：「账本在祠堂。」',
      '窗外的雨忽然大了，瓦上像有人在数拍子。',
      '他抬起头，第一次正眼看她：「你确定要问下去？」',
      '她没有退，手指扣住桌沿，指节发白。'
    ]
    const beats = host.repos.beat.listLiveByChapter(chapter.id)
    for (const [index, beat] of beats.entries()) {
      const body = lines[index % lines.length]!
      commitBeat(host.db, host.repos, {
        chapterId: chapter.id,
        expectedRevision: host.repos.chapter.get(chapter.id)!.currentRevisionId,
        epoch: project.writeEpoch,
        sceneId: beat.sceneId,
        ord: beat.ord,
        speakerType: beat.speakerType,
        speakerId: beat.speakerId,
        body,
        intent: beat.intent,
        supersedesId: beat.id,
        status: 'confirmed',
        maxWords: beat.maxWords,
        createdBy: 'doc_controller'
      })
    }
    markChapterComplete(host.db, host.repos, host.repos.chapter.get(chapter.id)!)

    const current = host.repos.chapter.get(chapter.id)!
    const issued = issueAuthorGate({
      repos: host.repos,
      secret: this.deps.gateSecret,
      projectId: project.id,
      gateId: 'G6',
      entityType: 'chapter',
      entityId: chapter.id,
      revision: current.currentRevisionId,
      jobId: `dev_g6_${newId('att')}`,
      actor: 'author'
    })
    finalizeChapter(host.db, host.repos, {
      chapterId: chapter.id,
      gateRecordId: issued.gateRecordId,
      actor: 'author',
      ackBlocking: true,
      ackUnreviewed: true,
      blocking: [],
      unreviewed: []
    })
    consumeAuthorGate(host.repos, issued.token)

    // 第 2 章：只规划，用于「下一章开演前能召回上一章记忆」。
    for (let index = 0; index < extraChapters; index += 1) {
      const node2 = host.repos.outline.insert({
        projectId: project.id,
        parentId: root.id,
        kind: 'chapter',
        ord: 2 + index,
        title: index === 0 ? '旧账最后一页' : `第 ${2 + index} 章`,
        content: '从穆掌柜手里拿到旧账',
        status: 'approved'
      })
      host.repos.chapter.insert({
        projectId: project.id,
        outlineNodeId: node2.id,
        ord: 2 + index,
        status: 'planned'
      })
    }

    ensureNamespaces(host.repos, project.id)
    invalidateRetrievalCache(project.id)
    return this.state(chapter.id)
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private selectChapter(
    repos: Repos,
    chapters: readonly MemoryChapterSummary[],
    chapterId?: string
  ): MemoryChapterSummary | null {
    if (chapterId !== undefined) {
      const found = chapters.find((chapter) => chapter.id === chapterId)
      if (!found) throw new AppError('invalid_args', '本章不存在', { chapterId })
      return found
    }
    const pending = chapters.find(
      (chapter) => chapter.jobStatus === 'proposed' || chapter.jobStatus === 'queued' || chapter.jobStatus === 'running'
    )
    if (pending) return pending
    const finalized = [...chapters].reverse().find((chapter) => chapter.finalRevisionId !== null)
    return finalized ?? chapters[0] ?? null
  }

  private proposalJobOf(repos: Repos, projectId: string, finalRevisionId: string | null): JobRecord | null {
    if (finalRevisionId === null) return null
    return repos.job.findByIdempotency(projectId, memoryJobKey(projectId, finalRevisionId))
  }

  private proposalStates(repos: Repos, jobId: string): MemoryProposalState[] {
    const project = repos.project.get()
    if (!project) return []
    const characters = new Map(repos.character.list(project.id).map((character) => [character.id, character.name]))
    return repos.memoryProposal.listByJob(project.id, jobId).map((item) => {
      const payload = parseJson(item.payloadJson)
      const downgrades = Array.isArray(payload.downgraded)
        ? payload.downgraded.filter((value): value is string => typeof value === 'string')
        : []
      return {
        id: item.id,
        kind: item.kind,
        characterId: item.characterId,
        characterName: item.characterId === null ? null : (characters.get(item.characterId) ?? item.characterId),
        text: item.text,
        editedText: item.editedText,
        decision: item.decision,
        evidence: { beatId: item.sourceBeatId ?? '', quote: item.evidenceQuote ?? '' },
        sourceChapterId: item.sourceChapterId,
        sourceRevisionId: item.sourceRevisionId,
        sourceBeatId: item.sourceBeatId,
        importance: item.importance,
        pinned: item.pinned === 1,
        downgrades,
        truth: payload.truth === 'objective' ? 'objective' : payload.truth === 'claim' ? 'claim' : null,
        payload
      }
    })
  }

  private jobSummaries(repos: Repos, projectId: string): MemoryJobSummary[] {
    const chapters = new Map(repos.chapter.listByProject(projectId).map((chapter) => [chapter.id, chapter]))
    return repos.job
      .listRecent(projectId, 40)
      .filter((job) => job.type === 'memory.extract')
      .map((job) => {
        const payload = job.payloadJson === null ? {} : parseJson(job.payloadJson)
        const chapterId = typeof payload.chapterId === 'string' ? payload.chapterId : null
        const chapter = chapterId === null ? null : (chapters.get(chapterId) ?? null)
        const items = repos.memoryProposal.listByJob(projectId, job.id)
        return {
          id: job.id,
          chapterId,
          chapterOrd: chapter?.ord ?? 0,
          chapterTitle:
            chapter === null
              ? '（未知章）'
              : (repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`),
          revisionId: job.expectedRevision,
          status: viewStatus(job) ?? 'queued',
          itemCount: items.length,
          appliedCount: resultCounts(job).applied,
          rejectedCount: items.filter((item) => item.decision === 'reject').length,
          mismatches: resultCounts(job).mismatches,
          errorCode: job.errorCode,
          createdAt: job.createdAt
        }
      })
  }

  private applyPreview(
    repos: Repos,
    projectId: string,
    proposalJobId: string
  ): { allowed: boolean; accepted: number; pending: number; rejected: number; blockers: string[] } {
    const items = repos.memoryProposal.listByJob(projectId, proposalJobId)
    const accepted = items.filter((item) => item.decision === 'accept' || item.decision === 'edit').length
    const pending = items.filter((item) => item.decision === 'pending').length
    const rejected = items.filter((item) => item.decision === 'reject').length
    const blockers: string[] = []
    if (items.length === 0) blockers.push('提案为空')
    if (accepted === 0) blockers.push('还没有已接受的条目')
    if (pending > 0) blockers.push(`还有 ${pending} 条未决定`)
    return { allowed: blockers.length === 0, accepted, pending, rejected, blockers }
  }

  private factState(fact: {
    id: string
    subject: string
    predicate: string
    object: string
    truth: 'objective' | 'claim'
    visibility: 'public' | 'secret'
    knownByJson: string
    revealSeq: number | null
    validFromSeq: number
    validToSeq: number | null
    sourceType: string
    sourceId: string | null
  }): WorldFactState {
    let knownBy: string[] = []
    try {
      const parsed = JSON.parse(fact.knownByJson) as unknown
      if (Array.isArray(parsed)) knownBy = parsed.filter((value): value is string => typeof value === 'string')
    } catch {
      knownBy = []
    }
    return {
      id: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      truth: fact.truth,
      visibility: fact.visibility,
      knownBy,
      revealSeq: fact.revealSeq,
      validFromSeq: fact.validFromSeq,
      validToSeq: fact.validToSeq,
      sourceType: fact.sourceType,
      sourceId: fact.sourceId
    }
  }

  private beliefState(
    belief: {
      id: string
      characterId: string
      beliefText: string
      confidence: number
      learnedSeq: number
      sourceType: string
      status: 'active' | 'inactive' | 'superseded'
    },
    characters: ReadonlyMap<string, string>
  ): BeliefState {
    return {
      id: belief.id,
      characterId: belief.characterId,
      characterName: characters.get(belief.characterId) ?? belief.characterId,
      beliefText: belief.beliefText,
      confidence: belief.confidence,
      learnedSeq: belief.learnedSeq,
      sourceType: belief.sourceType,
      status: belief.status
    }
  }

  private emit(event: MemoryEvent): void {
    this.deps.send(event)
  }

  private log(message: string, details: Record<string, unknown> = {}): void {
    this.deps.log?.(message, details)
  }

  private requireHost(): MemoryHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '请先打开一个项目')
    return host
  }

  private requireWritable(): MemoryHost {
    const host = this.requireHost()
    if (host.readOnly) throw new AppError('project_locked', '项目当前只读')
    return host
  }

  /** 供 T39 使用的应用端口：与作者侧 apply 共用同一个执行器。 */
  applyPort(): MemoryApplyPort {
    return {
      apply: async (input: MemoryApplyPortInput) => {
        const host = this.requireHost()
        const project = host.repos.project.get()
        if (!project) throw new AppError('project_not_found', 'no project in database')
        return applyMemoryProposals(
          host.db,
          host.repos,
          {
            projectId: project.id,
            proposalJobId: input.proposalJobId,
            applyJobId: input.applyJobId,
            actor: input.actor,
            decisions: input.decisions,
            gateTokenHash: input.gateTokenHash ?? null
          },
          this.deps.embedder
        )
      }
    }
  }

  /** 测试与 UI 共用的提案条目读取（不改状态）。 */
  proposalsOf(chapterId: string): MemoryProposalItemRecord[] {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) return []
    const chapter = host.repos.chapter.get(chapterId)
    if (!chapter) return []
    const job = this.proposalJobOf(host.repos, project.id, chapter.finalRevisionId)
    return job === null ? [] : host.repos.memoryProposal.listByJob(project.id, job.id)
  }
}
