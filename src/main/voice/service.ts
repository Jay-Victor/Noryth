import { AppError } from '../../shared/domain/app-error'
import { VOICE_THRESHOLD, isBelowVoiceThreshold } from '../../shared/domain/voice'
import { parseCharacterCard } from '../../shared/schema/plan'
import type { VoiceSceneInput, VoiceSceneState } from '../../shared/schema/voice'
import { SceneVoiceMetricsSchema, type SceneVoiceMetrics } from '../../shared/schema/voice'
import type { Repos } from '../db/repos'
import type { VoiceMetricRecord } from '../db/repos/voice'
import type { Db } from '../db/project-db'
import { computeVoiceMetrics, type VoiceCharacterInput } from './metrics'

/**
 * 声音指标服务（PHASE-19 §5.3 / §5.4）。
 *
 * 唯一写入点是这里：场景关账、审批 job 开始、`voice.scene` 读到缺行/旧行时
 * 计算并 upsert 到 `voice_metric`。纯函数在 `metrics.ts`，这里只做取数（revision
 * 清单 + 角色卡）与持久化。不写正文、不建 revision、不进 L0–L3。
 */

export interface VoiceHost {
  db: Db
  repos: Repos
  readOnly: boolean
}

export interface VoiceServiceDeps {
  host: () => VoiceHost | null
  log?: (message: string, details?: Record<string, unknown>) => void
}

/** 当前稿：定稿章读 final，其余读 current（PHASE-19 §5.1）。 */
export function currentRevisionIdOf(repos: Repos, chapterId: string): string | null {
  const chapter = repos.chapter.get(chapterId)
  if (!chapter) return null
  if (chapter.status === 'finalized' && chapter.finalRevisionId !== null) return chapter.finalRevisionId
  return chapter.currentRevisionId
}

function emptyMetrics(): SceneVoiceMetrics {
  return {
    characters: [],
    pairs: [],
    aggregate: {
      sentenceLengthJsd: 0,
      catchphraseRate: 0,
      questionRate: 0,
      firstPersonRate: 0,
      pairwiseDistinctness: 0
    },
    insufficientData: true,
    threshold: { version: VOICE_THRESHOLD.version, distinctnessMin: VOICE_THRESHOLD.distinctnessMin }
  }
}

/**
 * 从 revision 清单取这一场的角色拍（只统计 `speaker_type='character'`）。
 * 排序固定 `(sceneOrd, beatOrd)`；旁白不进两两区分度。
 */
function characterInputs(
  repos: Repos,
  sceneId: string,
  revisionId: string
): VoiceCharacterInput[] {
  const members = repos.revision
    .manifest(revisionId)
    .filter(
      (member) =>
        member.sceneId === sceneId &&
        member.speakerType === 'character' &&
        // 只统计有正文的拍：未生成 / 空正文不参与句长与口头禅率。
        member.body.trim().length > 0
    )
    .sort((left, right) => {
      if (left.sceneOrd !== right.sceneOrd) return left.sceneOrd - right.sceneOrd
      return left.beatOrd - right.beatOrd
    })

  const byCharacter = new Map<string, VoiceCharacterInput>()
  // 角色卡按 id 缓存（PHASE-23 M2-6）：24 拍逐拍 `character.get()` 是 N+1，
  // 同一场最多 3 个发言角色，一次取齐即可。
  const characterCache = new Map<string, ReturnType<Repos['character']['get']>>()
  const characterOf = (characterId: string): ReturnType<Repos['character']['get']> => {
    if (!characterCache.has(characterId)) characterCache.set(characterId, repos.character.get(characterId))
    return characterCache.get(characterId) ?? null
  }
  for (const member of members) {
    const character = characterOf(member.speakerId)
    const card = character ? parseCharacterCard(character.cardJson) : null
    const existing = byCharacter.get(member.speakerId)
    if (existing) {
      existing.beats.push({ ord: member.beatOrd, body: member.body })
      continue
    }
    byCharacter.set(member.speakerId, {
      characterId: member.speakerId,
      name: character?.name ?? member.speakerId,
      catchphrase: card?.voice.catchphrase ?? '',
      beats: [{ ord: member.beatOrd, body: member.body }]
    })
  }
  return [...byCharacter.values()]
}

export interface ComputedSceneVoice {
  sceneId: string
  chapterId: string | null
  revisionId: string | null
  metrics: SceneVoiceMetrics
}

/**
 * 计算一场的指标（不落库）。没有演出章 / 没有 revision 时返回空指标。
 * `scene_id` 不存在 → `invalid_args`（调用方拿到的不是「空不是错」）。
 */
export function computeSceneVoice(
  repos: Repos,
  sceneId: string,
  revisionId?: string
): ComputedSceneVoice {
  const scene = repos.scene.get(sceneId)
  if (!scene) throw new AppError('invalid_args', '场景不存在', { sceneId })

  const owner = repos.scene.ownerChapter(sceneId)
  if (!owner) {
    return { sceneId, chapterId: null, revisionId: null, metrics: emptyMetrics() }
  }
  const chapter = repos.chapter.get(owner.chapterId)
  if (!chapter) return { sceneId, chapterId: null, revisionId: null, metrics: emptyMetrics() }

  const resolvedRevisionId = revisionId ?? currentRevisionIdOf(repos, chapter.id)
  if (resolvedRevisionId === null) {
    return { sceneId, chapterId: chapter.id, revisionId: null, metrics: emptyMetrics() }
  }
  const revision = repos.revision.get(resolvedRevisionId)
  if (!revision || revision.chapterId !== chapter.id) {
    throw new AppError('invalid_args', 'revision 不属于本场所在的章', {
      sceneId,
      chapterId: chapter.id,
      revisionId: resolvedRevisionId
    })
  }

  const inputs = characterInputs(repos, sceneId, resolvedRevisionId)
  const metrics = SceneVoiceMetricsSchema.parse({
    ...computeVoiceMetrics({ characters: inputs }),
    threshold: {
      version: VOICE_THRESHOLD.version,
      distinctnessMin: VOICE_THRESHOLD.distinctnessMin
    }
  })
  return { sceneId, chapterId: chapter.id, revisionId: resolvedRevisionId, metrics }
}

