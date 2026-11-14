import type { ToolCallRepo } from '../db/repos/tool-call'
import { sha256Hex } from '../crypto'
import type { ToolResult } from './types'

/**
 * 幂等键（DEV-PLAN §6.5）：
 *   key = sha256(canonicalJson({ project_id, job_id, tool, version, args_hash }))
 * 只对 propose / execute 生效；只读工具 natural，不存结果。
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 递归排键、拒绝 undefined / 非有限数字 / 非纯对象；数字不转字符串。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonical(value))
}

function toCanonical(value: unknown): JsonValue {
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: 数字必须是有限值')
    return value
  }
  if (Array.isArray(value)) return value.map((item) => toCanonical(item))
  if (value !== null && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('canonicalJson: 只接受纯对象')
    }
    const output: { [key: string]: JsonValue } = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item === undefined) throw new Error(`canonicalJson: 字段 ${key} 为 undefined`)
      output[key] = toCanonical(item)
    }
    return output
  }
  throw new Error(`canonicalJson: 不支持的类型 ${typeof value}`)
}

export function argsHash(args: unknown): string {
  return sha256Hex(canonicalJson(args))
}

export interface IdempotencyInput {
  projectId: string
  jobId: string
  tool: string
  version: string
  args: unknown
}

export function idempotencyKey(input: IdempotencyInput): string {
  return sha256Hex(
    canonicalJson({
      project_id: input.projectId,
      job_id: input.jobId,
      tool: input.tool,
      version: input.version,
      args_hash: argsHash(input.args)
    })
  )
}

export interface IdempotencyStore {
  find(projectId: string, key: string): ToolResult | null
}

/** 审计表兼作幂等结果表：result_json 只在有幂等键时写（体积控制）。 */
export class RepoIdempotencyStore implements IdempotencyStore {
  constructor(private readonly repo: ToolCallRepo) {}

  find(projectId: string, key: string): ToolResult | null {
    const record = this.repo.findByIdempotency(projectId, key)
    if (!record?.resultJson) return null
    try {
      return JSON.parse(record.resultJson) as ToolResult
    } catch {
      return null
    }
  }
}

/** 单元测试用：不持久化，永远 miss。 */
export class NullIdempotencyStore implements IdempotencyStore {
  find(): ToolResult | null {
    return null
  }
}
