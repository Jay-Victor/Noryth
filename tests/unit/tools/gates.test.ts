import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkGate, consumeGate, issueGate, signGateToken } from '../../../src/main/tools/gates'
import { sha256Hex } from '../../../src/main/crypto'
import { closeTestDb, openTestDb } from '../db/support/db'
import { tempDir } from '../helpers'
import type { Repos } from '../../../src/main/db/repos'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'

const SECRET = 'unit-test-secret'
const temp = tempDir('noryth-gate-')
let handle: ReturnType<typeof openTestDb>
let repos: Repos
let projectId: string

beforeAll(() => {
  handle = openTestDb(temp.path)
  repos = handle.repos
  projectId = repos.project.create({
    title: '闸门测试',
    pov: 'third_limited',
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  }).id
})

afterAll(() => {
  closeTestDb(handle)
  temp.cleanup()
})

function issue(overrides: Partial<Parameters<typeof issueGate>[0]> = {}) {
  return issueGate({
    repos,
    secret: SECRET,
    projectId,
    gateId: 'G7',
    entityType: 'proposal',
    entityId: 'prop_1',
    revision: 'rev_1',
    jobId: 'job_1',
    actor: 'author',
    nowMs: 1_000,
    ...overrides
  })
}

function check(token: string | null, overrides: Partial<Parameters<typeof checkGate>[0]> = {}) {
  return checkGate({
    repos,
    secret: SECRET,
    required: 'G7',
    token,
    runtime: { project_id: projectId, job_id: 'job_1', expected_revision: 'rev_1' },
    nowMs: 2_000,
    ...overrides
  })
}

describe('gate tokens', () => {
  it('签发后可校验；只存 token_hash，不存明文', () => {
    const issued = issue()
    expect(issued.token.split('.')).toHaveLength(2)
    expect(issued.record.tokenHash).toBe(sha256Hex(issued.token))
    expect(issued.record.payloadJson).not.toContain(issued.token)
    expect(check(issued.token)).toMatchObject({ ok: true })
  })

  it('缺令牌 → gate_required', () => {
    expect(check(null)).toEqual({ ok: false, code: 'gate_required' })
  })

  it('签名被篡改 → stale_revision', () => {
    const issued = issue({ jobId: 'job_tamper' })
    expect(check(issued.token, { runtime: { project_id: projectId, job_id: 'job_tamper', expected_revision: 'rev_1' } }))
      .toMatchObject({ ok: true })
    expect(check(`${issued.token}x`, { runtime: { project_id: projectId, job_id: 'job_tamper', expected_revision: 'rev_1' } }))
      .toEqual({ ok: false, code: 'stale_revision' })
  })

  it('过期 → stale_revision', () => {
    const issued = issue({ jobId: 'job_expired' })
    expect(
      check(issued.token, {
        runtime: { project_id: projectId, job_id: 'job_expired', expected_revision: 'rev_1' },
        nowMs: issued.payload.exp + 1
      })
    ).toEqual({ ok: false, code: 'stale_revision' })
  })

  it('闸门类型不符 → stale_revision', () => {
    const issued = issue({ jobId: 'job_gate' })
    expect(
      check(issued.token, {
        required: 'G5',
        runtime: { project_id: projectId, job_id: 'job_gate', expected_revision: 'rev_1' }
      })
    ).toEqual({ ok: false, code: 'stale_revision' })
  })

  it('跨 job 复用 → gate_consumed', () => {
    const issued = issue({ jobId: 'job_a' })
    expect(
      check(issued.token, { runtime: { project_id: projectId, job_id: 'job_b', expected_revision: 'rev_1' } })
    ).toEqual({ ok: false, code: 'gate_consumed' })
  })

  it('revision 不匹配 → stale_revision', () => {
    const issued = issue({ jobId: 'job_rev' })
    expect(
      check(issued.token, {
        runtime: { project_id: projectId, job_id: 'job_rev', expected_revision: 'rev_2' }
      })
    ).toEqual({ ok: false, code: 'stale_revision' })
  })

  it('实体不匹配 → stale_revision（不区分令牌错与稿件变了）', () => {
    const issued = issue({ jobId: 'job_entity' })
    const forged = signGateToken({ ...issued.payload, eid: 'prop_other' }, SECRET)
    expect(
      check(forged, { runtime: { project_id: projectId, job_id: 'job_entity', expected_revision: 'rev_1' } })
    ).toEqual({ ok: false, code: 'stale_revision' })
  })

  it('消费后复用 → gate_consumed；重复消费抛错', () => {
    const issued = issue({ jobId: 'job_consume' })
    const runtime = { project_id: projectId, job_id: 'job_consume', expected_revision: 'rev_1' }
    expect(check(issued.token, { runtime })).toMatchObject({ ok: true })
    consumeGate(repos, issued.token)
    expect(check(issued.token, { runtime })).toEqual({ ok: false, code: 'gate_consumed' })
    expect(() => consumeGate(repos, issued.token)).toThrowError(/已使用|already consumed/)
  })

  it('G1 长期授权：校验多次仍有效，不自动消费', () => {
    const issued = issue({ gateId: 'G1', entityType: 'project', entityId: projectId, jobId: 'job_g1' })
    const runtime = { project_id: projectId, job_id: 'job_g1', expected_revision: 'rev_1' }
    expect(check(issued.token, { required: 'G1', runtime })).toMatchObject({ ok: true })
    expect(check(issued.token, { required: 'G1', runtime })).toMatchObject({ ok: true })
    expect(issued.record.consumedAt).toBeNull()
  })

  it('令牌不含明文身份参数以外的数据，且 record 与 payload 互相印证', () => {
    const issued = issue({ jobId: 'job_payload' })
    expect(issued.payload).toMatchObject({
      g: 'G7',
      et: 'proposal',
      eid: 'prop_1',
      rev: 'rev_1',
      job: 'job_payload'
    })
    const stored = JSON.parse(issued.record.payloadJson) as Record<string, unknown>
    expect(stored).toEqual(issued.payload)
  })
})
