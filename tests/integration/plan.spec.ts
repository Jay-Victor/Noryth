import { afterEach, describe, expect, it } from 'vitest'
import { PlanService, type PlanHost } from '../../src/main/plan/service'
import type { PlannerModel } from '../../src/main/plan/model'
import { FakePlannerAdapter } from '../../src/main/plan/fake-adapter'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { SettingsSchema } from '../../src/shared/schema/project'
import type { ResolvedBinding } from '../../src/main/model/bindings'
import { openPlanWorld, type PlanTestWorld } from '../support/plan-world'

/**
 * 阶段 06 集成：假规划模型 + 真实工具管道 + 提案表 + G1。
 *
 * 假模型只提供模型行为，不绕过任何写入边界：提案由 T31/T33 落库，
 * 应用提案才写大纲/角色草案，G1 才注册角色与建命名空间。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const binding: ResolvedBinding = {
  agentKey: 'planner',
  provider: 'deepseek',
  model: 'planner-fake',
  params: {},
  version: 0,
  source: 'preset'
}

const worlds: PlanTestWorld[] = []
afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function world(): PlanTestWorld {
  const item = openPlanWorld()
  worlds.push(item)
  return item
}

function serviceFor(host: PlanHost, delayMs = 0): PlanService {
  const model: PlannerModel = {
    binding,
    adapter: new FakePlannerAdapter(delayMs),
    status: { provider: 'deepseek', model: 'planner-fake', label: '假模型', ready: true }
  }
  return new PlanService({
    host: () => host,
    registry,
    settings: () => SettingsSchema.parse({}),
    allowFakeModel: true,
    emit: () => {},
    emitChoice: () => {},
    model: () => model
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (check()) return
    await sleep(10)
  }
  throw new Error('waitFor timeout')
}

describe('阶段 06 规划链路', () => {
  it('对话 → 提案 → 应用 → G1 全链路', async () => {
    const w = world()
    const host: PlanHost = { dir: w.dir, db: w.handle.db, repos: w.repos, readOnly: false }
    const service = serviceFor(host)

    const session = service.createSession({})
    const sent = service.send({ sessionId: session.id, text: '写一个民国悬疑：替人写遗书的女子发现账本' })
    await waitFor(() => w.repos.planMessage.get(sent.assistantMessageId)!.status === 'done')

    const assistant = w.repos.planMessage.get(sent.assistantMessageId)!
    const meta = JSON.parse(assistant.metaJson) as { label?: string; proposal_ids?: string[] }
    expect(assistant.body.length).toBeGreaterThan(0)
    expect(meta.label).toBe('draft')
    expect(meta.proposal_ids).toHaveLength(2)
    expect(w.repos.outline.listByProject(w.projectId)).toHaveLength(0)
    expect(w.repos.planCharacter.listByProject(w.projectId)).toHaveLength(0)

    const proposals = w.repos.proposal.listByProject(w.projectId)
    expect(proposals.map((proposal) => proposal.kind).sort()).toEqual(['blueprint_patch', 'roster'])

    const blueprint = proposals.find((proposal) => proposal.kind === 'blueprint_patch')!
    const roster = proposals.find((proposal) => proposal.kind === 'roster')!
    service.applyProposal({ proposalId: blueprint.id })
    service.applyProposal({ proposalId: roster.id })

    expect(w.repos.outline.listByProject(w.projectId)).toHaveLength(4)
    expect(w.repos.planCharacter.listByProject(w.projectId)).toHaveLength(5)
    expect(w.repos.planFact.listByProject(w.projectId)).toHaveLength(8)
    expect(w.repos.project.get()!.blueprintVersion).toBe(2)

    const preview = service.g1Preview()
    expect(preview.blockers).toEqual([])
    expect(preview.counts.mains).toBe(1)
    expect(preview.counts.volumes).toBe(1)
    expect(preview.counts.chapters).toBe(2)

    const result = service.confirmG1()
    expect(result.setupState).toBe('complete')
    expect(result.registeredCount).toBe(5)
    expect(result.namespaces.filter((item) => item.kind === 'private')).toHaveLength(5)
    expect(result.namespaces.filter((item) => item.kind === 'public')).toHaveLength(1)
    expect(result.isolationVerified).toBe(true)

    expect(w.repos.character.list(w.projectId)).toHaveLength(5)
    expect(w.repos.world.listByProject(w.projectId)).toHaveLength(8)
    expect(w.repos.chapter.listByProject(w.projectId)).toHaveLength(2)

    const state = service.getState({ sessionId: session.id })
    expect(state.setupState).toBe('complete')
    expect(state.g1.locked).toBe(true)
    expect(state.characters.every((character) => character.status === 'registered')).toBe(true)
    expect(state.namespaces.privateCount).toBe(5)
    expect(state.namespaces.publicCount).toBe(1)
    expect(state.proposals.every((proposal) => proposal.status === 'applied')).toBe(true)

    const audit = w.repos.toolCall.listByTurn(`pturn_${sent.assistantMessageId}`)
    expect(audit.some((row) => row.tool === 'blueprint.propose_patch' && row.status === 'ok')).toBe(true)
    expect(audit.some((row) => row.tool === 'roster.propose' && row.status === 'ok')).toBe(true)
  })
})
