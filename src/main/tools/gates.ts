import { AppError } from '../../shared/domain/app-error'
import type { Repos } from '../db/repos'
import type { GateRecordRecord } from '../db/repos/review'
import { base64UrlDecode, base64UrlEncode, hmacSha256Base64Url, randomHex, safeEqualString, sha256Hex } from '../crypto'
import type { ToolGateId, ToolRuntime, VerifiedGate } from './types'

/**
 * 闸门令牌（DEV-PLAN §6.5）：
 *   payload = { g, et, eid, rev, job, exp, nonce }
 *   token   = base64url(JSON) + "." + base64url(HMAC-SHA256(secret, base64url(JSON)))
 *
 * 规则：
 * - TTL 10 分钟；exp 由主进程时钟签发与校验。
 * - 绑定 gate_id + entity_type + entity_id + revision + job_id 五项。
 * - 只存 sha256(token)，不落明文；消费由 job 成功提交后调用 consumeGate。
 * - 实体不匹配统一返回 stale_revision，不区分「令牌错」与「稿件变了」。
 */

export const GATE_TOKEN_TTL_MS = 10 * 60 * 1000

type GateTokenPayload = VerifiedGate

function encodePayload(payload: GateTokenPayload): string {
  return base64UrlEncode(JSON.stringify(payload))
}

export function signGateToken(payload: GateTokenPayload, secret: string): string {
  const encoded = encodePayload(payload)
  return `${encoded}.${hmacSha256Base64Url(secret, encoded)}`
}

function isGatePayload(value: unknown): value is GateTokenPayload {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.g === 'string' &&
    typeof record.et === 'string' &&
    typeof record.eid === 'string' &&
    (typeof record.rev === 'string' || record.rev === null) &&
    typeof record.job === 'string' &&
    typeof record.exp === 'number' &&
    Number.isFinite(record.exp) &&
    typeof record.nonce === 'string'
  )
}

/** 只验签名与结构；过期、绑定、消费在 checkGate 里判定。 */
export function decodeGateToken(token: string, secret: string): GateTokenPayload | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [encoded, signature] = parts as [string, string]
  const expected = hmacSha256Base64Url(secret, encoded)
  if (!safeEqualString(signature, expected)) return null
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(encoded))
    return isGatePayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

export interface IssueGateInput {
  repos: Repos
  secret: string
  projectId: string
  gateId: ToolGateId
  entityType: string
  entityId: string
  revision: string | null
  jobId: string
  actor: string
  nowMs?: number
  ttlMs?: number
  nonce?: string
}

export interface IssuedGate {
  token: string
  payload: GateTokenPayload
  record: GateRecordRecord
  expiresAt: string
}

export function issueGate(input: IssueGateInput): IssuedGate {
  const nowMs = input.nowMs ?? Date.now()
  const exp = nowMs + (input.ttlMs ?? GATE_TOKEN_TTL_MS)
  const payload: GateTokenPayload = {
    g: input.gateId,
    et: input.entityType,
    eid: input.entityId,
    rev: input.revision,
    job: input.jobId,
    exp,
    nonce: input.nonce ?? randomHex(16)
  }
  const token = signGateToken(payload, input.secret)
  const expiresAt = new Date(exp).toISOString()
  const record = input.repos.gate.insert({
    projectId: input.projectId,
    gateId: input.gateId,
    entityType: input.entityType,
    entityId: input.entityId,
    decision: 'approve',
    actor: input.actor,
    payloadJson: JSON.stringify(payload),
    tokenHash: sha256Hex(token),
    expiresAt
  })
  return { token, payload, record, expiresAt }
}

export type GateCheck =
  | { ok: true; payload: GateTokenPayload }
  | { ok: false; code: 'gate_required' | 'gate_consumed' | 'stale_revision' }

/**
 * 校验令牌。注意：这里只校验，不消费——调用失败时同一 job 必须能复用令牌。
 */
export function checkGate(input: {
  repos: Repos
  secret: string
  required: ToolGateId
  token: string | null
  runtime: Pick<ToolRuntime, 'project_id' | 'job_id' | 'expected_revision'>
  nowMs?: number
}): GateCheck {
  if (!input.token) return { ok: false, code: 'gate_required' }

  const payload = decodeGateToken(input.token, input.secret)
  if (!payload) return { ok: false, code: 'stale_revision' }

  const nowMs = input.nowMs ?? Date.now()
  if (payload.exp <= nowMs) return { ok: false, code: 'stale_revision' }
  if (payload.g !== input.required) return { ok: false, code: 'stale_revision' }
  // 令牌绑定到 job：跨 job 复用视为已用（不区分「另一个 job」与「已消费」）。
  if (payload.job !== input.runtime.job_id) return { ok: false, code: 'gate_consumed' }
  if (payload.rev !== input.runtime.expected_revision) return { ok: false, code: 'stale_revision' }

  const record = input.repos.gate.findByTokenHash(sha256Hex(input.token))
  if (!record) return { ok: false, code: 'stale_revision' }
  if (record.projectId !== input.runtime.project_id) return { ok: false, code: 'stale_revision' }
  if (record.consumedAt !== null) return { ok: false, code: 'gate_consumed' }
  if (record.gateId !== input.required) return { ok: false, code: 'stale_revision' }
  if (record.entityType !== payload.et || record.entityId !== payload.eid || record.decision !== 'approve') {
    return { ok: false, code: 'stale_revision' }
  }
  if (record.expiresAt === null || Date.parse(record.expiresAt) <= nowMs) return { ok: false, code: 'stale_revision' }

  return { ok: true, payload }
}

/** job 成功提交后消费一次性令牌；G1 是长期授权，不调用本函数。 */
export function consumeGate(repos: Repos, token: string): void {
  const tokenHash = sha256Hex(token)
  const record = repos.gate.findByTokenHash(tokenHash)
  if (!record) throw new AppError('stale_revision', 'gate token not found')
  if (record.consumedAt !== null) throw new AppError('gate_consumed', 'gate token already consumed')
  const consumed = repos.gate.consumeToken(tokenHash)
  if (!consumed) throw new AppError('gate_consumed', 'gate token already consumed')
}

/** 登记 G1 长期授权（无令牌）：用于 memory.namespace.create 的重试窗口。 */
export function recordLongLivedGrant(input: {
  repos: Repos
  projectId: string
  gateId: ToolGateId
  entityType: string
  entityId: string
  actor: string
}): GateRecordRecord {
  return input.repos.gate.insert({
    projectId: input.projectId,
    gateId: input.gateId,
    entityType: input.entityType,
    entityId: input.entityId,
    decision: 'approve',
    actor: input.actor,
    payloadJson: '{}'
  })
}
