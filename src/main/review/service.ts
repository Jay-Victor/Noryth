import { AppError } from '../../shared/domain/app-error'
import type { Settings } from '../../shared/schema/project'
import type { DimensionKey } from '../../shared/schema/report'
import { REVIEW_ROUND_LIMIT } from '../../shared/schema/report'
import type {
  ReviewActionResult,
  ReviewChapterSummary,
  ReviewCompareResult,
  ReviewEvent,
  ReviewFinalizePreview,
  ReviewPatchState,
  ReviewReportState,
  ReviewSendResult,
  ReviewState,
  ReviewVersionState
} from '../../shared/schema/review'
import type { ReviewMessageRecord } from '../db/repos/review'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { ChapterRecord } from '../db/repos/chapter'
import type { PatchRecord } from '../db/repos/patch'
import { newId } from '../db/repos/common'
import { resolveBinding } from '../model/bindings'
import type { RegistrySnapshot } from '../tools/registry'
import { publishPendingMirrors } from '../doc/publish'
import { finalizeChapter } from '../doc/finalize'
import { chapterTransition } from '../scheduler/transitions'
import { commitBeat } from '../doc/commit-beat'
import { confirmG2 } from '../scheduler/g2'
import { markChapterComplete } from '../scheduler/loop'
import { saveStoryboardDraft } from '../scheduler/storyboard'
import { compareRevisions } from './diff'
import { checkAuthorGate, consumeAuthorGate, issueAuthorGate } from './gates'
import { chapterPatches, decidePatches } from './patch'
import { latestReport, parseReportRecord } from './report'
import {
  g5State,
  issueCountsByBeat,
  recheckScope,
  roundState,
  unreviewedChanges,
  type RoundState
} from './rounds'
import { runReviewTurn } from './run'
import { ReviewModelFactory } from './model'
import type { ApiKeyLookup } from '../model/keys'

/**
 * 审批台服务（PHASE-08 G1–G5）。
 *
 * 职责边界：
 * - 报告/patch 由 reviewer 运行时产出；正文只由 DocController（commitBeat /
 *   applyPatchBatch / finalizeChapter）写，本服务不碰 beat.body。
 * - G5/G6 令牌由作者侧签发：G5 绑定「本次 patch job」，G6 绑定「本章 + 当前 revision」。
 * - 讨论（send）永不改稿；只有 decide 与 finalize 会改变数据库。
 * - 同项目同一时刻只跑一个审批任务（running 单飞），取消用 AbortController。
 */

export interface ReviewHost {
  dir: string
  db: Db
  repos: Repos
  readOnly: boolean
}

export interface ReviewServiceDeps {
  host: () => ReviewHost | null
  registry: RegistrySnapshot
  settings: () => Settings
  allowFakeModel: boolean
  gateSecret: string
  send: (event: ReviewEvent) => void
  fakeChunkDelayMs?: number
  log?: (message: string, details?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
  /** 设置页注入的 Key 解析（safeStorage 优先）；省略时只用环境变量。 */
  apiKeyFor?: ApiKeyLookup
}

export class ReviewService {
  private running = false
  private abort: AbortController | null = null
  private readonly models: ReviewModelFactory

  constructor(private readonly deps: ReviewServiceDeps) {
    this.models = new ReviewModelFactory({
      allowFake: deps.allowFakeModel,
      getSettings: deps.settings,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.fakeChunkDelayMs === undefined ? {} : { fakeChunkDelayMs: deps.fakeChunkDelayMs }),
      ...(deps.apiKeyFor === undefined ? {} : { apiKeyFor: deps.apiKeyFor })
    })
  }

  // ── 读状态 ────────────────────────────────────────────────────────────────

