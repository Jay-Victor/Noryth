import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invokeTool, type TurnContext } from '../../src/main/tools/invoke'
import { RepoAuditSink } from '../../src/main/tools/audit'
import { TurnBudget } from '../../src/main/tools/budget'
import { consumeGate, issueGate } from '../../src/main/tools/gates'
import { RepoIdempotencyStore } from '../../src/main/tools/idempotency'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { resolveToolset } from '../../src/main/tools/resolve'
import type { ToolServices } from '../../src/main/tools/types'
import { openContractWorld, type ContractWorld } from './support/world'

/** 验收硬项：memory.apply 无令牌 / 错实体 / 复用令牌 / 幂等重放。 */

const SECRET = 'memory-apply-secret'
const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const toolset = resolveToolset('memory', {}, registry)
let world: ContractWorld
let services: ToolServices

beforeAll(() => {
  world = openContractWorld()
  services = { repos: world.repos, now: () => Date.now() }
})

afterAll(() => {
  world.cleanup()
})

function context(token: string | null, jobId: string, turnId: string): TurnContext {
  return {
    projectId: world.projectId,
    jobId,
    turnId,
    actorId: 'memory',
    characterId: null,
    asOf: 3,
    epoch: 1,
    expectedRevision: null,
    gateToken: token,
    chapterId: world.chapterFinalId,
    beatId: null,
    mode: 'interactive'
  }
}

async function invoke(args: unknown, ctx: TurnContext) {
  return invokeTool(
    { callId: `call_${ctx.turnId}`, tool: 'memory.apply', args },
    ctx,
    {
      toolset,
      budget: new TurnBudget('memory'),
      audit: new RepoAuditSink(world.repos.toolCall),
      idempotency: new RepoIdempotencyStore(world.repos.toolCall),
      gateSecret: SECRET
    },
    services
  )
}

function issue(entityId: string, jobId: string): string {
  return issueGate({
    repos: world.repos,
    secret: SECRET,
    projectId: world.projectId,
    gateId: 'G7',
    entityType: 'proposal',
    entityId,
    revision: null,
    jobId,
    actor: 'author'
  }).token
}

const args = {
  proposal_id: 'job_prop',
  decisions: [
    { item_id: 'mpi_accept', decision: 'accept' },
    { item_id: 'mpi_reject', decision: 'accept' }
  ]
}

describe('memory.apply 闸门与幂等', () => {
  it('无令牌 → gate_required，且不写记忆', async () => {
    const before = world.repos.memory.listByCharacter(world.characterLin).length
    const result = await invoke(args, context(null, 'job_no_token', 'turn_no_token'))
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('gate_required')
    expect(world.repos.memory.listByCharacter(world.characterLin)).toHaveLength(before)
  })

  it('错实体 → stale_revision', async () => {
    const token = issue('prop_other', 'job_wrong_entity')
    const result = await invoke(args, context(token, 'job_wrong_entity', 'turn_wrong_entity'))
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('stale_revision')
  })

  it('正确令牌 → 应用；重放 duplicate；令牌消费后换参数 → gate_consumed', async () => {
    const ctx = context(null, 'job_apply', 'turn_apply')
    const token = issue('job_prop', ctx.jobId)
    const withToken = { ...ctx, gateToken: token }

    const first = await invoke(args, withToken)
    expect(first.ok, JSON.stringify(first.error ?? first)).toBe(true)
    expect(first.data).toMatchObject({ applied_count: 2, rejected_count: 0 })
    const fact = world.repos.world.current('黑漆匣子', '归属')
    expect(fact).not.toBeNull()
    expect(fact?.truth).toBe('objective')
    expect(fact?.sourceType).toBe('memory')

    const replay = await invoke(args, withToken)
    expect(replay.duplicate).toBe(true)

    consumeGate(world.repos, token)
    const reused = await invoke(
      {
        proposal_id: 'job_prop',
        decisions: [{ item_id: 'mpi_accept', decision: 'reject' }]
      },
      withToken
    )
    expect(reused.ok).toBe(false)
    expect(reused.error?.code).toBe('gate_consumed')
  })
})
