import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import type { Capabilities } from '../../../src/shared/schema/model'
import { SecretStore, testCipher } from '../../../src/main/settings/secrets'
import { SettingsService } from '../../../src/main/settings/service'
import { SettingsStore } from '../../../src/main/settings/store'
import { openTestDb } from '../db/support/db'
import { seedFixture } from '../db/support/fixture'
import { tempDir } from '../helpers'

/**
 * 绑定继承链、批次审计与回滚（I2）。
 *
 * 回滚语义是撤销栈：每次回滚最近一批未被回滚过的变更，
 * 连续回滚可以一路退回初始状态，但同一批不会被回滚两次。
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

const CAPABILITIES: Capabilities = {
  stream: true,
  tools: true,
  jsonMode: true,
  contextWindow: 64_000,
  maxOutput: 8_192,
  pricing: { in: 0, out: 0 }
}

function setup(options: { tested?: boolean } = {}) {
  const dir = tempDir('noryth-bindings-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  const store = new SettingsStore(join(dir.path, 'settings.json'))
  const secrets = new SecretStore(join(dir.path, 'secrets.bin'), testCipher())
  if (options.tested !== false) {
    store.write({
      providers: {
        deepseek: {
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-flash',
          capabilities: CAPABILITIES,
          checkedAt: '2026-11-15T00:00:00.000Z'
        }
      }
    })
  }
  const service = new SettingsService({
    store,
    secrets,
    host: () => ({ db: handle.db, repos: handle.repos }),
    now: () => '2026-11-15T00:00:00.000Z'
  })
  return { handle, seed, store, secrets, service }
}

function codeOf(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof AppError) return error.code
    throw error
  }
  throw new Error('expected AppError')
}

describe('绑定继承与审计（I2）', () => {
  it('未绑定时六个 Agent 都继承项目默认预设', () => {
    const { seed, service } = setup()
    const matrix = service.bindings(seed.projectId)
    expect(matrix.defaultPreset).toBe('deepseek')
    const project = matrix.rows.find((row) => row.agentKey === 'project')!
    expect(project).toMatchObject({ provider: 'deepseek', model: 'deepseek-flash', source: 'preset', version: 0 })
    for (const row of matrix.rows.filter((entry) => entry.agentKey !== 'project')) {
      expect(row.source).toBe('preset')
    }
    expect(matrix.canRollback).toBe(false)
  })

  it('没有通过测试连接的模型不能绑定（PRD §5.6）', () => {
    const { seed, service } = setup({ tested: false })
    expect(
      codeOf(() =>
        service.setBindings({
          projectId: seed.projectId,
          changes: [{ agentKey: 'reviewer', provider: 'deepseek', model: 'deepseek-chat' }]
        })
      )
    ).toBe('model_untested')
  })

  it('绑定写入一批审计；继承链依次是实例 → 角色 → 项目 → 预设', () => {
    const { seed, service } = setup()
    const characterId = seed.characterIds[0]!
    let matrix = service.setBindings({
      projectId: seed.projectId,
      changes: [
        { agentKey: 'project', provider: 'deepseek', model: 'deepseek-chat' },
        { agentKey: 'reviewer', provider: 'deepseek', model: 'deepseek-flash' }
      ]
    })
    expect(matrix.rows.find((row) => row.agentKey === 'project')).toMatchObject({
      model: 'deepseek-chat',
      source: 'project',
      version: 1
    })
    // 未显式绑定的旁白继承项目默认
    expect(matrix.rows.find((row) => row.agentKey === 'narrator')).toMatchObject({
      model: 'deepseek-chat',
      source: 'project'
    })
    expect(matrix.rows.find((row) => row.agentKey === 'reviewer')?.source).toBe('agent')
    expect(matrix.auditCount).toBe(2)
    expect(matrix.canRollback).toBe(true)

    // 角色行覆盖 → 角色实例继承角色行 → 实例覆盖优先
    matrix = service.setBindings({
      projectId: seed.projectId,
      changes: [{ agentKey: 'character', provider: 'deepseek', model: 'deepseek-flash' }]
    })
    const character = matrix.characters.find((entry) => entry.characterId === characterId)!
    expect(character.override).toBeNull()
    expect(character.effective).toMatchObject({ model: 'deepseek-flash', source: 'agent' })

    matrix = service.setBindings({
      projectId: seed.projectId,
      changes: [{ agentKey: `character:${characterId}`, provider: 'deepseek', model: 'deepseek-chat' }]
    })
    const overridden = matrix.characters.find((entry) => entry.characterId === characterId)!
    expect(overridden.override).toMatchObject({ model: 'deepseek-chat', source: 'instance' })
    expect(overridden.effective.model).toBe('deepseek-chat')
  })

  it('回滚按批次撤销：逐批退回，同一批不能回滚两次', () => {
    const { seed, service } = setup()
    const characterId = seed.characterIds[0]!
    service.setBindings({
      projectId: seed.projectId,
      changes: [{ agentKey: 'reviewer', provider: 'deepseek', model: 'deepseek-flash' }]
    })
    service.setBindings({
      projectId: seed.projectId,
      changes: [{ agentKey: `character:${characterId}`, provider: 'deepseek', model: 'deepseek-chat' }]
    })

    let matrix = service.rollback(seed.projectId)
    const instance = matrix.characters.find((entry) => entry.characterId === characterId)!
    expect(instance.override).toBeNull()
    // 角色实例那一批是「新增」，回滚等于删除；reviewer 那批还在
    expect(matrix.rows.find((row) => row.agentKey === 'reviewer')?.source).toBe('agent')
    expect(matrix.canRollback).toBe(true)

    matrix = service.rollback(seed.projectId)
    expect(matrix.rows.find((row) => row.agentKey === 'reviewer')?.source).toBe('preset')
    expect(matrix.canRollback).toBe(false)
    expect(codeOf(() => service.rollback(seed.projectId))).toBe('invalid_args')

    const audit = service.audit(seed.projectId)
    expect(audit.filter((entry) => entry.actor === 'author')).toHaveLength(4)
    expect(new Set(audit.map((entry) => entry.batchId)).size).toBe(4)
  })

  it('回滚「删除型」变更是把旧值写回去，版本继续递增', () => {
    const { seed, service } = setup()
    service.setBindings({
      projectId: seed.projectId,
      changes: [{ agentKey: 'reviewer', provider: 'deepseek', model: 'deepseek-chat' }]
    })
    const afterFirst = service.bindings(seed.projectId).rows.find((row) => row.agentKey === 'reviewer')!
    expect(afterFirst.version).toBe(1)

    service.setBindings({
      projectId: seed.projectId,
      changes: [{ agentKey: 'reviewer', provider: 'deepseek', model: 'deepseek-flash' }]
    })
    const matrix = service.rollback(seed.projectId)
    const restored = matrix.rows.find((row) => row.agentKey === 'reviewer')!
    expect(restored.model).toBe('deepseek-chat')
    expect(restored.version).toBe(3)
  })
})
