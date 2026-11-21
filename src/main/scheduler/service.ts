import { AppError } from '../../shared/domain/app-error'
import type { Settings } from '../../shared/schema/project'
import { WRITE_STATUS_LABELS } from '../../shared/schema/write'
import type {
  WriteActionResult,
  WriteChapterSummary,
  WriteContextInspection,
  WriteEvent,
  WriteMessageState,
  WriteSendResult,
  WriteState,
  WriteStoryboardState,
  WriteTimeline
} from '../../shared/schema/write'
import type { StoryboardConflict } from '../../shared/schema/storyboard'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord } from '../db/repos/beat'
import type { ChapterRecord } from '../db/repos/chapter'
import type { RegistrySnapshot } from '../tools/registry'
import type { Embedder } from '../memory/embed/types'
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
  type BudgetState,
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
import {
  forkSceneIntoChapter,
  linkSceneToChapter,
  removeScene,
  reorderChapterScenes,
  sceneLibraryEntries,
  unlinkSceneFromChapter,
  updateSceneTime
} from './scene-library'
import { queryTimeline } from '../tools/support/timeline'
import { runBeatTurn, type BeatRunOutcome } from './beat'
import { syncSceneVoice } from '../voice/service'
import { runOrchestratorTurn } from './orchestrator'
import { WriteModelFactory } from './model'
import { resolveBinding } from '../model/bindings'
import { beatTransition, chapterTransition, sceneTransition } from './transitions'
import type { ApiKeyLookup } from '../model/keys'

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
  /** 记忆检索的嵌入器（阶段 09）；缺省时角色检索降级为关键词。 */
  embedder?: Embedder
  send: (event: WriteEvent) => void
  fakeChunkDelayMs?: number
  log?: (message: string, details?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
  /** 设置页注入的 Key 解析（safeStorage 优先）；省略时只用环境变量。 */
  apiKeyFor?: ApiKeyLookup
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
      ...(deps.fakeChunkDelayMs === undefined ? {} : { fakeChunkDelayMs: deps.fakeChunkDelayMs }),
      ...(deps.apiKeyFor === undefined ? {} : { apiKeyFor: deps.apiKeyFor })
    })
  }

  // ── 读状态 ────────────────────────────────────────────────────────────────

  chapters(): WriteChapterSummary[] {
    const host = this.requireHost()
    // 列表只取摘要：30 章时不再逐章读取 14 万字正文（PHASE-11 M1-9）。
    return host.repos.chapter.listSummaries(host.repos.project.get()!.id).map((chapter) => ({
      id: chapter.id,
      ord: chapter.ord,
      title: chapter.title,
      status: chapter.status,
      sceneCount: chapter.sceneCount,
      beatCount: chapter.beatCount,
      confirmedCount: chapter.confirmedCount,
      wordCount: chapter.wordCount,
      invalidatedAt: chapter.invalidatedAt
    }))
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
    // 引用判定：场景 live 拍归谁；一次查询覆盖整章（PHASE-12 M1-1）。
    const usageByScene = new Map<string, { chapterId: string; chapterOrd: number }>()
    for (const row of host.repos.scene.listUsageByProject(project.id)) {
      if (!usageByScene.has(row.sceneId)) {
        usageByScene.set(row.sceneId, { chapterId: row.chapterId, chapterOrd: row.chapterOrd })
      }
    }
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
      const owner = usageByScene.get(entry.scene.id) ?? null
      const referenceChapterOrd = owner !== null && owner.chapterId !== chapter.id ? owner.chapterOrd : null
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
        timeline: entry.scene.timeline,
        storyStart: entry.scene.storyStart,
        storyEnd: entry.scene.storyEnd,
        referenceChapterOrd,
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
      library: sceneLibraryEntries(host.repos, project.id, chapter.id),
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
    const conflicts = validateScenes(host.repos, chapter.projectId, draft.scenes, chapter.id)
    return { state: this.state(input.chapterId), conflicts }
  }

  validateStoryboard(input: { chapterId: string; scenes: unknown }): StoryboardConflict[] {
    const host = this.requireHost()
    const chapter = host.repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId: input.chapterId })
    const parsed = Array.isArray(input.scenes) ? input.scenes : []
    if (parsed.length === 0) return []
    return validateScenes(host.repos, chapter.projectId, parsed as never, chapter.id)
  }

  g2Preview(chapterId: string) {
    const host = this.requireHost()
    return previewG2(host.repos, chapterId)
  }

  /**
   * 未打包构建的 E2E 脚手架：建一章 + 3×8 分镜草案（不经过 G1）。
   * 生产包不注册该通道；只用于 `tests/e2e/write.spec.ts`。
   */
  devSeed(input: {
    scenes?: number
    beatsPerScene?: number
    chapters?: number
    seedEveryChapter?: boolean
    characters?: number
    /** 卷数（1–3）；>1 时按 chaptersPerVolume 铺章，chapters 忽略。 */
    volumes?: number
    chaptersPerVolume?: number
    exit?: string
  } = {}): WriteState {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    if (host.repos.chapter.listByProject(project.id).length > 0) {
      return this.state()
    }
    const sceneCount = input.scenes ?? 3
    const beatsPerScene = input.beatsPerScene ?? 8
    const chapterCount = input.chapters ?? 1
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
    // M1 长跑需要第二个角色：关系提案的目标不能是自己（relationship_edge 有 from<>to CHECK）。
    const characterIds = [characterId]
    const extras = Math.max(1, Math.min(input.characters ?? 1, 5))
    const extraNames = ['沈砚', '周叙', '柳七', '管事']
    for (let index = 1; index < extras; index += 1) {
      const id = `chr_dev_${index}`
      host.repos.character.insert({
        id,
        projectId: project.id,
        name: extraNames[index - 1] ?? `配角 ${index}`,
        cardJson: JSON.stringify({ identity: '族中亲眷', want: '守住祠堂' })
      })
      characterIds.push(id)
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
    // M1 长跑（PHASE-18 §5.2）用 volumes × chaptersPerVolume 造 3 卷 × 10 章：
    // 卷是 outline 的中间层，章 ord 仍全局递增。卷存在时第一章挂在第 1 卷下，
    // 不能在根上再放一个 ord=1 的章（outline_child_ord 唯一）。
    const volumes = Math.max(1, Math.min(input.volumes ?? 1, 3))
    const chaptersPerVolume = Math.max(1, Math.min(input.chaptersPerVolume ?? chapterCount, 10))
    const createChapter = (parentId: string, ord: number, title: string, content: string): string => {
      const outline = host.repos.outline.insert({
        projectId: project.id,
        parentId,
        kind: 'chapter',
        ord,
        title,
        content,
        status: ord === 1 ? 'approved' : 'draft'
      })
      const created = host.repos.chapter.insert({
        projectId: project.id,
        outlineNodeId: outline.id,
        ord,
        status: 'planned'
      })
      return created.id
    }

    let chapterId = ''
    const extraChapterIds: string[] = []
    if (volumes > 1) {
      for (let volumeIndex = 1; volumeIndex <= volumes; volumeIndex += 1) {
        const volume = host.repos.outline.insert({
          projectId: project.id,
          parentId: root.id,
          kind: 'volume',
          ord: volumeIndex,
          title: `第 ${volumeIndex} 卷`,
          content: '',
          status: 'approved'
        })
        for (let index = 1; index <= chaptersPerVolume; index += 1) {
          const ord = (volumeIndex - 1) * chaptersPerVolume + index
          const created = createChapter(
            volume.id,
            ord,
            ord === 1 ? '祠堂夜谈' : `第 ${ord} 章`,
            ord === 1 ? '沈昼第一次听见匣子' : ''
          )
          if (ord === 1) chapterId = created
          else extraChapterIds.push(created)
        }
      }
    } else {
      chapterId = createChapter(root.id, 1, '祠堂夜谈', '沈昼第一次听见匣子')
      for (let ord = 2; ord <= chapterCount; ord += 1) {
        extraChapterIds.push(createChapter(root.id, ord, `第 ${ord} 章`, ''))
      }
    }
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

    if (chapterId === '') throw new AppError('internal_error', 'devSeed 没有建出第一章')
    const seedScenes = Array.from({ length: sceneCount }, (_, sceneIndex) => ({
      location: `地点 ${sceneIndex + 1}`,
      participants: characterIds,
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
    saveStoryboardDraft(host.repos, {
      chapterId,
      updatedBy: 'author',
      scenes: seedScenes
    })
    if (input.seedEveryChapter === true) {
      for (const extraId of extraChapterIds) {
        saveStoryboardDraft(host.repos, { chapterId: extraId, updatedBy: 'author', scenes: seedScenes })
      }
    }
    return this.state(chapterId)
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

  // ── M1-1 场景库：链接/解链/排序/fork/删除（PHASE-12 §5.1） ────────────────

  linkScene(input: { chapterId: string; sceneId: string }): WriteActionResult {
    const host = this.requireSceneEditable()
    linkSceneToChapter(host.db, host.repos, input)
    const scene = host.repos.scene.get(input.sceneId)
    this.log('write_scene_linked', { chapterId: input.chapterId, sceneId: input.sceneId })
    return {
      state: this.state(input.chapterId),
      detail: `已链接「${scene?.location ?? input.sceneId}」到本章；补上拍之后再开演`
    }
  }

  unlinkScene(input: { chapterId: string; sceneId: string }): WriteActionResult {
    const host = this.requireSceneEditable()
    unlinkSceneFromChapter(host.db, host.repos, input)
    this.log('write_scene_unlinked', { chapterId: input.chapterId, sceneId: input.sceneId })
    return { state: this.state(input.chapterId), detail: '已解链；场景本身还在场景库里' }
  }

  reorderScenes(input: { chapterId: string; sceneIds: string[] }): WriteActionResult {
    const host = this.requireSceneEditable()
    reorderChapterScenes(host.db, host.repos, input)
    return { state: this.state(input.chapterId), detail: '章内顺序已更新' }
  }

  forkScene(input: { chapterId: string; sceneId: string }): WriteActionResult {
    const host = this.requireSceneEditable()
    const result = forkSceneIntoChapter(host.db, host.repos, input)
    this.log('write_scene_forked', {
      chapterId: input.chapterId,
      sceneId: input.sceneId,
      newSceneId: result.sceneId,
      beatCount: result.beatCount
    })
    return {
      state: this.state(input.chapterId),
      detail: `已 fork：新场景带着 ${result.beatCount} 拍进入本章，原章不动`
    }
  }

  deleteScene(input: { chapterId: string; sceneId: string }): WriteActionResult {
    const host = this.requireSceneEditable()
    removeScene(host.db, host.repos, input)
    this.log('write_scene_removed', { chapterId: input.chapterId, sceneId: input.sceneId })
    return { state: this.state(input.chapterId), detail: '场景已删除' }
  }

  setSceneTime(input: {
    chapterId: string
    sceneId: string
    storyStart?: string | null
    storyEnd?: string | null
    timeline?: 'main' | 'flashback' | 'dream'
  }): WriteActionResult {
    const host = this.requireSceneEditable()
    const scene = updateSceneTime(host.repos, input)
    const label = scene.timeline === 'main' ? '主线' : scene.timeline === 'flashback' ? '闪回' : '梦境'
    return { state: this.state(input.chapterId), detail: `「${scene.location}」时间轴：${label}` }
  }

  /**
   * 章预算编辑（PHASE-20 M2-3）：`undefined` = 不改，`null` = 恢复默认值。
   * 只写 `chapter.budget_tokens/budget_cny`，不动正文、不建 revision。
   */
  setBudget(input: {
    chapterId: string
    budgetCny?: number | null
    budgetTokens?: number | null
  }): WriteActionResult {
    const host = this.requireWritable()
    const chapter = host.repos.chapter.get(input.chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId: input.chapterId })
    if (input.budgetCny === undefined && input.budgetTokens === undefined) {
      throw new AppError('invalid_args', '没有要修改的预算字段')
    }
    if (this.running || this.autoRunning) {
      throw new AppError('invalid_args', '生成中不能改预算，请先暂停或等本拍结束')
    }
    if (input.budgetCny !== undefined) {
      if (input.budgetCny !== null && (!Number.isFinite(input.budgetCny) || input.budgetCny < 0)) {
        throw new AppError('invalid_args', '费用预算必须是非负数', { budgetCny: input.budgetCny })
      }
      host.repos.chapter.setBudgetCny(chapter.id, input.budgetCny)
    }
    if (input.budgetTokens !== undefined) {
      if (input.budgetTokens !== null && (!Number.isFinite(input.budgetTokens) || input.budgetTokens < 0)) {
        throw new AppError('invalid_args', 'token 预算必须是非负数', { budgetTokens: input.budgetTokens })
      }
      host.repos.chapter.setBudgetTokens(chapter.id, input.budgetTokens)
    }
    this.log('write_budget_set', {
      chapterId: chapter.id,
      budgetCny: input.budgetCny ?? null,
      budgetTokens: input.budgetTokens ?? null
    })
    return { state: this.state(chapter.id), detail: '章预算已更新' }
  }

  /** T23 的只读投影（PHASE-12 M1-2）；与工具共用 `queryTimeline`。 */
  timeline(chapterId: string): WriteTimeline {
    const host = this.requireHost()
    const chapter = host.repos.chapter.get(chapterId)
    if (!chapter) throw new AppError('invalid_args', '本章不存在', { chapterId })
    return queryTimeline(host.repos, {
      projectId: chapter.projectId,
      chapterId: chapter.id,
      asOf: chapter.coveredUntilSeq
    })
  }

  /**
   * 上下文检查器（PHASE-13 M1-17）：只读 `turn_metric.context_json`。
   *
   * 展示的就是这一拍**实际用过**的上下文——不重新装配、不重算 token；
   * 被裁掉的块只给 id/类型/数量，不回传正文（PHASE-13 §5.4）。
   */
  inspectContext(beatId: string): WriteContextInspection {
    const host = this.requireHost()
    const beat = host.repos.beat.get(beatId)
    if (!beat) throw new AppError('invalid_args', `beat ${beatId} not found`)
    const chapter = host.repos.chapter.get(beat.chapterId)
    if (!chapter) throw new AppError('invalid_args', '章不存在', { chapterId: beat.chapterId })
    const budget = chapterBudget(host.repos, chapter)
    const session = this.sessionOf(chapter.id)
    const pauseEvent = host.repos.schedulerEvent.latestPause(chapter.id)
    const pauseReason =
      session.pauseReason ??
      (pauseEvent && pauseEvent.kind === 'paused' ? (pauseEvent.reason as PauseReason | null) : null)
    // 生成时 `turn_metric.beat_id` 记的是**槽位拍**；提交后新拍 supersedes 旧拍。
    // 所以沿 supersedes 链各查一次，取最新的一条（重生成同理）。
    const metric =
      [beat.id, beat.supersedesId]
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map((id) => host.repos.turnMetric.latestByBeat(id))
        .filter((row): row is NonNullable<typeof row> => row !== null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null

    const empty: WriteContextInspection = {
      beatId: beat.id,
      chapterId: chapter.id,
      found: false,
      turnId: null,
      agentKey: null,
      provider: null,
      model: null,
      asOf: null,
      totalTokens: 0,
      blocks: [],
      trimmed: [],
      degraded: [],
      prefixHash: null,
      usage: { tokensIn: null, tokensOut: null, costCny: 0, latencyMs: null, firstTokenMs: null },
      estimate: { totalTokens: 0, actualPromptTokens: null, ratio: null },
      budget,
      pauseReason
    }
    if (!metric) return empty

    const snapshot = parseJson(metric.contextJson)
    if (snapshot === null || typeof snapshot !== 'object') return { ...empty, found: true, turnId: metric.turnId }
    const record = snapshot as {
      blocks?: unknown
      total_tokens?: unknown
      trimmed?: unknown
      degraded?: unknown
      prefix_hash?: unknown
      as_of?: unknown
    }
    const trimmed = Array.isArray(record.trimmed)
      ? record.trimmed.filter((item): item is string => typeof item === 'string')
      : []
    const trimmedSet = new Set(trimmed)
    type BlockLayer = WriteContextInspection['blocks'][number]['layer']
    const blocks: WriteContextInspection['blocks'] = Array.isArray(record.blocks)
      ? record.blocks.flatMap((item): WriteContextInspection['blocks'] => {
          if (item === null || typeof item !== 'object') return []
          const raw = item as Record<string, unknown>
          const layer = raw.layer
          if (layer !== 'L0' && layer !== 'L1' && layer !== 'L2' && layer !== 'L3') return []
          const typedLayer: BlockLayer = layer
          const id = typeof raw.id === 'string' ? raw.id : ''
          if (id.length === 0) return []
          return [
            {
              id,
              layer: typedLayer,
              stable: raw.stable === true,
              priority: typeof raw.priority === 'number' ? raw.priority : 0,
              tokens: typeof raw.tokens === 'number' ? raw.tokens : 0,
              role: typeof raw.role === 'string' ? raw.role : 'unknown',
              order: typeof raw.order === 'number' ? raw.order : null,
              refType: typeof raw.ref_type === 'string' ? raw.ref_type : null,
              trimmed: trimmedSet.has(id)
            }
          ]
        })
      : []
    const totalTokens =
      typeof record.total_tokens === 'number'
        ? record.total_tokens
        : blocks.reduce((sum, block) => sum + block.tokens, 0)
    const actual = typeof metric.tokensIn === 'number' ? metric.tokensIn : null
    const ratio = actual !== null && totalTokens > 0 ? actual / totalTokens : null

    return {
      beatId: beat.id,
      chapterId: chapter.id,
      found: true,
      turnId: metric.turnId,
      agentKey: metric.agentKey,
      provider: metric.provider,
      model: metric.model,
      asOf: typeof record.as_of === 'number' ? record.as_of : null,
      totalTokens,
      blocks,
      trimmed,
      degraded: Array.isArray(record.degraded)
        ? record.degraded.filter((item): item is string => typeof item === 'string')
        : [],
      prefixHash: typeof record.prefix_hash === 'string' ? record.prefix_hash : null,
      usage: {
        tokensIn: metric.tokensIn,
        tokensOut: metric.tokensOut,
        costCny: metric.costCny ?? 0,
        latencyMs: metric.latencyMs,
        firstTokenMs: metric.firstTokenMs
      },
      estimate: { totalTokens, actualPromptTokens: actual, ratio },
      budget,
      pauseReason
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
    if (chapter.status === 'finalized') {
      throw new AppError('already_finalized', '本章已定稿，不能再生成正文', { chapterId: chapter.id })
    }
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
      for (const beat of later) host.repos.beat.setStatus(beat.id, beatTransition('stale', 'IGNORE'))
      return { state: this.state(chapter.id), detail: `已接受替换：${later.length} 拍保持原文` }
    }
    for (const beat of later) host.repos.beat.setStatus(beat.id, beatTransition('stale', 'REQUEUE'))
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
          // PHASE-19 §5.3：场景第一次 closed 时就地算声音指标（best-effort）。
          syncSceneVoice(host.repos, sceneId, {
            persist: !host.readOnly,
            log: (message, details) => this.log(message, details ?? {})
          })
          return closed.chapterComplete
        }
      )
      // 每个非 complete 的停止都由 runAutoLoop 的 onPause 记过（取消由 cancel() 记）；
      // 这里不再补写一次，避免同一暂停出现两条事件/消息/预算账本。
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

  isBusy(): boolean {
    return this.running || this.autoRunning
  }

  /**
   * 项目切换/关闭前调用（PHASE-11 §5.1）：中止在跑的任务并等它退出。
   *
   * 必须先等：`project.open` 会关闭 SQLite 连接，异步任务的 finally 还在写库。
   * 超时不强行关闭——返回 false 让调用方决定是拒绝切换还是继续（并记日志）。
   */
  async abortAllAndWait(timeoutMs = 2_000): Promise<boolean> {
    if (!this.isBusy()) return true
    for (const session of this.sessions.values()) {
      session.cancelRequested = true
      session.pauseRequested = true
    }
    this.abort?.abort()
    const started = Date.now()
    while (this.isBusy() && Date.now() - started < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return !this.isBusy()
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
        ...(this.deps.embedder === undefined ? {} : { embedder: this.deps.embedder }),
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
        ...(this.deps.embedder === undefined ? {} : { embedder: this.deps.embedder }),
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
    // 预算暂停：事件 / 消息 / job 三处用同一份数字（PHASE-20 §5.1）。
    const budget =
      reason === 'budget_exceeded'
        ? ((detail.budget as BudgetState | undefined) ?? chapterBudget(host.repos, chapter))
        : null
    const payload = budget === null ? detail : { ...detail, budget }
    host.repos.schedulerEvent.insert({
      projectId: chapter.projectId,
      chapterId,
      jobId: null,
      kind: 'paused',
      reason,
      payloadJson: JSON.stringify(payload)
    })
    host.repos.writeMessage.insert({
      projectId: chapter.projectId,
      chapterId,
      role: 'system',
      kind: reason === 'character_refusal' ? 'refusal' : 'pause',
      body: PAUSE_REASON_TEXT[reason] ?? String(reason),
      metaJson: JSON.stringify(payload)
    })
    if (budget !== null) this.recordBudgetPauseJob(host, chapter, budget)
    this.log('write_paused', { chapterId, reason, ...payload })
  }

  /**
   * 预算暂停的任务记录（PHASE-20 §5.1）。
   *
   * 自动模式没有独立的 job 类型（0013 不改 job 表）：这里写一条 `paused` 的
   * `beat.generate` 账本行，`result_json.budget` 带两套 limit/used/reason，
   * 供 E2E / 验收报告引用。它不参与发牌，也不会被启动恢复当成运行中的任务。
   */
  private recordBudgetPauseJob(host: WriteHost, chapter: ChapterRecord, budget: BudgetState): void {
    const project = host.repos.project.get()
    if (!project) return
    this.attemptSeq += 1
    const job = host.repos.job.insert({
      projectId: project.id,
      type: 'beat.generate',
      status: 'paused',
      expectedRevision: chapter.currentRevisionId,
      epoch: project.writeEpoch,
      idempotencyKey: `auto_budget:${chapter.id}:${Date.now()}:${this.attemptSeq}`,
      payloadJson: JSON.stringify({
        kind: 'auto_budget_pause',
        chapterId: chapter.id,
        reason: 'budget_exceeded'
      })
    })
    host.repos.job.setStatus(job.id, 'paused', {
      resultJson: JSON.stringify({
        kind: 'auto_budget_pause',
        chapter_id: chapter.id,
        budget: {
          tokens_limit: budget.tokensLimit,
          tokens_used: budget.tokensUsed,
          cost_limit: budget.costLimit,
          cost_used: budget.costUsed,
          priced_calls: budget.pricedCalls,
          unpriced_calls: budget.unpricedCalls,
          reason: budget.reason
        }
      })
    })
    this.log('write_budget_paused', {
      chapterId: chapter.id,
      jobId: job.id,
      reason: budget.reason,
      tokensUsed: budget.tokensUsed,
      costUsed: budget.costUsed
    })
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

  /** 场景库写入：只读、生成中都拒绝（生成中改场景会让当前拍找不到自己的场景）。 */
  private requireSceneEditable(): WriteHost {
    const host = this.requireWritable()
    if (this.running || this.autoRunning) throw new AppError('invalid_args', '生成中不能改场景，请先暂停或等本拍结束')
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

