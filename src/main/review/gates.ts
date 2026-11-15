import { AppError } from '../../shared/domain/app-error'
import type { Repos } from '../db/repos'
import type { GateRecordRecord } from '../db/repos/review'
import { sha256Hex } from '../crypto'
import { decodeGateToken, issueGate, type IssuedGate } from '../tools/gates'
import type { ToolGateId } from '../tools/types'

/**
 * 作者侧闸门令牌（PHASE-08 G3 / DEV-PLAN §6.5）。
 *
 * G5 / G6 与工具层的令牌是同一套格式与同一张 `gate_record`：
 *   - G5 绑定到「本次生成 patch 的 job」：审批 Agent 调 T36 时由 invoke 校验；
 *   - G6 绑定到「本章 + 当前 revision」：finalize 前由这里校验。
 * 复用 `issueGate` / `signGateToken`，不另写一套 HMAC。
 *
 * 为什么 G6 也要令牌：定稿不可撤销，必须证明「这一次点击」是作者在
 * 看到当前 revision、当前报告之后做出的，而不是旧窗口里的一个残留按钮。
 */

export type AuthorGateId = Extract<ToolGateId, 'G5' | 'G6'>

export interface AuthorGateIssueInput {
  repos: Repos
  secret: string
  projectId: string
  gateId: AuthorGateId
  entityType: 'chapter' | 'revision'
  entityId: string
  revision: string | null
  jobId: string
  actor: string
  nowMs?: number
  ttlMs?: number
}

export interface AuthorGateIssued {
  token: string
  gateRecordId: string
  expiresAt: string
}

export function issueAuthorGate(input: AuthorGateIssueInput): AuthorGateIssued {
  const issued: IssuedGate = issueGate({
    repos: input.repos,
    secret: input.secret,
    projectId: input.projectId,
    gateId: input.gateId,
    entityType: input.entityType,
    entityId: input.entityId,
    revision: input.revision,
    jobId: input.jobId,
    actor: input.actor,
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs })
  })
  return { token: issued.token, gateRecordId: issued.record.id, expiresAt: issued.expiresAt }
}

export interface AuthorGateCheckInput {
  repos: Repos
  secret: string
  gateId: AuthorGateId
  entityType: 'chapter' | 'revision'
  entityId: string
  revision: string | null
  token: string | null
  nowMs?: number
}

/**
 * 校验作者令牌（不消费）。失败原因对外统一为 stale_revision / gate_consumed，
 * 与工具层一致：不告诉调用方「令牌伪造」还是「稿件变了」。
 */
export function checkAuthorGate(input: AuthorGateCheckInput): GateRecordRecord {
  if (!input.token) throw new AppError('gate_required', `需要 ${input.gateId} 授权`, { gateId: input.gateId })
  const payload = decodeGateToken(input.token, input.secret)
  if (!payload) throw new AppError('stale_revision', '授权无效或已过期', { gateId: input.gateId })

  const nowMs = input.nowMs ?? Date.now()
  if (payload.exp <= nowMs) throw new AppError('stale_revision', '授权已过期', { gateId: input.gateId })
  if (payload.g !== input.gateId) throw new AppError('stale_revision', '授权闸门不匹配', { gateId: input.gateId })
  if (payload.et !== input.entityType || payload.eid !== input.entityId) {
    throw new AppError('stale_revision', '授权对象不匹配', {
      expected: { entityType: input.entityType, entityId: input.entityId },
      actual: { entityType: payload.et, entityId: payload.eid }
    })
  }
  if (payload.rev !== input.revision) {
    throw new AppError('stale_revision', '稿件已变更，请重新读取', {
      expected: input.revision,
      actual: payload.rev
    })
  }

  const record = input.repos.gate.findByTokenHash(sha256Hex(input.token))
  if (!record) throw new AppError('stale_revision', '授权不存在', { gateId: input.gateId })
  if (record.consumedAt !== null) throw new AppError('gate_consumed', '该确认已使用', { gateId: input.gateId })
  if (record.gateId !== input.gateId) throw new AppError('stale_revision', '授权闸门不匹配')
  if (record.decision !== 'approve') throw new AppError('gate_required', '授权未批准', { gateId: input.gateId })
  if (record.expiresAt === null || Date.parse(record.expiresAt) <= nowMs) {
    throw new AppError('stale_revision', '授权已过期', { gateId: input.gateId })
  }
  return record
}

/** 成功提交后消费；失败路径不调用，同一动作重试可复用令牌。 */
export function consumeAuthorGate(repos: Repos, token: string): void {
  const record = repos.gate.findByTokenHash(sha256Hex(token))
  if (!record) throw new AppError('stale_revision', '授权不存在')
  if (record.consumedAt !== null) throw new AppError('gate_consumed', '该确认已使用')
  const consumed = repos.gate.consumeToken(sha256Hex(token))
  if (!consumed) throw new AppError('gate_consumed', '该确认已使用')
}
