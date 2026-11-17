import type { Settings } from '../../shared/schema/project'
import type { Repos } from '../db/repos'
import type { ChapterRecord } from '../db/repos/chapter'
import type { ProjectRecord } from '../db/repos/project'
import { resolveBinding, type CapabilitiesLookup, type ResolvedBinding } from '../model/bindings'
import { defaultModelFor, PROVIDER_PRESETS } from '../model/presets'

/**
 * 异构复检（PHASE-16 §5.3 / M1-22）。
 *
 * `review.hetero = 'prefer'` 时，审批 job 开始时判断：
 *   1. 本章正文实际由哪一家生成（`turn_metric` 最近一条带 beat 的调用；
 *      没生成过就用旁白绑定）；
 *   2. 若审批与生成是同一家，且存在「已验证」的第二家（有 Key / 已测试连接），
 *      自动改用第二家；
 *   3. 找不到第二家 → 报告标 `degraded = 'hetero_unavailable'`，不阻断；
 *   4. 解析只在 job 开始时做一次，job 内不换模型（DEV-PLAN §7.7）。
 *
 * 默认 `off`：M1 只证明「手动可异构且留痕」，M2-8 再评估默认开启与评分校准。
 */

export type HeteroDegraded = 'hetero_unavailable' | null

export interface HeteroResolution {
  /** 本次审批实际使用的绑定。 */
  provider: string
  model: string
  /** 是否从配置的 reviewer 绑定切到了第二家。 */
  switched: boolean
  /** 本章正文的生成 provider（留痕与 UI 解释用）。 */
  generationProvider: string | null
  degraded: HeteroDegraded
  reviewerBinding: ResolvedBinding
}

export interface ResolveHeteroInput {
  repos: Repos
  project: ProjectRecord
  chapter: ChapterRecord
  settings: Settings
  capabilitiesLookup?: CapabilitiesLookup
  /** 该 provider 是否真的可用：有 Key，或 E2E 假模型模式。 */
  providerReady: (provider: string) => boolean
}

/** 本章正文的生成 provider：先看真实调用指标，再退回旁白绑定。 */
export function generationProviderOf(
  repos: Repos,
  project: ProjectRecord,
  chapter: ChapterRecord,
  capabilitiesLookup?: CapabilitiesLookup
): string | null {
  const revisionId = chapter.currentRevisionId ?? chapter.finalRevisionId
  const beatIds =
    revisionId === null ? [] : repos.revision.listMembers(revisionId).map((member) => member.beatId)
  const fromMetric = repos.turnMetric.latestProviderForBeats(beatIds)
  if (fromMetric !== null) return fromMetric
  try {
    return resolveBinding(repos, project, 'narrator', capabilitiesLookup).provider
  } catch {
    return null
  }
}

/** 已验证的第二家：启用、有探测快照、模型已知、Key 可用；按预设顺序取第一家。 */
export function secondProviderOf(
  settings: Settings,
  reviewerProvider: string,
  providerReady: (provider: string) => boolean
): { provider: string; model: string } | null {
  for (const preset of PROVIDER_PRESETS) {
    if (preset.preset === reviewerProvider) continue
    if (settings.providersEnabled[preset.preset] === false) continue
    const snapshot = settings.providers[preset.preset]
    if (!snapshot || snapshot.capabilities === null) continue
    if (!providerReady(preset.preset)) continue
    return { provider: preset.preset, model: snapshot.model ?? defaultModelFor(preset.preset) }
  }
  return null
}

export function resolveHeteroReview(input: ResolveHeteroInput): HeteroResolution {
  const reviewerBinding = resolveBinding(input.repos, input.project, 'reviewer', input.capabilitiesLookup)
  const mode = input.settings.review?.hetero ?? 'off'
  if (mode !== 'prefer') {
    return {
      provider: reviewerBinding.provider,
      model: reviewerBinding.model,
      switched: false,
      generationProvider: null,
      degraded: null,
      reviewerBinding
    }
  }

  const generationProvider = generationProviderOf(
    input.repos,
    input.project,
    input.chapter,
    input.capabilitiesLookup
  )
  if (generationProvider === null || generationProvider !== reviewerBinding.provider) {
    return {
      provider: reviewerBinding.provider,
      model: reviewerBinding.model,
      switched: false,
      generationProvider,
      degraded: null,
      reviewerBinding
    }
  }

  const second = secondProviderOf(input.settings, reviewerBinding.provider, input.providerReady)
  if (second === null) {
    return {
      provider: reviewerBinding.provider,
      model: reviewerBinding.model,
      switched: false,
      generationProvider,
      degraded: 'hetero_unavailable',
      reviewerBinding
    }
  }

  return {
    provider: second.provider,
    model: second.model,
    switched: true,
    generationProvider,
    degraded: null,
    reviewerBinding
  }
}