  chapters(): ReviewChapterSummary[] {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) return []
    return host.repos.chapter.listByProject(project.id).map((chapter) => {
      const rounds = roundState(host.repos, chapter.id)
      return {
        id: chapter.id,
        ord: chapter.ord,
        title: host.repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`,
        status: chapter.status,
        rounds: rounds.rounds,
        verdict: rounds.latest?.verdict ?? null,
        invalidatedAt: chapter.invalidatedAt
      }
    })
  }

  state(chapterId?: string): ReviewState {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const chapters = this.chapters()
    const chapter = chapterId
      ? host.repos.chapter.get(chapterId)
      : (host.repos.chapter.listByProject(project.id)[0] ?? null)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId: chapterId ?? null })

    const rounds = roundState(host.repos, chapter.id)
    const reportRecord = rounds.latest
    const report = reportRecord ? (parseReportRecord(reportRecord) as ReviewReportState) : null
    const patches = chapterPatches(host.repos, chapter.id).map((patch) =>
      this.patchState(host.repos, patch, chapter.currentRevisionId)
    )
    const versions = host.repos.revision.listByChapter(chapter.id).map((revision) => ({
      id: revision.id,
      kind: revision.kind,
      parentRevisionId: revision.parentRevisionId,
      contentHash: revision.contentHash,
      createdBy: revision.createdBy,
      note: revision.note,
      memberCount: host.repos.revision.countMembers(revision.id),
      createdAt: revision.createdAt
    })) satisfies ReviewVersionState[]
    const counts = issueCountsByBeat(report?.blocking ?? [], report?.suggestions ?? [])
    const draft = this.draftBeats(host.repos, chapter, counts)
    const g5 = g5State(host.repos, chapter, rounds)
    const g6 = this.finalizePreviewOf(host.repos, chapter, rounds)

    return {
      projectId: project.id,
      projectTitle: project.title,
      chapterId: chapter.id,
      chapterOrd: chapter.ord,
      chapterTitle: host.repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`,
      chapterStatus: chapter.status,
      readOnly: host.readOnly,
      revisionId: chapter.currentRevisionId,
      contentHash: chapter.currentRevisionId
        ? (host.repos.revision.get(chapter.currentRevisionId)?.contentHash ?? null)
        : null,
      finalRevisionId: chapter.finalRevisionId,
      asOf: chapter.coveredUntilSeq,
      rounds: rounds.rounds,
      maxRounds: REVIEW_ROUND_LIMIT,
      takeover: rounds.takeover,
      chapters,
      draft,
      report,
      reports: rounds.reports.map((item) => {
        const parsed = parseReportRecord(item)
        return {
          id: parsed.id,
          round: parsed.round,
          verdict: parsed.verdict,
          blockingCount: parsed.blocking.length,
          suggestionCount: parsed.suggestions.length,
          scope: parsed.scope,
          createdAt: parsed.createdAt
        }
      }),
      patches,
      versions,
      g5,
      g6,
      messages: host.repos.reviewMessage
        .listByChapter(chapter.id, 80)
        .map((message) => this.messageState(message)),
      running: this.running,
      hasReport: report !== null,
      model: this.models.status(host.repos)
    }
  }

  finalizePreview(chapterId: string): ReviewFinalizePreview {
    const host = this.requireHost()
    const chapter = host.repos.chapter.get(chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId })
    return this.finalizePreviewOf(host.repos, chapter)
  }

