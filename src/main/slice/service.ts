import { AppError } from '../../shared/domain/app-error'
import type { SliceBeatEvent, SliceGenerateResult, SliceSeedResult, SliceState } from '../../shared/schema/slice'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord } from '../db/repos/beat'
import { sha256Hex } from '../crypto'
import { createTurnJob } from '../agents/job'
import { runTurn, turnIdFor, type TurnCommitInput, type TurnCommitResult, type TurnHooks } from '../agents/turn'
import type { RegistrySnapshot } from '../tools/registry'
import { commitBeat } from '../doc/commit-beat'
import { confirmBeat, editBeat, markGenerating, parseGrounding, rejectBeat, rollbackGenerate } from '../doc/beats'
import { publishPendingMirrors } from '../doc/publish'
import { writeTurnTrace } from '../doc/trace'
import type { SliceFixture } from './fixture'
import { loadSliceFixture } from './fixture'
import { FakeSliceModelAdapter } from './fake-adapter'
import { seedSlice } from './seed'

/**
 * 开发切片编排（PHASE-05 V2）。
 *
 * 只做三件事：把 fixture 放进当前项目、用假模型跑一拍并落盘、提供状态给最小 UI。
 * 不实现调度器、分镜编辑、自动模式与审批——那些是 06–09 的范围。
 *
 * 铁律检查：
 * - 正文只经 `doc/commit-beat.ts` 写入；
 * - `expected_revision` / `epoch` 来自 job 快照，迟到结果被拒绝；
 * - 同一项目同一时刻只允许一个生成任务（内存单飞；跨进程由项目锁兜底）。
 */

export interface SliceHost {
  dir: string
  db: Db
  repos: Repos
  readOnly: boolean
}

export interface SliceServiceDeps {
  host: () => SliceHost | null
  registry: RegistrySnapshot
  /** `tests/fixtures/slice/project.json` 的绝对路径；仅未打包构建可达。 */
  fixturePath: string
  send: (event: SliceBeatEvent) => void
  log?: (message: string, details?: Record<string, unknown>) => void
  chunkDelayMs?: number
}

export interface SliceService {
  seed(): SliceSeedResult
  state(): SliceState
  generate(beatId: string): Promise<SliceGenerateResult>
  regenerate(beatId: string): Promise<SliceGenerateResult>
  confirm(beatId: string): SliceState
  edit(input: { beatId: string; body: string; expectedRevision: string | null }): SliceState
}

export class DevSliceService implements SliceService {
  private readonly gateSecret = sha256Hex(`slice-gate-${Date.now()}-${Math.random()}`)
  private fixture: SliceFixture | null = null
  private adapter: FakeSliceModelAdapter | null = null
  private running = false
  private eventSeq = 0
  private attemptSeq = 0

  constructor(private readonly deps: SliceServiceDeps) {}

  seed(): SliceSeedResult {
    const host = this.requireWritable()
    const result = seedSlice(host.db, host.repos, this.fixtureData())
    this.publish(host)
    this.log('slice_seeded', { seeded: result.seeded, chapterId: result.chapterId })
    return result
  }

  state(): SliceState {
    const host = this.requireHost()
    return this.buildState(host)
  }

  async generate(beatId: string): Promise<SliceGenerateResult> {
    return this.runGeneration(beatId, false)
  }

  async regenerate(beatId: string): Promise<SliceGenerateResult> {
    return this.runGeneration(beatId, true)
  }

