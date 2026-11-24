import type { Capabilities } from '../../shared/schema/model'
import type { RoutingTrace } from '../../shared/schema/routing'
import { estimateTokens } from '../context/tokens'
import type { Repos } from '../db/repos'
import type { TurnMetricRecord } from '../db/repos/model'
import { estimateCostCny } from './presets'

/**
 * 全链路模型调用计量（PHASE-20 §5.3 / M2-5）。
 *
 * 唯一写入口：写拍、审批、记忆、讨论、规划都走 `recordTurnMetric()`。
 * `turn_id` 对一次调用稳定，重试 / 重放用 upsert，不产生第二行。
 *
 * 归因：写拍/审批/记忆/讨论 → `chapter_id` 命中章；规划是项目级 → NULL，
 * 报表不强行摊到章（避免假归因）。
 */

export type MetricKind = 'beat' | 'review' | 'memory' | 'plan' | 'orchestrator'

export interface TurnUsageTotals {
  tokensIn: number | null
  tokensOut: number | null
}

export interface RecordTurnMetricInput {
  repos: Repos
  projectId: string
  jobId: string
  turnId: string
  agentKey: string
  chapterId: string | null
  beatId: string | null
  provider: string
  model: string
  bindingVersion: number
  usage: TurnUsageTotals
  /** 用于计价的能力快照；缺省或没有价格时 cost_cny 为 null（不伪造 0）。 */
  capabilities?: Capabilities | null
  latencyMs: number | null
  firstTokenMs?: number | null
  /** 写拍传 contextSnapshot()；非写拍传 simpleContextJson()。 */
  contextJson: string
  degraded?: readonly string[]
  createdAt?: string
}

/**
 * 非写拍调用的 context_json：只存可归因的元数据，不存提示词全文或正文。
 * （PHASE-20 §5.3）
 */
export function simpleContextJson(input: {
  kind: Exclude<MetricKind, 'beat'>
  promptVersion: string
  toolsetVersion: string
  blockTokens: number
  /** 发生路由切换时留痕（PHASE-21 §5.1）；不切换时不写这个键。 */
  routing?: RoutingTrace | null
}): string {
  return JSON.stringify({
    kind: input.kind,
    prompt_version: input.promptVersion,
    toolset_version: input.toolsetVersion,
    block_tokens: Math.max(0, Math.round(input.blockTokens)),
    ...(input.routing == null ? {} : { routing: input.routing })
  })
}

/** 估算一组提示词块的总 token（非写拍调用没有上下文装配器）。 */
export function promptTokensOf(texts: readonly string[]): number {
  return texts.reduce((sum, text) => sum + estimateTokens(text), 0)
}

export function recordTurnMetric(input: RecordTurnMetricInput): TurnMetricRecord {
  const costCny = estimateCostCny(input.capabilities ?? null, input.usage.tokensIn, input.usage.tokensOut)
  return input.repos.turnMetric.upsert({
    turnId: input.turnId,
    projectId: input.projectId,
    jobId: input.jobId,
    beatId: input.beatId,
    chapterId: input.chapterId,
    agentKey: input.agentKey,
    provider: input.provider,
    model: input.model,
    bindingVersion: input.bindingVersion,
    tokensIn: input.usage.tokensIn,
    tokensOut: input.usage.tokensOut,
    costCny,
    latencyMs: input.latencyMs,
    firstTokenMs: input.firstTokenMs ?? null,
    contextJson: input.contextJson,
    degradedJson: JSON.stringify(input.degraded ?? []),
    createdAt: input.createdAt ?? new Date().toISOString()
  })
}

/** 把多轮 ChatResult 的 usage 相加；一轮都没有 usage 时返回 null（不伪造 0）。 */
export function sumUsages(
  usages: ReadonlyArray<{ promptTokens: number; completionTokens: number } | null | undefined>
): TurnUsageTotals {
  let tokensIn = 0
  let tokensOut = 0
  let seen = false
  for (const usage of usages) {
    if (!usage) continue
    seen = true
    tokensIn += usage.promptTokens
    tokensOut += usage.completionTokens
  }
  return seen ? { tokensIn, tokensOut } : { tokensIn: null, tokensOut: null }
}
