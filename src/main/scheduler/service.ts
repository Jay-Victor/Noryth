import { AppError } from '../../shared/domain/app-error'
import type { Settings } from '../../shared/schema/project'
import { WRITE_STATUS_LABELS } from '../../shared/schema/write'
import type {
  WriteActionResult,
  WriteChapterSummary,
  WriteEvent,
  WriteMessageState,
  WriteSendResult,
  WriteState,
  WriteStoryboardState
} from '../../shared/schema/write'
import type { StoryboardConflict } from '../../shared/schema/storyboard'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord } from '../db/repos/beat'
import type { ChapterRecord } from '../db/repos/chapter'
import type { RegistrySnapshot } from '../tools/registry'
import type { ChatToolCall } from '../model/adapter'
import { confirmBeat, editBeat, parseGrounding } from '../doc/beats'
import { publishPendingMirrors } from '../doc/publish'
import {
  PAUSE_REASON_TEXT,
  chapterBudget,
  closeScene,
  evaluateSceneExit,
  markChapterComplete,
  nextActionableBeat,
  type PauseReason
} from './loop'
import { autoPreflight, runAutoLoop } from './auto'
import { confirmG2, previewG2 } from './g2'
import {
  readStoryboardDraft,
  saveStoryboardDraft,
  validateChapterStoryboard,
  validateScenes
} from './storyboard'
import { runBeatTurn, type BeatRunOutcome } from './beat'
import { runOrchestratorTurn } from './orchestrator'
import { WriteModelFactory } from './model'
import { resolveBinding } from '../model/bindings'
import { chapterTransition, sceneTransition } from './transitions'

/**
 * 创作台服务（PHASE-07 F1–F7）。
 *
 * 职责边界：
 * - 只发一拍；同项目写串行（this.running 单飞）。
 * - 正文只经 `runBeatTurn` → `commitBeat`；这里不写任何 beat.body。
 * - 暂停只在拍边界；取消停止读流，迟到结果由 expected_revision 拒绝。
 * - 章/场景状态推进只走 `transitions.ts` 的表。
 */

export interface WriteHost {
  dir: string
  db: Db
  repos: Repos
  readOnly: boolean
}

export interface WriteServiceDeps {
  host: () => WriteHost | null
  registry: RegistrySnapshot
  settings: () => Settings
  allowFakeModel: boolean
  gateSecret: string
  send: (event: WriteEvent) => void
  fakeChunkDelayMs?: number
  log?: (message: string, details?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
}

interface ChapterSession {
  mode: 'beat' | 'auto'
  pauseReason: PauseReason | null
  autoPaused: boolean
  pauseRequested: boolean
  cancelRequested: boolean
  lastError: string | null
}

export class WriteService {
  private readonly sessions = new Map<string, ChapterSession>()
  private running = false
  private autoRunning = false
  private abort: AbortController | null = null
  private eventSeq = 0
  private attemptSeq = 0
  private readonly models: WriteModelFactory

  constructor(private readonly deps: WriteServiceDeps) {
    this.models = new WriteModelFactory({
      allowFake: deps.allowFakeModel,
      getSettings: deps.settings,
      ...(deps.env === undefined ? {} : { env: deps.env }),
      ...(deps.fakeChunkDelayMs === undefined ? {} : { fakeChunkDelayMs: deps.fakeChunkDelayMs })
    })
  }

  // ── 读状态 ────────────────────────────────────────────────────────────────

