import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invokeTool, type TurnContext } from '../../src/main/tools/invoke'
import { RepoAuditSink } from '../../src/main/tools/audit'
import { TurnBudget } from '../../src/main/tools/budget'
import { RepoIdempotencyStore } from '../../src/main/tools/idempotency'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { resolveToolset } from '../../src/main/tools/resolve'
import type { ToolServices } from '../../src/main/tools/types'
import { openContractWorld, type ContractWorld } from './support/world'

/** T13：限知投影只返回本人已知与已揭示事实，被过滤条数进 filtered_count。 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
let world: ContractWorld
let services: ToolServices

beforeAll(() => {
  world = openContractWorld()
  services = { repos: world.repos, now: () => Date.now() }
})

afterAll(() => {
  world.cleanup()
})

describe('world.get_limited', () => {
  it('返回公开与本人已知事实，秘密未揭示事实被过滤并计入 filtered_count', async () => {
    const ctx: TurnContext = {
      projectId: world.projectId,
      jobId: 'job_limited',
      turnId: 'turn_limited',
      actorId: 'character:chr_lin',
      characterId: world.characterLin,
      asOf: 3,
      epoch: 1,
      expectedRevision: world.revisionDraftId,
      gateToken: null,
      chapterId: world.chapterDraftId,
      beatId: null,
      mode: 'interactive'
    }
    const result = await invokeTool(
      { callId: 'c1', tool: 'world.get_limited', args: {} },
      ctx,
      {
        toolset: resolveToolset('character:chr_lin', {}, registry),
        budget: new TurnBudget('character:chr_lin'),
        audit: new RepoAuditSink(world.repos.toolCall),
        idempotency: new RepoIdempotencyStore(world.repos.toolCall),
        gateSecret: 'limited'
      },
      services
    )
    expect(result.ok).toBe(true)
    expect(result.filtered_count).toBe(1)
    const ids = (result.data as { facts: Array<{ id: string }> }).facts.map((fact) => fact.id).sort()
    expect(ids).toEqual(['wf_public', 'wf_secret'])
  })

  it('as_of 不能越过运行时水位', async () => {
    const ctx: TurnContext = {
      projectId: world.projectId,
      jobId: 'job_future',
      turnId: 'turn_future',
      actorId: 'character:chr_lin',
      characterId: world.characterLin,
      asOf: 1,
      epoch: 1,
      expectedRevision: world.revisionDraftId,
      gateToken: null,
      chapterId: world.chapterDraftId,
      beatId: null,
      mode: 'interactive'
    }
    const result = await invokeTool(
      { callId: 'c2', tool: 'world.get_limited', args: { as_of: 99 } },
      ctx,
      {
        toolset: resolveToolset('character:chr_lin', {}, registry),
        budget: new TurnBudget('character:chr_lin'),
        audit: new RepoAuditSink(world.repos.toolCall),
        idempotency: new RepoIdempotencyStore(world.repos.toolCall),
        gateSecret: 'limited'
      },
      services
    )
    expect(result.ok).toBe(true)
    expect((result.data as { as_of: number }).as_of).toBe(1)
  })
})
