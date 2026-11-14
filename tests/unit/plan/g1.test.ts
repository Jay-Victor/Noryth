import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { confirmG1, g1Blockers, g1Preview, retrySetup } from '../../../src/main/plan/g1'
import { openPlanWorld, seedBlueprint, seedCharacters, fullCard, type PlanTestWorld } from '../../support/plan-world'

describe('G1 蓝图确认', () => {
  const created: PlanTestWorld[] = []
  const world = (): PlanTestWorld => {
    const item = openPlanWorld()
    created.push(item)
    return item
  }
  const cleanup = (): void => {
    while (created.length > 0) created.pop()!.cleanup()
  }

  it('结构缺失时按「主线 → 卷 → 章 → 角色」顺序阻断', () => {
    const w = world()
    try {
      expect(g1Blockers(w.repos)).toEqual(['至少需要 1 条主线', '至少需要 1 卷', '至少需要 1 章', '至少需要 1 个角色'])
      expect(g1Preview(w.repos).firstBlocker).toBe('至少需要 1 条主线')
    } finally {
      cleanup()
    }
  })

  it('voice 缺一项时阻断，补齐后可确认', () => {
    const w = world()
    try {
      seedBlueprint(w)
      const partial = fullCard({ voice: { sentence_length: '', catchphrase: '「嗯。」', address_habit: '您', banned_words: '无' } })
      w.repos.planCharacter.insert({
        projectId: w.projectId,
        name: '沈昼',
        cardJson: JSON.stringify(partial)
      })
      expect(g1Blockers(w.repos)[0]).toBe('角色「沈昼」缺少 voice：句长倾向')
    } finally {
      cleanup()
    }
  })

  it('G1 注册角色、写世界初值、锁蓝图、建 5+1 命名空间并幂等', () => {
    const w = world()
    try {
      const { mainId, volumeId, chapterId } = seedBlueprint(w)
      seedCharacters(w, ['沈昼', '沈砚'])
      w.repos.planFact.insert({
        projectId: w.projectId,
        subject: '黑漆匣子',
        predicate: '位置',
        object: '祠堂供桌下面',
        visibility: 'secret'
      })
      w.repos.planFact.insert({
        projectId: w.projectId,
        subject: '沈家',
        predicate: '所在地',
        object: '临水镇',
        visibility: 'public'
      })

      expect(g1Blockers(w.repos)).toEqual([])
      const result = confirmG1(w.handle.db, w.repos)

      expect(result.setupState).toBe('complete')
      expect(result.blueprintVersion).toBe(1)
      expect(result.lockedAt).not.toBeNull()
      expect(result.registeredCount).toBe(2)
      expect(result.isolationVerified).toBe(true)
      expect(result.namespaces.filter((item) => item.kind === 'private')).toHaveLength(2)
      expect(result.namespaces.filter((item) => item.kind === 'public')).toHaveLength(1)
      expect(result.setupError).toBeNull()

      const gates = w.repos.gate.listByEntity('project', w.projectId).filter((gate) => gate.gateId === 'G1')
      expect(gates).toHaveLength(1)
      expect(gates[0]!.decision).toBe('approve')
      expect(w.repos.character.list(w.projectId)).toHaveLength(2)
      expect(w.repos.world.listByProject(w.projectId)).toHaveLength(2)
      expect(w.repos.chapter.listByProject(w.projectId)).toHaveLength(1)
      for (const nodeId of [mainId, volumeId, chapterId]) {
        expect(w.repos.outline.get(nodeId)!.status).toBe('locked')
      }
      expect(w.repos.project.metadata(w.projectId).isolation_verified).toBe(true)

      const again = confirmG1(w.handle.db, w.repos)
      expect(again.gateId).toBe(result.gateId)
      expect(w.repos.gate.listByEntity('project', w.projectId).filter((gate) => gate.gateId === 'G1')).toHaveLength(1)
      expect(w.repos.namespace.listByProject(w.projectId)).toHaveLength(3)
    } finally {
      cleanup()
    }
  })

  it('建库半失败不回滚蓝图，重试后 complete', () => {
    const w = world()
    try {
      seedBlueprint(w)
      seedCharacters(w, ['沈昼', '沈砚'])
      w.repos.planFact.insert({
        projectId: w.projectId,
        subject: '黑漆匣子',
        predicate: '位置',
        object: '祠堂供桌下面'
      })

      let code = ''
      try {
        confirmG1(w.handle.db, w.repos, { failAfter: 1 })
      } catch (error) {
        code = error instanceof AppError ? error.code : 'unknown'
      }
      expect(code).toBe('setup_incomplete')
      expect(w.repos.project.get()!.setupState).toBe('failed')
      expect(w.repos.project.get()!.blueprintLockedAt).not.toBeNull()
      expect(w.repos.character.list(w.projectId)).toHaveLength(2)
      expect(w.repos.world.listByProject(w.projectId)).toHaveLength(1)
      expect(w.repos.namespace.listByProject(w.projectId)).toHaveLength(1)

      const retried = retrySetup(w.repos)
      expect(retried.setupState).toBe('complete')
      expect(retried.isolationVerified).toBe(true)
      expect(retried.namespaces).toHaveLength(3)
      expect(w.repos.gate.listByEntity('project', w.projectId).filter((gate) => gate.gateId === 'G1')).toHaveLength(1)
    } finally {
      cleanup()
    }
  })

  it('重复确认不会写第二条 G1，也不会重复注册角色', () => {
    const w = world()
    try {
      seedBlueprint(w)
      seedCharacters(w, ['沈昼'])
      confirmG1(w.handle.db, w.repos)
      confirmG1(w.handle.db, w.repos)
      confirmG1(w.handle.db, w.repos)
      expect(w.repos.gate.listByEntity('project', w.projectId).filter((gate) => gate.gateId === 'G1')).toHaveLength(1)
      expect(w.repos.character.list(w.projectId)).toHaveLength(1)
    } finally {
      cleanup()
    }
  })
})