function recordToMetrics(record: VoiceMetricRecord | null): SceneVoiceMetrics | null {
  if (!record) return null
  try {
    const parsed = SceneVoiceMetricsSchema.safeParse(JSON.parse(record.metricsJson) as unknown)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function stateOf(input: {
  computed: ComputedSceneVoice
  found: boolean
  stale: boolean
  computedAt: string | null
}): VoiceSceneState {
  const { metrics } = input.computed
  return {
    sceneId: input.computed.sceneId,
    chapterId: input.computed.chapterId,
    revisionId: input.computed.revisionId,
    found: input.found,
    stale: input.stale,
    threshold: metrics.threshold,
    insufficientData: metrics.insufficientData,
    aggregate: metrics.aggregate,
    characters: metrics.characters,
    pairs: metrics.pairs,
    belowThreshold:
      metrics.pairs.length > 0 && isBelowVoiceThreshold(metrics.aggregate.pairwiseDistinctness, metrics.threshold),
    computedAt: input.computedAt
  }
}

/**
 * 读取 + 按需重算（IPC 与创作台徽标共用）。
 *
 * 命中条件：同一 (scene, revision) 有行且 `threshold_version` 与当前一致。
 * 否则重算并覆盖；`stale=true` 表示「读到过旧行」。空场景不伪造 0 分：
 * `found=false` / `insufficientData=true`，由 UI 显示「数据不足」。
 */
export function resolveSceneVoice(
  repos: Repos,
  input: VoiceSceneInput,
  options: { persist: boolean }
): VoiceSceneState {
  const scene = repos.scene.get(input.sceneId)
  if (!scene) throw new AppError('invalid_args', '场景不存在', { sceneId: input.sceneId })

  const owner = repos.scene.ownerChapter(input.sceneId)
  const chapterId = owner?.chapterId ?? null
  const revisionId =
    input.revisionId ?? (chapterId === null ? null : currentRevisionIdOf(repos, chapterId))

  if (chapterId === null || revisionId === null) {
    return stateOf({
      computed: { sceneId: input.sceneId, chapterId, revisionId, metrics: emptyMetrics() },
      found: false,
      stale: false,
      computedAt: null
    })
  }

  const cached = repos.voice.getBySceneRevision(input.sceneId, revisionId)
  const cachedMetrics = recordToMetrics(cached)
  if (cached !== null && cachedMetrics !== null && cached.thresholdVersion === VOICE_THRESHOLD.version) {
    return stateOf({
      computed: { sceneId: input.sceneId, chapterId, revisionId, metrics: cachedMetrics },
      found: true,
      stale: false,
      computedAt: cached.createdAt
    })
  }

  const previous = cached ?? repos.voice.latestByScene(input.sceneId)
  const computed = computeSceneVoice(repos, input.sceneId, revisionId)
  let computedAt: string | null = null
  if (options.persist) {
    const record = repos.voice.upsert({
      projectId: scene.projectId,
      chapterId,
      sceneId: input.sceneId,
      revisionId,
      metricsJson: JSON.stringify(computed.metrics),
      thresholdVersion: VOICE_THRESHOLD.version
    })
    computedAt = record.createdAt
  }
  return stateOf({
    computed,
    found: true,
    stale: previous !== null,
    computedAt
  })
}

/** 场景关账 / 审批开始时批量重算；失败只记日志，不影响关账与审批。 */
export function syncSceneVoice(
  repos: Repos,
  sceneId: string,
  options: { persist: boolean; log?: (message: string, details?: Record<string, unknown>) => void }
): void {
  try {
    if (!repos.scene.get(sceneId)) return
    resolveSceneVoice(repos, { sceneId }, { persist: options.persist })
  } catch (error) {
    options.log?.('voice_metric_failed', {
      sceneId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

export function syncChapterVoice(
  repos: Repos,
  chapterId: string,
  options: { persist: boolean; log?: (message: string, details?: Record<string, unknown>) => void }
): void {
  for (const entry of repos.scene.listByChapter(chapterId)) {
    syncSceneVoice(repos, entry.scene.id, options)
  }
}

/** IPC 门面（PHASE-19 §5.4）：只读；只读项目不落库，但仍返回计算结果。 */
export class VoiceService {
  constructor(private readonly deps: VoiceServiceDeps) {}

  private requireHost(): VoiceHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '没有打开的项目')
    return host
  }

  scene(input: VoiceSceneInput): VoiceSceneState {
    const host = this.requireHost()
    return resolveSceneVoice(host.repos, input, { persist: !host.readOnly })
  }

  /** 审批 job 开始时预热本章全部场景（best-effort）。 */
  syncChapter(chapterId: string): void {
    const host = this.requireHost()
    syncChapterVoice(host.repos, chapterId, {
      persist: !host.readOnly,
      ...(this.deps.log === undefined ? {} : { log: this.deps.log })
    })
  }
}