  confirm(beatId: string): SliceState {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '生成中不能确认，请等本拍结束')
    confirmBeat(host.db, host.repos, beatId, 'author')
    return this.buildState(host)
  }

  edit(input: { beatId: string; body: string; expectedRevision: string | null }): SliceState {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '生成中不能编辑，请等本拍结束')
    editBeat(host.db, host.repos, input)
    this.publish(host)
    return this.buildState(host)
  }

  private async runGeneration(beatId: string, requireBody: boolean): Promise<SliceGenerateResult> {
    const host = this.requireWritable()
    if (this.running) throw new AppError('invalid_args', '已有生成任务在跑', { beatId })

    const beat = host.repos.beat.get(beatId)
    if (!beat) throw new AppError('invalid_args', `beat ${beatId} not found`)
    if (requireBody && beat.body.trim().length === 0) {
      throw new AppError('invalid_args', '本拍还没有正文，不能重生成', { beatId })
    }

    this.running = true
    let mark: ReturnType<typeof markGenerating> | null = null
    try {
      mark = markGenerating(host.repos, beatId)
      const project = host.repos.project.get()
      if (!project) throw new AppError('project_not_found', 'no project in database')

      const actor = beat.speakerType === 'character' ? (`character:${beat.speakerId}` as const) : 'narrator'
      const { job } = createTurnJob(
        host.repos,
        this.deps.registry,
        {
          chapterId: beat.chapterId,
          beatId: beat.id,
          actor,
          mode: 'interactive',
          at: new Date().toISOString(),
          supersedesId: beat.id,
          attempt: `${Date.now()}-${(this.attemptSeq += 1)}`
        },
        { capabilitiesLookup: () => this.model().capabilities() }
      )

      const turnId = turnIdFor(job.id, beat.id)
      this.emit({
        projectId: project.id,
        jobId: job.id,
        turnId,
        beatId: beat.id,
        seq: this.nextEventSeq(),
        phase: 'start'
      })

      const result = await runTurn(
        {
          repos: host.repos,
          registry: this.deps.registry,
          adapter: this.model(),
          gateSecret: this.gateSecret,
          hooks: this.hooksFor(project.id, job.id, turnId, beat.id),
          commit: (input) => this.commit(host, beat, input)
        },
        { job }
      )

      if (result.status === 'rejected' || !result.commit) {
        rejectBeat(host.repos, beat.id, mark)
        this.emit({
          projectId: project.id,
          jobId: job.id,
          turnId,
          beatId: beat.id,
          seq: this.nextEventSeq(),
          phase: 'failed',
          code: result.rejection?.code ?? 'invalid_grounding'
        })
        return {
          jobId: job.id,
          status: 'rejected',
          beatId: null,
          revisionId: null,
          contentHash: null,
          rejection: result.rejection ?? { code: 'invalid_grounding', message: '本拍未通过校验' },
          state: this.buildState(host)
        }
      }

      host.repos.beat.setStatus(result.commit.beatId, 'waiting_for_human')
      this.publish(host)
      this.emit({
        projectId: project.id,
        jobId: job.id,
        turnId,
        beatId: result.commit.beatId,
        seq: this.nextEventSeq(),
        phase: 'committed',
        full: result.envelope?.body ?? ''
      })
      return {
        jobId: job.id,
        status: 'committed',
        beatId: result.commit.beatId,
        revisionId: result.commit.revisionId,
        contentHash: result.commit.contentHash,
        rejection: null,
        state: this.buildState(host)
      }
    } catch (error) {
      if (mark) rollbackGenerate(host.repos, mark)
      const code = error instanceof AppError ? error.code : 'model_error'
      this.emit({
        projectId: this.projectIdOf(host),
        jobId: '',
        turnId: '',
        beatId,
        seq: this.nextEventSeq(),
        phase: 'failed',
        code
      })
      throw error
    } finally {
      this.running = false
    }
  }

  private commit(host: SliceHost, beat: BeatRecord, input: TurnCommitInput): TurnCommitResult {
    const traceRef = writeTurnTrace({
      projectDir: host.dir,
      jobId: input.jobId,
      turnId: input.turnId,
      beatId: input.beatId,
      envelope: input.envelope,
      context: input.context.bundle,
      binding: input.binding
    })
    const committed = commitBeat(host.db, host.repos, {
      chapterId: input.chapterId,
      expectedRevision: input.expectedRevision,
      epoch: input.epoch,
      sceneId: beat.sceneId,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      body: input.envelope.body,
      intent: beat.intent,
      grounding: input.envelope.grounding,
      traceRef,
      supersedesId: input.supersedesId,
      status: 'draft',
      maxWords: beat.maxWords,
      createdBy: 'doc_controller'
    })
    return {
      beatId: committed.beatId,
      revisionId: committed.revisionId,
      seq: committed.seq,
      contentHash: committed.contentHash,
      mirrorHash: committed.mirrorHash,
      traceRef
    }
  }

  private hooksFor(projectId: string, jobId: string, turnId: string, beatId: string): TurnHooks {
    return {
      onText: (delta, full) => {
        this.emit({
          projectId,
          jobId,
          turnId,
          beatId,
          seq: this.nextEventSeq(),
          phase: 'delta',
          delta,
          full
        })
      },
      onPhase: (phase) => {
        if (phase === 'validated') {
          this.emit({
            projectId,
            jobId,
            turnId,
            beatId,
            seq: this.nextEventSeq(),
            phase: 'validated'
          })
        }
      }
    }
  }

  private buildState(host: SliceHost): SliceState {
    const fixture = this.fixtureData()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'no project in database')
    const chapter = host.repos.chapter.get(fixture.chapter.id)
    const revision = chapter?.currentRevisionId ? host.repos.revision.get(chapter.currentRevisionId) : null
    const beats = chapter ? host.repos.beat.listLiveByChapter(chapter.id).map((beat) => this.beatState(host, beat)) : []
    const jobs = host.repos.job.listRecent(project.id, 10).filter((job) => job.type === 'beat.generate')
    const lastJob = jobs[0]

    return {
      devOnly: true,
      projectId: project.id,
      chapterId: fixture.chapter.id,
      chapterOrd: fixture.chapter.ord,
      chapterTitle: fixture.chapter.title,
      revisionId: chapter?.currentRevisionId ?? null,
      contentHash: revision?.contentHash ?? null,
      beats,
      lastJob: lastJob
        ? { id: lastJob.id, status: lastJob.status, errorCode: lastJob.errorCode }
        : null
    }
  }

  private beatState(host: SliceHost, beat: BeatRecord): SliceState['beats'][number] {
    const speakerName =
      beat.speakerType === 'narrator'
        ? '旁白'
        : (host.repos.character.get(beat.speakerId)?.name ?? beat.speakerId)
    return {
      id: beat.id,
      ord: beat.ord,
      speakerType: beat.speakerType,
      speakerId: beat.speakerId,
      speakerName,
      intent: beat.intent,
      body: beat.body,
      status: beat.status,
      grounding: parseGrounding(beat.groundingJson),
      traceRef: beat.traceRef,
      revisionId: beat.createdRevisionId,
      wordCount: beat.wordCount,
      maxWords: beat.maxWords,
      updatedAt: beat.updatedAt
    }
  }

  private publish(host: SliceHost): void {
    try {
      const report = publishPendingMirrors(host.db, host.dir)
      if (report.failed.length > 0 || report.conflicts.length > 0) {
        this.log('slice_mirror_pending', {
          failed: report.failed.length,
          conflicts: report.conflicts.length,
          exhausted: report.exhausted.length
        })
      }
    } catch (error) {
      this.log('slice_mirror_failed', { message: error instanceof Error ? error.message : String(error) })
    }
  }

  private nextEventSeq(): number {
    this.eventSeq += 1
    return this.eventSeq
  }

  private emit(event: SliceBeatEvent): void {
    this.deps.send(event)
  }

  private projectIdOf(host: SliceHost): string {
    return host.repos.project.get()?.id ?? ''
  }

  private fixtureData(): SliceFixture {
    if (!this.fixture) this.fixture = loadSliceFixture(this.deps.fixturePath)
    return this.fixture
  }

  private model(): FakeSliceModelAdapter {
    if (!this.adapter) {
      this.adapter = new FakeSliceModelAdapter({
        fixture: this.fixtureData(),
        chunkDelayMs: this.deps.chunkDelayMs ?? 8
      })
    }
    return this.adapter
  }

  private log(message: string, details: Record<string, unknown> = {}): void {
    this.deps.log?.(message, details)
  }

  private requireHost(): SliceHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '请先打开一个项目')
    return host
  }

  private requireWritable(): SliceHost {
    const host = this.requireHost()
    if (host.readOnly) throw new AppError('project_locked', '项目当前只读')
    return host
  }
}