  compare(input: {
    chapterId: string
    leftRevisionId: string
    rightRevisionId: string
  }): ReviewCompareResult {
    const host = this.requireHost()
    const chapter = host.repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId: input.chapterId })
    try {
      return compareRevisions(host.repos, input)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('invalid_args', '两个 revision 必须属于同一章', {
        left: input.leftRevisionId,
        right: input.rightRevisionId
      })
    }
  }

  // ── G4 报告 ───────────────────────────────────────────────────────────────

  async run(chapterId: string): Promise<ReviewActionResult> {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '已有审批任务在跑')
    const chapter = this.requireReviewableChapter(host.repos, chapterId)
    if (chapter.status === 'drafting' || chapter.status === 'planned' || chapter.status === 'storyboard_ready') {
      throw new AppError('invalid_args', '章节未完成初稿，G4 需要 draft_complete', { status: chapter.status })
    }

    this.running = true
    this.abort = new AbortController()
    const job = this.createJob(host, chapter, 'review.run', JSON.stringify({ mode: 'report' }))
    try {
      const outcome = await this.executeTurn(host, chapter, {
        mode: 'report',
        jobId: job.id,
        text: '请审这一章的初稿，按契约提交报告。'
      })
      const record = latestReport(host.repos, chapter.id)
      if (!record) throw new AppError('internal_error', '报告没有落库')
      if (chapter.status === 'draft_complete') {
        host.repos.chapter.setStatus(chapter.id, chapterTransition('draft_complete', 'REVIEW'))
      }
      host.repos.job.setStatus(job.id, outcome.degraded === null ? 'succeeded' : 'failed', {
        resultJson: JSON.stringify({
          report_id: record.id,
          round: record.round,
          verdict: record.verdict,
          degraded: record.degraded
        }),
        errorCode: outcome.degraded
      })
      this.log('review_report', {
        chapterId: chapter.id,
        reportId: record.id,
        round: record.round,
        verdict: record.verdict
      })
      const detail =
        record.degraded === 'schema_fallback'
          ? '报告 schema 解析失败，已降级为纯文本；建议重试结构化'
          : `第 ${record.round} 轮报告：${record.verdict}`
      // 先落运行态，再取快照：返回给 UI 的 state 不能带着「还在跑」的旧标记。
      this.running = false
      this.abort = null
      return { state: this.state(chapter.id), detail }
    } catch (error) {
      host.repos.job.setStatus(job.id, 'failed', {
        errorCode: error instanceof AppError ? error.code : 'internal_error'
      })
      throw error
    } finally {
      this.running = false
      this.abort = null
    }
  }

  // ── 讨论（不改稿） ────────────────────────────────────────────────────────

  async send(chapterId: string, text: string): Promise<ReviewSendResult> {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '审批任务进行中，请稍等')
    const chapter = this.requireReviewableChapter(host.repos, chapterId)
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const rounds = roundState(host.repos, chapter.id)

    host.repos.reviewMessage.insert({
      projectId: project.id,
      chapterId: chapter.id,
      round: rounds.rounds,
      role: 'author',
      kind: 'text',
      body: text
    })
    const assistant = host.repos.reviewMessage.insert({
      projectId: project.id,
      chapterId: chapter.id,
      round: rounds.rounds,
      role: 'reviewer',
      kind: 'text',
      body: ''
    })

    this.running = true
    this.abort = new AbortController()
    const job = this.createJob(host, chapter, 'review.run', JSON.stringify({ mode: 'discuss' }))
    try {
      const outcome = await this.executeTurn(host, chapter, {
        mode: 'discuss',
        jobId: job.id,
        messageId: assistant.id,
        text
      })
      host.repos.reviewMessage.insert({
        projectId: project.id,
        chapterId: chapter.id,
        round: rounds.rounds,
        role: 'reviewer',
        kind: 'text',
        body: outcome.reply
      })
      host.repos.job.setStatus(job.id, 'succeeded', {
        resultJson: JSON.stringify({ tool_calls: outcome.toolCalls })
      })
      this.running = false
      this.abort = null
      return {
        state: this.state(chapter.id),
        reply: outcome.reply,
        toolCalls: outcome.toolCalls,
        reportId: outcome.reportId,
        patchIds: outcome.patchIds
      }
    } catch (error) {
      host.repos.job.setStatus(job.id, 'failed', {
        errorCode: error instanceof AppError ? error.code : 'internal_error'
      })
      throw error
    } finally {
      this.running = false
      this.abort = null
    }
  }

  // ── G5：授权修订 + 产出 patch ─────────────────────────────────────────────

  async authorizeRevision(chapterId: string): Promise<ReviewActionResult> {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '已有审批任务在跑')
    const chapter = this.requireReviewableChapter(host.repos, chapterId)
    const rounds = roundState(host.repos, chapter.id)
    const gate = g5State(host.repos, chapter, rounds)
    if (!gate.allowed) throw new AppError('gate_required', gate.reason ?? '当前不能授权修订')
    if (chapter.currentRevisionId === null) throw new AppError('invalid_args', '本章还没有草稿 revision')

    this.running = true
    this.abort = new AbortController()
    const job = this.createJob(host, chapter, 'patch.propose', JSON.stringify({ mode: 'patch' }))
    const issued = issueAuthorGate({
      repos: host.repos,
      secret: this.deps.gateSecret,
      projectId: chapter.projectId,
      gateId: 'G5',
      entityType: 'revision',
      entityId: chapter.currentRevisionId,
      revision: chapter.currentRevisionId,
      jobId: job.id,
      actor: 'author'
    })
    try {
      const outcome = await this.executeTurn(host, chapter, {
        mode: 'patch',
        jobId: job.id,
        gateToken: issued.token,
        text: '请根据报告给出可逐条接受的 patch。'
      })
      if (outcome.patchIds.length > 0) {
        consumeAuthorGate(host.repos, issued.token)
        if (chapter.status === 'under_review') {
          host.repos.chapter.setStatus(chapter.id, chapterTransition('under_review', 'REVISE'))
        }
        host.repos.reviewMessage.insert({
          projectId: chapter.projectId,
          chapterId: chapter.id,
          round: rounds.rounds,
          role: 'system',
          kind: 'patch',
          body: `G5 授权：产出 ${outcome.patchIds.length} 条 patch`
        })
      }
      host.repos.job.setStatus(job.id, 'succeeded', {
        resultJson: JSON.stringify({ patch_ids: outcome.patchIds })
      })
      this.log('review_patches', { chapterId: chapter.id, patches: outcome.patchIds.length })
      this.running = false
      this.abort = null
      return {
        state: this.state(chapter.id),
        detail:
          outcome.patchIds.length > 0
            ? `已授权修订：${outcome.patchIds.length} 条 patch 待逐条决定`
            : '审批没有产出 patch；可以继续讨论或直接定稿'
      }
    } catch (error) {
      host.repos.job.setStatus(job.id, 'failed', {
        errorCode: error instanceof AppError ? error.code : 'internal_error'
      })
      throw error
    } finally {
      this.running = false
      this.abort = null
    }
  }

  // ── 逐条接受/拒绝 ─────────────────────────────────────────────────────────

  decide(input: {
    chapterId: string
    expectedRevision: string | null
    decisions: ReadonlyArray<{ patchId: string; accept: boolean }>
  }): ReviewActionResult {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '审批任务进行中，请稍等')
    const chapter = this.requireReviewableChapter(host.repos, input.chapterId)
    const rounds = roundState(host.repos, chapter.id)
    const result = decidePatches(host.db, host.repos, {
      chapterId: chapter.id,
      expectedRevision: input.expectedRevision,
      decisions: input.decisions
    })
    if (result.applied.length > 0) {
      host.repos.reviewMessage.insert({
        projectId: chapter.projectId,
        chapterId: chapter.id,
        round: rounds.rounds,
        role: 'system',
        kind: 'patch',
        body: `应用 ${result.applied.length} 条 patch（拒绝 ${result.rejected.length} 条）→ 新 revision ${result.revisionId}`
      })
    } else if (result.rejected.length > 0) {
      host.repos.reviewMessage.insert({
        projectId: chapter.projectId,
        chapterId: chapter.id,
        round: rounds.rounds,
        role: 'system',
        kind: 'patch',
        body: `拒绝 ${result.rejected.length} 条 patch，正文未变`
      })
    }
    this.publish(host)
    const detail =
      result.applied.length > 0
        ? `已应用 ${result.applied.length} 条 patch，生成新 revision`
        : result.rejected.length > 0
          ? `已拒绝 ${result.rejected.length} 条，正文未变`
          : null
    return { state: this.state(chapter.id), detail }
  }

  // ── 复检 ──────────────────────────────────────────────────────────────────

  async recheck(chapterId: string): Promise<ReviewActionResult> {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '已有审批任务在跑')
    const chapter = this.requireReviewableChapter(host.repos, chapterId)
    const rounds = roundState(host.repos, chapter.id)
    if (!rounds.latest) throw new AppError('invalid_args', '先生成审批报告（G4）')
    if (rounds.takeover) throw new AppError('human_takeover', '已修订 3 轮，转人工；请直接处理或定稿')
    const scope: DimensionKey[] = this.recheckScopeOf(rounds)

    this.running = true
    this.abort = new AbortController()
    const job = this.createJob(host, chapter, 'review.run', JSON.stringify({ mode: 'recheck', scope }))
    try {
      await this.executeTurn(host, chapter, {
        mode: 'recheck',
        jobId: job.id,
        scope,
        text: '请复检修订后的正文，只检查指定维度。'
      })
      const record = latestReport(host.repos, chapter.id)
      if (!record) throw new AppError('internal_error', '复检报告没有落库')
      if (record.verdict !== 'fail') {
        if (chapter.status === 'under_review' || chapter.status === 'revising') {
          host.repos.chapter.setStatus(chapter.id, chapterTransition(chapter.status, 'APPROVE'))
        }
      } else if (chapter.status === 'approved') {
        host.repos.chapter.setStatus(chapter.id, chapterTransition('approved', 'REVISE'))
      }
      host.repos.job.setStatus(job.id, 'succeeded', {
        resultJson: JSON.stringify({ report_id: record.id, verdict: record.verdict, scope })
      })
      this.log('review_recheck', { chapterId: chapter.id, round: record.round, verdict: record.verdict })
      this.running = false
      this.abort = null
      return {
        state: this.state(chapter.id),
        detail: `复检（${scope.length} 个维度）：${record.verdict}`
      }
    } catch (error) {
      host.repos.job.setStatus(job.id, 'failed', {
        errorCode: error instanceof AppError ? error.code : 'internal_error'
      })
      throw error
    } finally {
      this.running = false
      this.abort = null
    }
  }

  // ── G6：令牌 + 定稿 ───────────────────────────────────────────────────────

  issueFinalizeToken(chapterId: string): { token: string; expiresAt: string; preview: ReviewFinalizePreview } {
    const host = this.requireWritable()
    const chapter = this.requireChapter(host.repos, chapterId)
    if (chapter.status === 'finalized') {
      throw new AppError('already_finalized', '本章已定稿', { chapterId: chapter.id })
    }
    if (chapter.currentRevisionId === null) throw new AppError('invalid_args', '本章还没有草稿')
    const preview = this.finalizePreviewOf(host.repos, chapter)
    if (!preview.ready) throw new AppError('gate_required', preview.blockers[0] ?? '当前不能定稿')
    const issued = issueAuthorGate({
      repos: host.repos,
      secret: this.deps.gateSecret,
      projectId: chapter.projectId,
      gateId: 'G6',
      entityType: 'chapter',
      entityId: chapter.id,
      revision: chapter.currentRevisionId,
      jobId: `author_g6_${newId('att')}`,
      actor: 'author'
    })
    host.repos.reviewMessage.insert({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      round: preview.rounds,
      role: 'system',
      kind: 'text',
      body: 'G6 令牌已签发（10 分钟有效）'
    })
    return { token: issued.token, expiresAt: issued.expiresAt, preview }
  }

  finalize(input: {
    chapterId: string
    token: string
    ackBlocking: boolean
    ackUnreviewed: boolean
    reason?: string
  }): ReviewActionResult {
    const host = this.requireWritable()
    const chapter = this.requireChapter(host.repos, input.chapterId)
    if (chapter.status === 'finalized') {
      return { state: this.state(chapter.id), detail: '本章已定稿' }
    }
    const rounds = roundState(host.repos, chapter.id)
    const preview = this.finalizePreviewOf(host.repos, chapter, rounds)
    const record = checkAuthorGate({
      repos: host.repos,
      secret: this.deps.gateSecret,
      gateId: 'G6',
      entityType: 'chapter',
      entityId: chapter.id,
      revision: chapter.currentRevisionId,
      token: input.token
    })
    const result = finalizeChapter(host.db, host.repos, {
      chapterId: chapter.id,
      gateRecordId: record.id,
      actor: 'author',
      ackBlocking: input.ackBlocking,
      ackUnreviewed: input.ackUnreviewed,
      blocking: preview.blocking,
      unreviewed: preview.unreviewed,
      reason: input.reason ?? null
    })
    consumeAuthorGate(host.repos, input.token)
    host.repos.reviewMessage.insert({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      round: rounds.rounds,
      role: 'system',
      kind: 'text',
      body: `已定稿：final revision ${result.finalRevisionId}${
        result.memoryJobId ? `；memory.extract ${result.memoryJobId} 已入队` : ''
      }`
    })
    this.publish(host)
    this.log('review_finalized', {
      chapterId: chapter.id,
      finalRevisionId: result.finalRevisionId,
      memoryJobId: result.memoryJobId
    })
    return {
      state: this.state(chapter.id),
      detail: result.alreadyFinalized ? '本章此前已定稿' : '已定稿：正文冻结，记忆抽取已入队'
    }
  }

  // ── 开发脚手架（未打包构建） ──────────────────────────────────────────────

  /**
   * E2E-REVIEW-01 的脚手架：等价「G1 完成 + 一章分镜 + G2 + 6 拍已确认」，
   * 全部走真实原语（G2 物化、commitBeat、markChapterComplete），只是不调模型。
   * 生产包不注册该通道。
   */
  devSeed(input: { scenes?: number; beatsPerScene?: number } = {}): ReviewState {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    if (host.repos.chapter.listByProject(project.id).length > 0) {
      return this.state()
    }
    const sceneCount = input.scenes ?? 1
    const beatsPerScene = input.beatsPerScene ?? 6
    host.repos.project.lockBlueprint(project.id)
    host.repos.project.setSetupState(project.id, 'complete')
    const character = host.repos.character.list(project.id)[0]
    const characterId = character?.id ?? 'chr_dev'
    if (!character) {
      host.repos.character.insert({
        id: characterId,
        projectId: project.id,
        name: '沈昼',
        cardJson: JSON.stringify({ identity: '女子', want: '找到账本', taboo: '父亲' })
      })
    }
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
      subject: 'black_box',
      predicate: 'location',
      object: '祠堂供桌下面',
      truth: 'objective',
      visibility: 'public',
      validFromSeq: 0,
      sourceType: 'author'
    })
    saveStoryboardDraft(host.repos, {
      chapterId: chapter.id,
      updatedBy: 'author',
      scenes: Array.from({ length: sceneCount }, (_, sceneIndex) => ({
        location: `地点 ${sceneIndex + 1}`,
        participants: [characterId],
        goal: `第 ${sceneIndex + 1} 场目标`,
        entry: '',
        exit: `all(fact("black_box","location"), beats(${beatsPerScene}))`,
        max_beats: Math.max(beatsPerScene, 4),
        beats: Array.from({ length: beatsPerScene }, (_, beatIndex) => ({
          speaker_type: beatIndex % 2 === 1 ? 'narrator' : 'character',
          speaker_id: beatIndex % 2 === 1 ? 'narrator' : characterId,
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
    const fresh = host.repos.chapter.get(chapter.id)!
    markChapterComplete(host.db, host.repos, fresh)
    this.publish(host)
    return this.state(chapter.id)
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async executeTurn(
    host: ReviewHost,
    chapter: ChapterRecord,
    options: {
      mode: 'report' | 'recheck' | 'patch' | 'discuss'
      jobId: string
      messageId?: string
      scope?: readonly DimensionKey[]
      text?: string
      gateToken?: string
    }
  ): Promise<{ reply: string; toolCalls: number; reportId: string | null; patchIds: string[]; degraded: string | null }> {
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const messageId = options.messageId ?? newId('rmsg')
    this.emit({
      projectId: project.id,
      chapterId: chapter.id,
      jobId: options.jobId,
      phase: 'start'
    })
    try {
      const outcome = await runReviewTurn(
        {
          db: host.db,
          repos: host.repos,
          registry: this.deps.registry,
          adapter: this.models.adapter(
            resolveBinding(host.repos, project, 'reviewer', this.models.capabilitiesLookup())
          ),
          gateSecret: this.deps.gateSecret,
          capabilitiesLookup: this.models.capabilitiesLookup(),
          ...(this.abort === null ? {} : { signal: this.abort.signal }),
          hooks: {
            onText: (delta, full) => {
              this.emit({
                projectId: project.id,
                chapterId: chapter.id,
                jobId: options.jobId,
                phase: 'delta',
                delta,
                full
              })
            }
          }
        },
        {
          chapterId: chapter.id,
          messageId,
          mode: options.mode,
          ...(options.scope === undefined ? {} : { scope: options.scope }),
          ...(options.text === undefined ? {} : { text: options.text }),
          ...(options.gateToken === undefined ? {} : { gateToken: options.gateToken }),
          jobId: options.jobId
        }
      )
      this.emit({ projectId: project.id, chapterId: chapter.id, jobId: options.jobId, phase: 'done' })
      return {
        reply: outcome.reply,
        toolCalls: outcome.toolCalls,
        reportId: outcome.reportId,
        patchIds: outcome.patchIds,
        degraded: outcome.degraded
      }
    } catch (error) {
      this.emit({
        projectId: project.id,
        chapterId: chapter.id,
        jobId: options.jobId,
        phase: 'failed',
        code: error instanceof AppError ? error.code : 'internal_error'
      })
      throw error
    }
  }

  private createJob(
    host: ReviewHost,
    chapter: ChapterRecord,
    type: 'review.run' | 'patch.propose',
    payloadJson: string
  ) {
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    return host.repos.job.insert({
      projectId: project.id,
      type,
      status: 'running',
      expectedRevision: chapter.currentRevisionId,
      epoch: project.writeEpoch,
      idempotencyKey: `${type}:${chapter.id}:${Date.now().toString(36)}:${newId('k').slice(-6)}`,
      payloadJson: JSON.stringify({ chapterId: chapter.id, ...(JSON.parse(payloadJson) as object) })
    })
  }

  private draftBeats(
    repos: Repos,
    chapter: ChapterRecord,
    counts: Map<string, { blocking: number; suggestions: number }>
  ): ReviewState['draft'] {
    if (chapter.currentRevisionId === null) return []
    return repos.revision.manifest(chapter.currentRevisionId).map((member) => {
      const beat = repos.beat.get(member.beatId)
      const count = counts.get(member.beatId) ?? { blocking: 0, suggestions: 0 }
      return {
        beatId: member.beatId,
        ord: member.beatOrd,
        sceneOrd: member.sceneOrd,
        speakerType: member.speakerType,
        speakerName:
          member.speakerType === 'narrator'
            ? '旁白'
            : (repos.character.get(member.speakerId)?.name ?? member.speakerId),
        body: member.body,
        status: beat?.status ?? 'confirmed',
        wordCount: [...member.body].length,
        blockingCount: count.blocking,
        suggestionCount: count.suggestions
      }
    })
  }

  private patchState(repos: Repos, patch: PatchRecord, currentRevisionId: string | null): ReviewPatchState {
    const beat = repos.beat.get(patch.beatId)
    const slots = beat ? repos.scene.listByChapter(beat.chapterId) : []
    const sceneOrd = slots.find((entry) => entry.scene.id === beat?.sceneId)?.chapterOrd ?? 0
    // 作者改了稿 → 旧 base 上的待决提案不能再套用：对外显示 superseded，
    // 数据库仍保留 proposed/revision_id 供审计，真正拒绝发生在 decidePatches。
    const status: ReviewPatchState['status'] =
      patch.status === 'proposed' && patch.revisionId !== currentRevisionId ? 'superseded' : patch.status
    return {
      id: patch.id,
      proposalId: patch.proposalId,
      revisionId: patch.revisionId,
      beatId: patch.beatId,
      sceneOrd: sceneOrd,
      beatOrd: beat?.ord ?? 0,
      speakerName:
        beat?.speakerType === 'narrator'
          ? '旁白'
          : (beat && repos.character.get(beat.speakerId)?.name) || beat?.speakerId || '',
      before: patch.before,
      after: patch.after,
      reason: patch.reason,
      issueRef: patch.issueRef,
      status,
      appliedRevisionId: patch.appliedRevisionId,
      createdAt: patch.createdAt,
      decidedAt: patch.decidedAt
    }
  }

  private messageState(message: ReviewMessageRecord) {
    return {
      id: message.id,
      round: message.round,
      role: message.role,
      kind: message.kind,
      body: message.body,
      createdAt: message.createdAt
    }
  }

  private finalizePreviewOf(
    repos: Repos,
    chapter: ChapterRecord,
    rounds: RoundState = roundState(repos, chapter.id)
  ): ReviewFinalizePreview {
    const latest = rounds.latest ? parseReportRecord(rounds.latest) : null
    const unreviewed = unreviewedChanges(repos, chapter, rounds.latest)
    const blocking = latest?.blocking ?? []
    const blockers: string[] = []
    if (chapter.currentRevisionId === null) blockers.push('本章还没有草稿')
    if (!rounds.latest) blockers.push('先生成审批报告（或勾选「跳过审批」）')
    if (blocking.length > 0) blockers.push(`有 ${blocking.length} 条阻断：${blocking[0]?.issue_id ?? ''}`)
    if (unreviewed.count > 0) blockers.push(`有 ${unreviewed.count} 处改动未复检`)
    return {
      ready: chapter.currentRevisionId !== null && chapter.status !== 'finalized',
      blockers,
      blocking,
      unreviewed: unreviewed.items,
      unreviewedCount: unreviewed.count,
      rounds: rounds.rounds,
      takeover: rounds.takeover,
      alreadyFinalized: chapter.status === 'finalized',
      finalRevisionId: chapter.finalRevisionId
    }
  }

  private recheckScopeOf(rounds: RoundState): DimensionKey[] {
    return recheckScope(rounds.latest)
  }

  private requireChapter(repos: Repos, chapterId: string): ChapterRecord {
    const chapter = repos.chapter.get(chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId })
    return chapter
  }

  private requireReviewableChapter(repos: Repos, chapterId: string): ChapterRecord {
    const chapter = this.requireChapter(repos, chapterId)
    if (chapter.status === 'finalized') {
      throw new AppError('already_finalized', '本章已定稿，审批台只读', { chapterId })
    }
    return chapter
  }

  private publish(host: ReviewHost): void {
    try {
      const report = publishPendingMirrors(host.db, host.dir)
      if (report.failed.length > 0 || report.conflicts.length > 0) {
        this.log('review_mirror_pending', {
          failed: report.failed.length,
          conflicts: report.conflicts.length
        })
      }
    } catch (error) {
      this.log('review_mirror_failed', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  private emit(event: ReviewEvent): void {
    this.deps.send(event)
  }

  private requireHost(): ReviewHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '请先打开一个项目')
    return host
  }

  private requireWritable(): ReviewHost {
    const host = this.requireHost()
    if (host.readOnly) throw new AppError('project_locked', '项目当前只读')
    return host
  }

  private log(message: string, details: Record<string, unknown> = {}): void {
    this.deps.log?.(message, details)
  }
}
