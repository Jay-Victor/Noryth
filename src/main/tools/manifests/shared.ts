import { z } from 'zod'
import type { DegradeLevel, ToolFamily } from '../types'
import type { ToolAudit, ToolLimits } from '../define'

/** 42 个 manifest 共用的参数与限额默认值（PRD §4.9.2 / DEV-PLAN §6.2）。 */

export const Id = z.string().min(1).max(80)
export const Query = z.string().min(1).max(200)

const FAMILY_LIMITS: Record<ToolFamily, ToolLimits> = {
  structure: { timeoutMs: 800, maxResultTokens: 2000, maxCallsPerTurn: 2 },
  knowledge: { timeoutMs: 800, maxResultTokens: 2000, maxCallsPerTurn: 2 },
  verify: { timeoutMs: 2000, maxResultTokens: 3000, maxCallsPerTurn: 2 },
  propose: { timeoutMs: 5000, maxResultTokens: 2000, maxCallsPerTurn: 1 },
  interaction: { timeoutMs: 10_000, maxResultTokens: 1000, maxCallsPerTurn: 1 }
}

const FAMILY_DEGRADE: Record<ToolFamily, DegradeLevel[]> = {
  structure: ['full', 'summary', 'empty'],
  knowledge: ['full', 'summary', 'facts_only', 'empty'],
  verify: ['full', 'summary'],
  propose: ['full', 'summary', 'fail'],
  interaction: ['full', 'fail']
}

export function limitsFor(family: ToolFamily, patch: Partial<ToolLimits> = {}): ToolLimits {
  return { ...FAMILY_LIMITS[family], ...patch }
}

export function degradeFor(family: ToolFamily): DegradeLevel[] {
  return [...FAMILY_DEGRADE[family]]
}

/** 只存 args_hash；原文一律不落盘（PRD §7.2 / 验收清单）。 */
export const AUDIT: ToolAudit = { logArgs: 'hash', logResultIds: true }

/** JSON 列的安全解析：坏数据不抛，返回 fallback。 */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function participantIds(json: string): string[] {
  const parsed = parseJson<unknown>(json, [])
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}
