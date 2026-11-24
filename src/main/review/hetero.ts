import type { Settings } from '../../shared/schema/project'
import type { RoutingTrace } from '../../shared/schema/routing'
import type { Repos } from '../db/repos'
import type { ChapterRecord } from '../db/repos/chapter'
import type { ProjectRecord } from '../db/repos/project'
import { resolveBinding, type CapabilitiesLookup, type ResolvedBinding } from '../model/bindings'
import { defaultModelFor, PROVIDER_PRESETS } from '../model/presets'

/**
 * 异构复检（PHASE-16 §5.3 / M1-22）与路由优先级（PHASE-21 §5.3）。
 *
 * `review.hetero = 'prefer'` 时，审批 job 开始时判断：
 *   1. 本章正文实际由哪一家生成（`turn_metric` 最近一条带 beat 的调用；
 *      没生成过就用旁白绑定）；
 *   2. 若审批与生成是同一家，且存在「已验证」的第二家（有 Key / 已测试连接），
 *      自动改用第二家；
 *   3. 被选中的家不健康时，才看路由备用家；备用家不能等于生成家
 *      （宁可 `hetero_unavailable` 也不假异构）；
 *   4. 找不到第二家 → 报告标 `degraded = 'hetero_unavailable'`，不阻断；
 *   5. 解析只在 job 开始时做一次，job 内不换模型（DEV-PLAN §7.7）。
 *
 * 路由关闭时（`routing.enabled=false`）`usable` 视为全健康，行为与阶段 16 一致。
 */

export type HeteroDegraded = 'hetero_unavailable' | 'routing_exhausted' | null

export interface HeteroResolution {
  /** 本次审批实际使用的绑定。 */
  provider: string
  model: string
  /** 是否从配置的 reviewer 绑定切到了别家（异构或路由）。 */
  switched: boolean
  /** 本章正文的生成 provider（留痕与 UI 解释用）。 */
  generationProvider: string | null
  degraded: HeteroDegraded
  reviewerBinding: ResolvedBinding
  /** 路由切换留痕；异构直选第二家时为 null（不是故障切换）。 */
  routing: RoutingTrace | null
}

export interface ResolveHeteroInput {
  repos: Repos
  project: ProjectRecord
  chapter: ChapterRecord
  settings: Settings
  capabilitiesLookup?: CapabilitiesLookup
  /** 该 provider 是否真的可用：有 Key，或 E2E 假模型模式。 */
  providerReady: (provider: string) => boolean
  /** 路由备用家（已校验）；null = 没配或不可用。 */
  fallback?: { preset: string; model?: string } | null
  /** 该 provider 当前是否健康；省略视为健康。 */
  usable?: (provider: string) => boolean
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

/** 已验证的第二家：启用、有探测快照、模型已知、有工具能力、Key 可用；按预设顺序取第一家。 */
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
    if (snapshot.capabilities.tools !== true) continue
    if (!providerReady(preset.preset)) continue
    return { provider: preset.preset, model: snapshot.model ?? defaultModelFor(preset.preset) }
  }
  return null
}

function fallbackModelOf(fallback: { preset: string; model?: string }): string {
  return fallback.model ?? defaultModelFor(fallback.preset)
}

function traceOf(input: Omit<RoutingTrace, 'at'>): RoutingTrace {
  return { ...input, at: new Date().toISOString() }
}

export function resolveHeteroReview(input: ResolveHeteroInput): HeteroResolution {
  const reviewerBinding = resolveBinding(input.repos, input.project, 'reviewer', input.capabilitiesLookup)
  const usable = input.usable ?? (() => true)
  const reviewerHealthy = usable(reviewerBinding.provider)
  const fallback = input.fallback ?? null
  const fallbackUsable =
    fallback !== null && fallback.preset !== reviewerBinding.provider && usable(fallback.preset)
      ? fallback
      : null
  const mode = input.settings.review?.hetero ?? 'off'

  // 路由（非异构）：主家最近失败/熔断，且作者配了备用家。
  if (mode !== 'prefer') {
    if (!reviewerHealthy && fallbackUsable !== null) {
      return {
        provider: fallbackUsable.preset,
        model: fallbackModelOf(fallbackUsable),
        switched: true,
        generationProvider: null,
        degraded: null,
        reviewerBinding,
        routing: traceOf({
          from: reviewerBinding.provider,
          to: fallbackUsable.preset,
          reason: 'primary_unhealthy',
          error: null
        })
      }
    }
    return {
      provider: reviewerBinding.provider,
      model: reviewerBinding.model,
      switched: false,
      generationProvider: null,
      degraded: null,
      reviewerBinding,
      routing: null
    }
  }

  const generationProvider = generationProviderOf(
    input.repos,
    input.project,
    input.chapter,
    input.capabilitiesLookup
  )

  // 生成已经是别家：审批本身满足异构；只在 reviewer 不健康时允许路由备用。
  if (generationProvider === null || generationProvider !== reviewerBinding.provider) {
    if (!reviewerHealthy && fallbackUsable !== null && fallbackUsable.preset !== generationProvider) {
      return {
        provider: fallbackUsable.preset,
        model: fallbackModelOf(fallbackUsable),
        switched: true,
        generationProvider,
        degraded: null,
        reviewerBinding,
        routing: traceOf({
          from: reviewerBinding.provider,
          to: fallbackUsable.preset,
          reason: 'primary_unhealthy',
          error: null
        })
      }
    }
    return {
      provider: reviewerBinding.provider,
      model: reviewerBinding.model,
      switched: false,
      generationProvider,
      degraded: null,
      reviewerBinding,
      routing: null
    }
  }

  // 审批与生成同家：先选异构第二家。
  const second = secondProviderOf(input.settings, reviewerBinding.provider, input.providerReady)
  if (second === null) {
    return {
      provider: reviewerBinding.provider,
      model: reviewerBinding.model,
      switched: false,
      generationProvider,
      degraded: 'hetero_unavailable',
      reviewerBinding,
      routing: null
    }
  }

  if (usable(second.provider)) {
    return {
      provider: second.provider,
      model: second.model,
      switched: true,
      generationProvider,
      degraded: null,
      reviewerBinding,
      routing: null
    }
  }

  // 第二家不健康：只有「备用家不是生成家」才允许兜底，否则宁可不异构。
  if (fallbackUsable !== null && fallbackUsable.preset !== generationProvider) {
    return {
      provider: fallbackUsable.preset,
      model: fallbackModelOf(fallbackUsable),
      switched: true,
      generationProvider,
      degraded: null,
      reviewerBinding,
      routing: traceOf({
        from: second.provider,
        to: fallbackUsable.preset,
        reason: 'hetero_second_unhealthy',
        error: null
      })
    }
  }

  return {
    provider: reviewerBinding.provider,
    model: reviewerBinding.model,
    switched: false,
    generationProvider,
    degraded: 'hetero_unavailable',
    reviewerBinding,
    routing: null
  }
}
