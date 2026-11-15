import type { SecretStore } from '../settings/secrets'

/**
 * API Key 解析（PHASE-10 I1）。
 *
 * 优先级：设置页写入 safeStorage 的 Key → `NORYTH_<PROVIDER>_API_KEY`
 * → 该 Agent 的历史环境变量兜底（`NORYTH_WRITE_API_KEY` 等）。
 *
 * 设置页生效后环境变量只做兜底：作者在界面里填过 Key，就不该被 shell 里
 * 残留的旧变量悄悄覆盖。返回来源是为了在状态灯里说清「Key 来自哪里」，
 * 而不是只给一个布尔。
 */

export interface ResolvedApiKey {
  key: string
  source: 'settings' | 'env'
}

export type ApiKeyLookup = (provider: string) => ResolvedApiKey | null

/**
 * 每个 Agent 的历史环境变量兜底顺序（唯一真源）。
 * 设置页填过 Key 之后这些变量只在不覆盖已保存值的前提下生效。
 */
export const AGENT_KEY_FALLBACKS = {
  planner: ['NORYTH_PLAN_API_KEY'],
  orchestrator: ['NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY'],
  character: ['NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY'],
  narrator: ['NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY'],
  reviewer: ['NORYTH_REVIEW_API_KEY', 'NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY'],
  memory: ['NORYTH_MEMORY_API_KEY', 'NORYTH_REVIEW_API_KEY', 'NORYTH_WRITE_API_KEY', 'NORYTH_PLAN_API_KEY']
} as const

function nonEmpty(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function envApiKeyLookup(fallbacks: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): ApiKeyLookup {
  return (provider) => {
    const specific = nonEmpty(env[`NORYTH_${provider.toUpperCase()}_API_KEY`])
    if (specific !== null) return { key: specific, source: 'env' }
    for (const name of fallbacks) {
      const value = nonEmpty(env[name])
      if (value !== null) return { key: value, source: 'env' }
    }
    return null
  }
}

export function settingsFirstLookup(
  secrets: Pick<SecretStore, 'get'> | null,
  fallbacks: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env
): ApiKeyLookup {
  const fromEnv = envApiKeyLookup(fallbacks, env)
  return (provider) => {
    const stored = secrets?.get(provider)
    if (stored !== null && stored !== undefined) {
      const trimmed = stored.trim()
      if (trimmed.length > 0) return { key: trimmed, source: 'settings' }
    }
    return fromEnv(provider)
  }
}
