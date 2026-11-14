import { AppError, isAppError } from '../../shared/domain/app-error'
import type { ChatAdapter } from '../model/adapter'
import type { CapabilitiesLookup, ResolvedBinding } from '../model/bindings'
import { bindingFor } from '../model/bindings'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import type { BeatRecord } from '../db/repos/beat'
import type { ChapterRecord } from '../db/repos/chapter'
import { recomputeCoveredUntilSeq } from '../db/seq'
import { createTurnJob } from '../agents/job'
import { runTurn, turnIdFor, type TurnCommitInput, type TurnCommitResult, type TurnHooks } from '../agents/turn'
import type { RegistrySnapshot } from '../tools/registry'
import { commitBeat } from '../doc/commit-beat'
import { markGenerating, rejectBeat, rollbackGenerate, type GenerateMark } from '../doc/beats'
import { writeTurnTrace } from '../doc/trace'
import { beatTransition } from './transitions'

/**
 * 一拍的发牌与落盘（PHASE-07 F4 / DEV-PLAN §8.2）。
 *
 * 状态迁移只走 `transitions.ts` 的表；正文只走 `commitBeat`。
 * 重生成的补偿：
 *   waiting_for_human → regenerating（旧拍仍是唯一活行）
 *   成功 → 同一事务里旧拍 superseded + 插入新拍 draft
 *   失败 → 旧拍回 waiting_for_human，不产生新行
 */

export interface BeatHost {
  dir: string
  db: Db
  repos: Repos
}

export interface BeatRunDeps {
  host: BeatHost
  registry: RegistrySnapshot
  /** 按 job 冻结的绑定构造适配器；runTurn 不信外部 provider/model。 */
  adapterFor: (binding: ResolvedBinding) => ChatAdapter
  gateSecret: string
  mode: 'interactive' | 'auto' | 'batch'
  /** 设置里的探测结果；缺省用预设表（与 job 创建时一致）。 */
  capabilitiesLookup?: CapabilitiesLookup
  hooks?: TurnHooks
  signal?: AbortSignal
  /** 重试序号：强杀后的重试必须换 attempt，否则命中旧 job。 */
  attempt: string
  now?: () => number
  /** 本轮是否已由 T41 拒演；落盘前检查，拒演不写正文。 */
  refusalProbe?: () => { code: string; reason: string } | null
  /** job 创建后回调：流式事件需要 jobId/turnId。 */
  onJob?: (info: { jobId: string; turnId: string }) => void
}

export interface BeatRunOutcome {
  status: 'committed' | 'rejected' | 'refused'
  jobId: string
  turnId: string
  beatId: string | null
  revisionId: string | null
  contentHash: string | null
  code: string | null
  attempts: number
  latencyMs: number
  toolCalls: number
  /** 自动模式已直接确认。 */
  autoConfirmed: boolean
  /** 拒演理由（PRD §5.2：保留理由，不提供强制继续）。 */
  refusalReason?: string | null
}

function transition(repos: Repos, beatId: string, from: BeatRecord['status'], event: Parameters<typeof beatTransition>[1]) {
  const next = beatTransition(from, event)
  repos.beat.setStatus(beatId, next, next === 'confirmed' ? 'auto' : null)
  return next
}

export async function runBeatTurn(deps: BeatRunDeps, input: { beat: BeatRecord; chapter: ChapterRecord }): Promise<BeatRunOutcome> {
  const { host, registry } = deps
  const beat = input.beat
  const mark: GenerateMark = markGenerating(host.repos, beat.id)
  const project = host.repos.project.get()
  if (!project) throw new AppError('project_not_found', 'no project in database')

  const actor = beat.speakerType === 'character' ? (`character:${beat.speakerId}` as const) : 'narrator'
  let jobId = ''
  let turnId = ''
  try {
    const { job, payload } = createTurnJob(
      host.repos,
      registry,
      {
        chapterId: input.chapter.id,
        beatId: beat.id,
        actor,
        mode: deps.mode,
        at: new Date().toISOString(),
        supersedesId: beat.id,
        attempt: deps.attempt
      },
      { ...(deps.capabilitiesLookup === undefined ? {} : { capabilitiesLookup: deps.capabilitiesLookup }) }
    )
    jobId = job.id
    turnId = turnIdFor(job.id, beat.id)
    deps.onJob?.({ jobId: job.id, turnId })
    const binding = bindingFor(payload.bindings, actor)
    const adapter = deps.adapterFor(binding)

    const result = await runTurn(
      {
        repos: host.repos,
        registry,
        adapter,
        gateSecret: deps.gateSecret,
        ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        ...(deps.now === undefined ? {} : { now: deps.now }),
        commit: (commitInput) => {
          const refusal = deps.refusalProbe?.() ?? null
          if (refusal) {
            throw new AppError('character_refusal', refusal.reason, { code: refusal.code, beatId: beat.id })
          }
          return commitForBeat(host, beat, commitInput)
        }
      },
      { job }
    )

    if (result.status === 'rejected' || !result.commit) {
      rejectBeat(host.repos, beat.id, mark)
      return {
        status: 'rejected',
        jobId,
        turnId,
        beatId: null,
        revisionId: null,
        contentHash: null,
        code: result.rejection?.code ?? 'invalid_grounding',
        attempts: result.attempts,
        latencyMs: result.latencyMs,
        toolCalls: result.toolCalls,
        autoConfirmed: false
      }
    }

    // 落盘后：draft → waiting_for_human（逐拍）或 confirmed（自动模式跳过 G3）。
    const committed = host.repos.beat.get(result.commit.beatId)
    if (!committed) throw new AppError('internal_error', 'commit 后读不回拍')
    let autoConfirmed = false
    if (deps.mode === 'auto') {
      transition(host.repos, committed.id, 'draft', 'AUTO_ACCEPT')
      recomputeCoveredUntilSeq(host.db, input.chapter.id)
      autoConfirmed = true
    } else {
      transition(host.repos, committed.id, 'draft', 'WAIT')
    }

    return {
      status: 'committed',
      jobId,
      turnId,
      beatId: result.commit.beatId,
      revisionId: result.commit.revisionId,
      contentHash: result.commit.contentHash,
      code: null,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      toolCalls: result.toolCalls,
      autoConfirmed
    }
  } catch (error) {
    if (mark) rollbackGenerate(host.repos, mark)
    if (isAppError(error) && error.code === 'character_refusal') {
      const probe = deps.refusalProbe?.() ?? null
      return {
        status: 'refused',
        jobId,
        turnId,
        beatId: null,
        revisionId: null,
        contentHash: null,
        code: 'character_refusal',
        attempts: 1,
        latencyMs: 0,
        toolCalls: 0,
        autoConfirmed: false,
        refusalReason: probe?.reason ?? error.message
      }
    }
    throw error
  }
}

/** 生产路径同款：trace 先归档，再由 commitBeat 写正文。 */
function commitForBeat(host: BeatHost, beat: BeatRecord, input: TurnCommitInput): TurnCommitResult {
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
    supersedesId: input.supersedesId ?? beat.id,
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