  chapters(): WriteChapterSummary[] {
    const host = this.requireHost()
    return host.repos.chapter.listByProject(host.repos.project.get()!.id).map((chapter) => {
      const title = host.repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`
      const scenes = host.repos.scene.listByChapter(chapter.id)
      const beats = host.repos.beat.listLiveByChapter(chapter.id)
      return {
        id: chapter.id,
        ord: chapter.ord,
        title,
        status: chapter.status,
        sceneCount: scenes.length,
        beatCount: beats.length,
        confirmedCount: beats.filter((beat) => beat.status === 'confirmed' || beat.status === 'author_edited').length
      }
    })
  }

  state(chapterId?: string): WriteState {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const chapters = this.chapters()
    const chapter = chapterId
      ? host.repos.chapter.get(chapterId)
      : host.repos.chapter.listByProject(project.id)[0] ?? null
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId: chapterId ?? null })
    const session = this.sessionOf(chapter.id)
    const scenes = host.repos.scene.listByChapter(chapter.id)
    const beats = host.repos.beat.listLiveByChapter(chapter.id)
    const draft = readStoryboardDraft(host.repos, chapter.id)
    const conflicts = validateChapterStoryboard(host.repos, chapter.id)
    const g2 = previewG2(host.repos, chapter.id)
    const budget = chapterBudget(host.repos, chapter)
    const pauseEvent = host.repos.schedulerEvent.latestPause(chapter.id)
    const pauseReason =
      session.pauseReason ??
      (pauseEvent && pauseEvent.kind === 'paused' ? (pauseEvent.reason as PauseReason | null) : null)
    const sceneStates = scenes.map((entry) => {
      const sceneBeats = beats.filter((beat) => beat.sceneId === entry.scene.id)
      const exit = evaluateSceneExit(host.repos, chapter, entry, sceneBeats)
      const exitText = exitTextOf(entry.scene.exitJson)
      return {
        id: entry.scene.id,
        ord: entry.chapterOrd,
        location: entry.scene.location,
        participants: parseJsonArray(entry.scene.participantsJson),
        participantNames: parseJsonArray(entry.scene.participantsJson).map(
          (id) => host.repos.character.get(id)?.name ?? id
        ),
        goal: entry.scene.goal,
        entry: entry.scene.entry,
        exitText,
        exitValid: exit.decidable,
        exitReason: exit.reason,
        exitSatisfied: exit.satisfied,
        exitNodes: exit.nodes,
        status: entry.scene.status,
        maxBeats: entry.scene.maxBeats,
        totalBeats: sceneBeats.length,
        confirmed: sceneBeats.filter((beat) => beat.status === 'confirmed' || beat.status === 'author_edited').length,
        beats: sceneBeats.map((beat) => this.beatState(host.repos, beat, entry.chapterOrd))
      }
    })

    const storyboard: WriteStoryboardState = {
      exists: draft !== null,
      rev: draft?.rev ?? null,
      updatedBy: draft?.updatedBy ?? null,
      updatedAt: draft?.updatedAt ?? null,
      scenes: draft?.scenes ?? [],
      conflicts,
      materialized: scenes.length > 0
    }

    const nextBeat = nextActionableBeat(host.repos, chapter.id)
    const waiting = beats.find((beat) => beat.status === 'waiting_for_human')
    const preflight = scenes.length > 0 ? autoPreflight(host.repos, chapter.id) : null

    return {
      projectId: project.id,
      projectTitle: project.title,
      chapterId: chapter.id,
      chapterOrd: chapter.ord,
      chapterTitle: host.repos.outline.get(chapter.outlineNodeId)?.title ?? `第 ${chapter.ord} 章`,
      chapterStatus: chapter.status,
      readOnly: host.readOnly,
      setupState: project.setupState,
      blueprintLocked: project.blueprintLockedAt !== null,
      mode: session.mode,
      revisionId: chapter.currentRevisionId,
      contentHash: chapter.currentRevisionId
        ? (host.repos.revision.get(chapter.currentRevisionId)?.contentHash ?? null)
        : null,
      chapters,
      characters: host.repos.character.list(project.id).map((character) => ({
        id: character.id,
        name: character.name
      })),
      scenes: sceneStates,
      storyboard,
      g2: {
        ready: g2.ready,
        blocker: g2.blocker,
        sceneCount: g2.sceneCount,
        beatCount: g2.beatCount,
        maxBeats: g2.maxBeats,
        storyboardRev: g2.storyboardRev,
        conflicts: g2.conflicts
      },
      progress: {
        totalBeats: beats.length,
        confirmed: beats.filter((beat) => beat.status === 'confirmed' || beat.status === 'author_edited').length,
        scenesTotal: scenes.length,
        scenesClosed: scenes.filter((entry) => entry.scene.status === 'closed').length
      },
      currentBeatId: nextBeat?.id ?? waiting?.id ?? null,
      pauseReason,
      pauseText: pauseReason ? (PAUSE_REASON_TEXT[pauseReason] ?? session.lastError) : null,
      running: this.running || this.autoRunning,
      autoRunning: this.autoRunning,
      autoPaused: session.autoPaused,
      budget,
      preflight,
      messages: host.repos.writeMessage.listByChapter(chapter.id, 60).map(messageOf),
      events: host.repos.schedulerEvent.listByChapter(chapter.id, 60).map((event) => ({
        id: event.id,
        kind: event.kind,
        reason: event.reason,
        payload: parseJson(event.payloadJson),
        createdAt: event.createdAt
      })),
      model: this.models.status(host.repos)
    }
  }

  // ── F1 分镜与 G2 ──────────────────────────────────────────────────────────

  saveStoryboard(input: { chapterId: string; scenes: unknown }): { state: WriteState; conflicts: StoryboardConflict[] } {
    const host = this.requireWritable()
    const draft = saveStoryboardDraft(host.repos, {
      chapterId: input.chapterId,
      scenes: input.scenes,
      updatedBy: 'author'
    })
    const chapter = host.repos.chapter.get(input.chapterId)!
    const conflicts = validateScenes(host.repos, chapter.projectId, draft.scenes)
    return { state: this.state(input.chapterId), conflicts }
  }

  validateStoryboard(input: { chapterId: string; scenes: unknown }): StoryboardConflict[] {
    const host = this.requireHost()
    const chapter = host.repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId: input.chapterId })
    const parsed = Array.isArray(input.scenes) ? input.scenes : []
    if (parsed.length === 0) return []
    return validateScenes(host.repos, chapter.projectId, parsed as never)
  }

  g2Preview(chapterId: string) {
    const host = this.requireHost()
    return previewG2(host.repos, chapterId)
  }

  /**
   * 未打包构建的 E2E 脚手架：建一章 + 3×8 分镜草案（不经过 G1）。
   * 生产包不注册该通道；只用于 `tests/e2e/write.spec.ts`。
   */
  devSeed(input: { scenes?: number; beatsPerScene?: number; exit?: string } = {}): WriteState {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    if (host.repos.chapter.listByProject(project.id).length > 0) {
      return this.state()
    }
    const sceneCount = input.scenes ?? 3
    const beatsPerScene = input.beatsPerScene ?? 8
    const exit = input.exit ?? `all(fact("black_box","location"), beats(${beatsPerScene}))`

    // 脚手架等价于「G1 已完成」的状态，否则导航会禁用创作台。
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
        exit,
        max_beats: Math.max(beatsPerScene, 4),
        beats: Array.from({ length: beatsPerScene }, (_, beatIndex) => ({
          speaker_type: beatIndex % 2 === 1 ? 'narrator' : 'character',
          speaker_id: beatIndex % 2 === 1 ? 'narrator' : characterId,
          intent: `场景 ${sceneIndex + 1} 第 ${beatIndex + 1} 拍`,
          max_words: 200
        }))
      }))
    })
    return this.state(chapter.id)
  }

  confirmG2(chapterId: string): WriteActionResult {
    const host = this.requireWritable()
    if (this.running || this.autoRunning) throw new AppError('invalid_args', '正在生成，不能开演')
    const result = confirmG2(host.db, host.repos, { chapterId, actor: 'author' })
    this.log('write_g2_confirmed', { chapterId, sceneCount: result.sceneCount, beatCount: result.beatCount })
    return {
      state: this.state(chapterId),
      detail: `G2 通过：${result.sceneCount} 场 / ${result.beatCount} 拍`
    }
  }

  // ── F2/F4 发牌、确认、重生成、编辑 ───────────────────────────────────────

  async generate(beatId: string): Promise<WriteActionResult> {
    const host = this.requireWritable()
    if (this.running || this.autoRunning) throw new AppError('invalid_args', '已有生成任务在跑')
    const beat = host.repos.beat.get(beatId)
    if (!beat) throw new AppError('invalid_args', `beat ${beatId} not found`)
    const chapter = host.repos.chapter.get(beat.chapterId)
    if (!chapter) throw new AppError('invalid_args', '章不存在')
    const scene = host.repos.scene.get(beat.sceneId)
    if (!scene) throw new AppError('invalid_args', '场景不存在')
    if (scene.status === 'closed') {
      throw new AppError('invalid_args', '场景已收束，这一拍不再发牌', { sceneId: scene.id })
    }
    if (beat.status === 'confirmed' || beat.status === 'author_edited' || beat.status === 'superseded') {
      throw new AppError('invalid_args', '这一拍已经处理过；要重跑请用重生成', { status: beat.status })
    }

    this.running = true
    this.abort = new AbortController()
    this.setSession(chapter.id, { mode: 'beat', pauseReason: null, autoPaused: false, lastError: null })
    try {
      this.ensureChapterDrafting(host, chapter)
      this.ensureSceneOpen(host, beat)
      const outcome = await this.executeBeat(host, beat, chapter, 'interactive')
      if (outcome.status === 'refused') {
        this.handleRefusal(host, chapter, beat, outcome)
      } else if (outcome.status === 'rejected') {
        this.pause(chapter.id, 'model_error', {
          beatId: beat.id,
          code: outcome.code ?? 'invalid_grounding'
        })
      }
      return { state: this.state(chapter.id), detail: outcome.refusalReason ?? null }
    } catch (error) {
      this.pause(chapter.id, 'model_error', {
        beatId: beat.id,
        code: error instanceof AppError ? error.code : 'internal_error'
      })
      throw error
    } finally {
      this.running = false
      this.abort = null
    }
  }

  async regenerate(beatId: string): Promise<WriteActionResult> {
    return this.generate(beatId)
  }

  confirm(beatId: string): WriteActionResult {
    const host = this.requireWritable()
    if (this.running || this.autoRunning) throw new AppError('invalid_args', '生成中不能确认，请等本拍结束')
    const beat = host.repos.beat.get(beatId)
    if (!beat) throw new AppError('invalid_args', `beat ${beatId} not found`)
    const result = confirmBeat(host.db, host.repos, beatId, 'author')
    host.repos.schedulerEvent.insert({
      projectId: beat.chapterId ? (host.repos.chapter.get(beat.chapterId)?.projectId ?? '') : '',
      chapterId: beat.chapterId,
      jobId: null,
      kind: 'beat_confirmed',
      reason: null,
      payloadJson: JSON.stringify({ beatId, coveredUntilSeq: result.coveredUntilSeq })
    })
    this.publish(host)
    return { state: this.state(beat.chapterId), detail: result.staled.length > 0 ? `${result.staled.length} 拍被标 stale` : null }
  }

  edit(input: { beatId: string; body: string; expectedRevision: string | null }): WriteActionResult {
    const host = this.requireWritable()
    if (this.running || this.autoRunning) throw new AppError('invalid_args', '生成中不能编辑，请等本拍结束')
    const beat = host.repos.beat.get(input.beatId)
    if (!beat) throw new AppError('invalid_args', `beat ${input.beatId} not found`)
    const result = editBeat(host.db, host.repos, input)
    this.publish(host)
    return {
      state: this.state(beat.chapterId),
      detail:
        result.staled.length > 0
          ? `已保存；${result.staled.length} 拍需要处理（默认开新分支，所以旧正文保留）`
          : '已保存'
    }
  }

  /** 编辑已确认拍后的三选一（UI-DESIGN §5.4）：仅替换 / 替换并重跑后续 / 开新分支。 */
  resolveStale(input: { chapterId: string; beatId: string; choice: 'replace' | 'rerun' | 'branch' }): WriteActionResult {
    const host = this.requireWritable()
    const anchor = host.repos.beat.get(input.beatId)
    if (!anchor) throw new AppError('invalid_args', `beat ${input.beatId} not found`)
    const chapter = host.repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('invalid_args', '章不存在')
    const scenes = host.repos.scene.listByChapter(chapter.id)
    const ordOf = new Map(scenes.map((entry) => [entry.scene.id, entry.chapterOrd]))
    const anchorOrd = ordOf.get(anchor.sceneId) ?? 0
    const later = host.repos.beat
      .listLiveByChapter(chapter.id)
      .filter((beat) => beat.status === 'stale')
      .filter((beat) => {
        const sceneOrd = ordOf.get(beat.sceneId) ?? 0
        return sceneOrd > anchorOrd || (sceneOrd === anchorOrd && beat.ord > anchor.ord)
      })

    if (input.choice === 'branch') {
      return { state: this.state(chapter.id), detail: '已开新分支：旧正文保留，可继续确认新版本' }
    }
    if (input.choice === 'replace') {
      for (const beat of later) host.repos.beat.setStatus(beat.id, 'confirmed')
      return { state: this.state(chapter.id), detail: `已接受替换：${later.length} 拍保持原文` }
    }
    for (const beat of later) host.repos.beat.setStatus(beat.id, 'interrupted')
    return { state: this.state(chapter.id), detail: `将重跑 ${later.length} 拍` }
  }

  // ── F6 自动模式 ───────────────────────────────────────────────────────────

  preflight(chapterId: string) {
    const host = this.requireHost()
    this.requireMaterialized(host.repos, chapterId)
    return autoPreflight(host.repos, chapterId)
  }

  async autoStart(chapterId: string): Promise<WriteActionResult> {
    const host = this.requireWritable()
    if (this.running || this.autoRunning) throw new AppError('invalid_args', '已有生成任务在跑')
    const preflight = autoPreflight(host.repos, chapterId)
    if (!preflight.ready) {
      throw new AppError('invalid_args', `自动模式预检未通过：${preflight.blockers[0] ?? '未知原因'}`, {
        blockers: preflight.blockers
      })
    }
    this.setSession(chapterId, {
      mode: 'auto',
      pauseReason: null,
      autoPaused: false,
      pauseRequested: false,
      cancelRequested: false,
      lastError: null
    })
    this.autoRunning = true
    this.abort = new AbortController()
    const session = this.sessionOf(chapterId)
    try {
      const chapter = host.repos.chapter.get(chapterId)!
      this.ensureChapterDrafting(host, chapter)
      const result = await runAutoLoop(
        host.repos,
        chapter,
        {
          onPause: (reason) => {
            this.pause(chapterId, reason, { auto: true })
          },
          onComplete: () => {
            this.log('write_chapter_complete', { chapterId })
          },
          onSceneClosed: (sceneId, reason) => {
            this.log('write_scene_closed', { chapterId, sceneId, reason })
          },
          shouldPause: () => session.pauseRequested,
          shouldCancel: () => session.cancelRequested
        },
        async (beat) => {
          const fresh = host.repos.chapter.get(chapterId)!
          this.ensureSceneOpen(host, beat)
          try {
            const outcome = await this.executeBeat(host, beat, fresh, 'auto')
            if (outcome.status === 'refused') {
              this.handleRefusal(host, fresh, beat, outcome)
              return { status: 'refused' }
            }
            if (outcome.status === 'rejected') {
              return { status: 'failed', code: outcome.code ?? 'invalid_grounding' }
            }
            return { status: 'committed' }
          } catch (error) {
            return {
              status: 'failed',
              code: error instanceof AppError ? error.code : 'internal_error'
            }
          }
        },
        (sceneId, reason) => {
          const fresh = host.repos.chapter.get(chapterId)!
          const scene = host.repos.scene.listByChapter(chapterId).find((entry) => entry.scene.id === sceneId)
          if (!scene) return false
          const closed = closeScene(host.db, host.repos, { chapter: fresh, scene, reason })
          if (closed.chapterComplete) markChapterComplete(host.db, host.repos, fresh)
          return closed.chapterComplete
        }
      )
      if (result.stopped !== 'complete' && result.stopped !== 'character_refusal' && result.stopped !== 'model_error') {
        this.pause(chapterId, result.stopped as PauseReason, { beatsRun: result.beatsRun })
      }
      return { state: this.state(chapterId), detail: result.message }
    } finally {
      this.autoRunning = false
      this.abort = null
    }
  }

  pauseChapter(chapterId: string): WriteActionResult {
    this.requireHost()
    const session = this.sessionOf(chapterId)
    session.pauseRequested = true
    this.pause(chapterId, 'author_paused', {})
    return { state: this.state(chapterId), detail: PAUSE_REASON_TEXT.author_paused }
  }

  async resume(chapterId: string): Promise<WriteActionResult> {
    const host = this.requireWritable()
    const chapter = host.repos.chapter.get(chapterId)
    if (!chapter) throw new AppError('invalid_args', '章不存在')
    const session = this.sessionOf(chapterId)
    session.pauseReason = null
    session.autoPaused = false
    session.pauseRequested = false
    session.cancelRequested = false
    host.repos.schedulerEvent.insert({
      projectId: chapter.projectId,
      chapterId,
      jobId: null,
      kind: 'resumed',
      reason: null,
      payloadJson: '{}'
    })
    if (session.mode === 'auto') return this.autoStart(chapterId)
    return { state: this.state(chapterId), detail: '继续逐拍模式' }
  }

  cancel(chapterId: string): WriteActionResult {
    const host = this.requireHost()
    const session = this.sessionOf(chapterId)
    session.cancelRequested = true
    session.pauseRequested = true
    this.abort?.abort()
    const chapter = host.repos.chapter.get(chapterId)
    if (chapter) {
      const generating = host.repos.beat
        .listLiveByChapter(chapterId)
        .filter((beat) => beat.status === 'generating' || beat.status === 'regenerating')
      for (const beat of generating) host.repos.beat.setStatus(beat.id, 'interrupted')
      host.repos.schedulerEvent.insert({
        projectId: chapter.projectId,
        chapterId,
        jobId: null,
        kind: 'stopped',
        reason: 'author_cancelled',
        payloadJson: '{}'
      })
    }
    return { state: this.state(chapterId), detail: '已取消；迟到结果会被 revision 校验拒绝' }
  }

  // ── 编排对话（UI-DESIGN §5.3）：只改分镜草案，不写正文 ────────────────

  async send(input: { chapterId: string; text: string }): Promise<WriteSendResult> {
    const host = this.requireWritable()
    if (this.running || this.autoRunning) throw new AppError('invalid_args', '生成中不能发送编排消息')
    const chapter = host.repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('invalid_args', '章不存在')
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')

    host.repos.writeMessage.insert({
      projectId: project.id,
      chapterId: chapter.id,
      role: 'author',
      kind: 'text',
      body: input.text
    })
    const assistant = host.repos.writeMessage.insert({
      projectId: project.id,
      chapterId: chapter.id,
      role: 'orchestrator',
      kind: 'text',
      body: ''
    })

    const binding = resolveBinding(host.repos, project, 'orchestrator', this.models.capabilitiesLookup())
    const adapter = this.models.adapter(binding)
    const outcome = await runOrchestratorTurn(
      {
        repos: host.repos,
        registry: this.deps.registry,
        adapter,
        gateSecret: this.deps.gateSecret,
        allowTools: this.modelCapabilities(binding).tools !== false,
        hooks: {
          onText: (_delta, full) => {
            this.emit({
              projectId: project.id,
              chapterId: chapter.id,
              jobId: `write_${chapter.id}`,
              turnId: `oturn_${assistant.id}`,
              beatId: '',
              seq: this.nextEventSeq(),
              phase: 'delta',
              full
            })
          }
        }
      },
      { chapterId: chapter.id, messageId: assistant.id, text: input.text }
    )

    host.repos.writeMessage.insert({
      projectId: project.id,
      chapterId: chapter.id,
      role: 'orchestrator',
      kind: outcome.storyboardUpdated ? 'storyboard' : 'text',
      body: outcome.reply
    })
    this.log('write_orchestrator_reply', { chapterId: chapter.id, toolCalls: outcome.toolCalls })
    return {
      state: this.state(chapter.id),
      reply: outcome.reply,
      toolCalls: outcome.toolCalls,
      storyboardUpdated: outcome.storyboardUpdated
    }
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private sessionOf(chapterId: string): ChapterSession {
    const existing = this.sessions.get(chapterId)
    if (existing) return existing
    const created: ChapterSession = {
      mode: 'beat',
      pauseReason: null,
      autoPaused: false,
      pauseRequested: false,
      cancelRequested: false,
      lastError: null
    }
    this.sessions.set(chapterId, created)
    return created
  }

  private setSession(chapterId: string, patch: Partial<ChapterSession>): void {
    const session = this.sessionOf(chapterId)
    Object.assign(session, patch)
  }

  private beatState(repos: Repos, beat: BeatRecord, sceneOrd: number): WriteState['scenes'][number]['beats'][number] {
    const speakerName =
      beat.speakerType === 'narrator' ? '旁白' : (repos.character.get(beat.speakerId)?.name ?? beat.speakerId)
    return {
      id: beat.id,
      ord: beat.ord,
      sceneId: beat.sceneId,
      sceneOrd,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      speakerName,
      intent: beat.intent,
      body: beat.body,
      status: beat.status,
      grounding: parseGrounding(beat.groundingJson),
      traceRef: beat.traceRef,
      wordCount: beat.wordCount,
      maxWords: beat.maxWords,
      authorEdited: beat.authorEdited === 1,
      needsAttention: beat.status === 'stale' || beat.status === 'rejected' || beat.status === 'interrupted',
      updatedAt: beat.updatedAt
    }
  }

  private ensureChapterDrafting(host: WriteHost, chapter: ChapterRecord): void {
    if (chapter.status === 'storyboard_ready') {
      host.repos.chapter.setStatus(chapter.id, chapterTransition(chapter.status, 'START'))
      host.repos.chapter.markOpened(chapter.id)
      host.repos.schedulerEvent.insert({
        projectId: chapter.projectId,
        chapterId: chapter.id,
        jobId: null,
        kind: 'started',
        reason: null,
        payloadJson: '{}'
      })
      return
    }
    if (chapter.status === 'paused') {
      host.repos.chapter.setStatus(chapter.id, chapterTransition('paused', 'RESUME'))
    }
  }

  private ensureSceneOpen(host: WriteHost, beat: BeatRecord): void {
    const scene = host.repos.scene.get(beat.sceneId)
    if (!scene) throw new AppError('internal_error', '拍所属场景不存在', { beatId: beat.id })
    if (scene.status === 'planned' || scene.status === 'paused') {
      const event = scene.status === 'planned' ? 'OPEN' : 'RESUME'
      host.repos.scene.update(scene.id, { status: sceneTransition(scene.status, event) })
    }
  }

  private async executeBeat(
    host: WriteHost,
    beat: BeatRecord,
    chapter: ChapterRecord,
    mode: 'interactive' | 'auto'
  ): Promise<BeatRunOutcome> {
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const eventContext = { jobId: '', turnId: '' }
    let refusal: { code: string; reason: string } | null = null

    this.emit({
      projectId: project.id,
      chapterId: chapter.id,
      jobId: '',
      turnId: '',
      beatId: beat.id,
      seq: this.nextEventSeq(),
      phase: 'start'
    })

    const outcome = await runBeatTurn(
      {
        host,
        registry: this.deps.registry,
        adapterFor: (binding) => this.models.adapter(binding),
        gateSecret: this.deps.gateSecret,
        mode,
        capabilitiesLookup: this.models.capabilitiesLookup(),
        attempt: `${Date.now()}-${(this.attemptSeq += 1)}`,
        ...(this.abort === null ? {} : { signal: this.abort.signal }),
        onJob: (info) => {
          eventContext.jobId = info.jobId
          eventContext.turnId = info.turnId
        },
        hooks: {
          onText: (delta, full) => {
            this.emit({
              projectId: project.id,
              chapterId: chapter.id,
              jobId: eventContext.jobId,
              turnId: eventContext.turnId,
              beatId: beat.id,
              seq: this.nextEventSeq(),
              phase: 'delta',
              delta,
              full
            })
          },
          onThought: (delta, full) => {
            this.emit({
              projectId: project.id,
              chapterId: chapter.id,
              jobId: eventContext.jobId,
              turnId: eventContext.turnId,
              beatId: beat.id,
              seq: this.nextEventSeq(),
              phase: 'thought',
              delta,
              full
            })
          },
          onPhase: (phase) => {
            if (phase !== 'validated') return
            this.emit({
              projectId: project.id,
              chapterId: chapter.id,
              jobId: eventContext.jobId,
              turnId: eventContext.turnId,
              beatId: beat.id,
              seq: this.nextEventSeq(),
              phase: 'validated'
            })
          },
          onToolCall: (call) => {
            const refusalArgs = refusalOf(call)
            if (refusalArgs) refusal = refusalArgs
          }
        },
        refusalProbe: () => refusal
      },
      { beat, chapter }
    )

    if (outcome.status === 'committed') {
      this.emit({
        projectId: project.id,
        chapterId: chapter.id,
        jobId: outcome.jobId,
        turnId: outcome.turnId,
        beatId: outcome.beatId ?? beat.id,
        seq: this.nextEventSeq(),
        phase: 'committed',
        full: outcome.beatId ? (host.repos.beat.get(outcome.beatId)?.body ?? '') : ''
      })
      this.publish(host)
      host.repos.schedulerEvent.insert({
        projectId: project.id,
        chapterId: chapter.id,
        jobId: outcome.jobId,
        kind: 'beat_committed',
        reason: null,
        payloadJson: JSON.stringify({
          beatId: outcome.beatId,
          revisionId: outcome.revisionId,
          autoConfirmed: outcome.autoConfirmed,
          latencyMs: outcome.latencyMs
        })
      })
    } else if (outcome.status === 'rejected') {
      this.emit({
        projectId: project.id,
        chapterId: chapter.id,
        jobId: outcome.jobId,
        turnId: outcome.turnId,
        beatId: beat.id,
        seq: this.nextEventSeq(),
        phase: 'failed',
        code: outcome.code ?? 'invalid_grounding'
      })
    }
    return outcome
  }

  private handleRefusal(host: WriteHost, chapter: ChapterRecord, beat: BeatRecord, outcome: BeatRunOutcome): void {
    const reason = outcome.refusalReason ?? '角色拒演'
    host.repos.writeMessage.insert({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      role: 'system',
      kind: 'refusal',
      body: reason,
      metaJson: JSON.stringify({ beatId: beat.id, code: outcome.code })
    })
    this.pause(chapter.id, 'character_refusal', { beatId: beat.id, reason })
    this.emit({
      projectId: chapter.projectId,
      chapterId: chapter.id,
      jobId: outcome.jobId,
      turnId: outcome.turnId,
      beatId: beat.id,
      seq: this.nextEventSeq(),
      phase: 'paused',
      reason: 'character_refusal',
      code: outcome.code ?? 'character_refusal'
    })
  }

  private pause(chapterId: string, reason: PauseReason, detail: Record<string, unknown>): void {
    const host = this.requireHost()
    const chapter = host.repos.chapter.get(chapterId)
    if (!chapter) return
    const session = this.sessionOf(chapterId)
    session.pauseReason = reason
    session.autoPaused = this.autoRunning && reason !== 'draft_complete'
    host.repos.schedulerEvent.insert({
      projectId: chapter.projectId,
      chapterId,
      jobId: null,
      kind: 'paused',
      reason,
      payloadJson: JSON.stringify(detail)
    })
    host.repos.writeMessage.insert({
      projectId: chapter.projectId,
      chapterId,
      role: 'system',
      kind: reason === 'character_refusal' ? 'refusal' : 'pause',
      body: PAUSE_REASON_TEXT[reason] ?? String(reason),
      metaJson: JSON.stringify(detail)
    })
    this.log('write_paused', { chapterId, reason, ...detail })
  }

  private publish(host: WriteHost): void {
    try {
      const report = publishPendingMirrors(host.db, host.dir)
      if (report.failed.length > 0 || report.conflicts.length > 0) {
        this.log('write_mirror_pending', { failed: report.failed.length, conflicts: report.conflicts.length })
      }
    } catch (error) {
      this.log('write_mirror_failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  private emit(event: WriteEvent): void {
    this.deps.send(event)
  }

  private nextEventSeq(): number {
    this.eventSeq += 1
    return this.eventSeq
  }

  private requireHost(): WriteHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '请先打开一个项目')
    return host
  }

  private requireWritable(): WriteHost {
    const host = this.requireHost()
    if (host.readOnly) throw new AppError('project_locked', '项目当前只读')
    return host
  }

  private requireMaterialized(repos: Repos, chapterId: string): void {
    if (repos.scene.listByChapter(chapterId).length === 0) {
      throw new AppError('invalid_args', '本章还没有开演（先过 G2）', { chapterId })
    }
  }

  private modelCapabilities(binding: { capabilities?: { tools?: boolean } }): { tools?: boolean } {
    if (binding.capabilities) return binding.capabilities
    return { tools: true }
  }

  private log(message: string, details: Record<string, unknown> = {}): void {
    this.deps.log?.(message, details)
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function parseJsonArray(text: string): string[] {
  const value = parseJson(text)
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function exitTextOf(json: string): string {
  const value = parseJson(json)
  if (value === null || typeof value !== 'object') return ''
  const dsl = (value as { dsl?: unknown }).dsl
  if (typeof dsl === 'string') return dsl
  if (dsl === null || dsl === undefined) return ''
  try {
    return JSON.stringify(dsl)
  } catch {
    return ''
  }
}

function messageOf(message: {
  id: string
  role: string
  kind: string
  body: string
  createdAt: string
}): WriteMessageState {
  return {
    id: message.id,
    role: message.role as WriteMessageState['role'],
    kind: message.kind as WriteMessageState['kind'],
    body: message.body,
    createdAt: message.createdAt
  }
}

function refusalOf(call: ChatToolCall): { code: string; reason: string } | null {
  if (call.name !== 'refusal.raise') return null
  const parsed = parseJson(call.arguments.trim().length === 0 ? '{}' : call.arguments)
  if (parsed === null || typeof parsed !== 'object') {
    return { code: 'out_of_character', reason: '角色拒演' }
  }
  const record = parsed as Record<string, unknown>
  return {
    code: typeof record['code'] === 'string' ? record['code'] : 'out_of_character',
    reason: typeof record['reason'] === 'string' ? record['reason'] : '角色拒演'
  }
}

export { WRITE_STATUS_LABELS }
export type { StoryboardConflict }

