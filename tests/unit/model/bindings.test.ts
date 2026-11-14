import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bindingFor, freezeBindings, resolveBinding, setBinding } from '../../../src/main/model/bindings'
import { openContractWorld, type ContractWorld } from '../../contract/support/world'

describe('绑定解析与冻结（PRD §9.3 / DEV-PLAN §7.7）', () => {
  let world: ContractWorld

  beforeAll(() => {
    world = openContractWorld()
  })
  afterAll(() => {
    world?.cleanup()
  })

  it('未绑定：角色实例 → character → 项目默认预设', () => {
    const project = world.repos.project.get()!
    const binding = resolveBinding(world.repos, project, 'character:chr_lin')
    expect(binding.provider).toBe('deepseek')
    expect(binding.model).toBe('deepseek-flash')
    expect(binding.source).toBe('preset')
    expect(binding.version).toBe(0)
  })

  it('角色级绑定被实例继承，实例级绑定优先', () => {
    const project = world.repos.project.get()!
    setBinding(
      world.repos,
      { projectId: world.projectId, agentKey: 'character', provider: 'openai', model: 'gpt-4.1-mini' },
      'author'
    )
    expect(resolveBinding(world.repos, project, 'character:chr_lin')).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      source: 'agent',
      version: 1
    })

    setBinding(
      world.repos,
      { projectId: world.projectId, agentKey: 'character:chr_lin', provider: 'deepseek', model: 'deepseek-chat' },
      'author'
    )
    expect(resolveBinding(world.repos, project, 'character:chr_lin')).toMatchObject({
      provider: 'deepseek',
      model: 'deepseek-chat',
      source: 'instance',
      version: 1
    })
    // 另一个角色仍继承角色级
    expect(resolveBinding(world.repos, project, 'character:chr_shen')).toMatchObject({
      provider: 'openai',
      source: 'agent'
    })
  })

  it('其他 Agent 先查自身绑定，再继承项目绑定', () => {
    const project = world.repos.project.get()!
    setBinding(
      world.repos,
      { projectId: world.projectId, agentKey: 'project', provider: 'tongyi', model: 'qwen-plus' },
      'author'
    )
    expect(resolveBinding(world.repos, project, 'reviewer')).toMatchObject({
      provider: 'tongyi',
      model: 'qwen-plus',
      source: 'project'
    })

    setBinding(
      world.repos,
      { projectId: world.projectId, agentKey: 'reviewer', provider: 'openai', model: 'gpt-4.1' },
      'author'
    )
    expect(resolveBinding(world.repos, project, 'reviewer')).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      source: 'agent'
    })
  })

  it('job 内绑定快照不漂移：改绑定后旧快照不变，新快照 hash 变化', () => {
    const project = world.repos.project.get()!
    const before = freezeBindings(world.repos, project, ['character:chr_lin'], '2026-01-01T00:00:00.000Z')
    expect(before.hash).toMatch(/^[0-9a-f]{64}$/)

    setBinding(
      world.repos,
      { projectId: world.projectId, agentKey: 'character:chr_lin', provider: 'tongyi', model: 'qwen-plus' },
      'author'
    )
    const frozen = bindingFor(before, 'character:chr_lin')
    expect(frozen.model).toBe('deepseek-chat')

    const after = freezeBindings(world.repos, project, ['character:chr_lin'], '2026-01-02T00:00:00.000Z')
    expect(after.hash).not.toBe(before.hash)
    expect(bindingFor(after, 'character:chr_lin').model).toBe('qwen-plus')
  })

  it('绑定变更写审计（旧/新 JSON + 操作者）', () => {
    const audit = world.repos.modelBinding.listAudit(world.projectId)
    expect(audit.length).toBeGreaterThanOrEqual(4)
    const latest = audit.at(-1)!
    expect(latest.actor).toBe('author')
    expect(JSON.parse(latest.newJson)).toMatchObject({ agentKey: 'character:chr_lin', provider: 'tongyi' })
    expect(latest.oldJson).not.toBeNull()
  })

  it('探测到的能力随绑定冻结：lookup 优先于预设表', () => {
    const project = world.repos.project.get()!
    const probed = {
      stream: true,
      tools: false,
      jsonMode: true,
      contextWindow: 32_000,
      maxOutput: 4_096,
      pricing: { in: 0, out: 0 }
    }
    const snapshot = freezeBindings(world.repos, project, ['character:chr_lin'], '2026-01-03T00:00:00.000Z', () => probed)
    expect(bindingFor(snapshot, 'character:chr_lin').capabilities).toEqual(probed)
    // 没有 lookup 时不冻结，运行时回落预设
    const plain = freezeBindings(world.repos, project, ['character:chr_lin'], '2026-01-03T00:00:00.000Z')
    expect(bindingFor(plain, 'character:chr_lin').capabilities).toBeUndefined()
  })

  it('快照缺少条目时按角色/项目回退，仍找不到则抛 setup_incomplete', () => {
    const project = world.repos.project.get()!
    const snapshot = freezeBindings(world.repos, project, ['project' as never], '2026-01-01T00:00:00.000Z')
    expect(bindingFor(snapshot, 'character:chr_lin').provider).toBe(
      snapshot.bindings.project?.provider
    )
    expect(() =>
      bindingFor({ version: 1, at: '2026-01-01T00:00:00.000Z', bindings: {}, hash: 'x' }, 'reviewer')
    ).toThrowError(/job 缺少模型绑定快照/)
  })
})
