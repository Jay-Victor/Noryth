import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { applyProposal } from '../../../src/main/plan/proposals'
import { emptyCharacterCard, type CharacterCard } from '../../../src/shared/schema/plan'
import { openPlanWorld, fullCard, seedBlueprint, type PlanTestWorld } from '../../support/plan-world'

function blueprintProposal(world: PlanTestWorld): string {
  const ops = [
    {
      op: 'add',
      parent_id: null,
      ref: 'main',
      kind: 'main',
      ord: 0,
      title: '主线：黑漆匣子',
      content: '一封遗书牵出账本。'
    },
    {
      op: 'add',
      parent_id: null,
      parent_ref: 'main',
      ref: 'vol',
      kind: 'volume',
      ord: 0,
      title: '第一卷',
      content: '开始查账。'
    },
    {
      op: 'add',
      parent_id: null,
      parent_ref: 'vol',
      ref: 'ch1',
      kind: 'chapter',
      ord: 0,
      title: '第一章',
      content: '祠堂夜谈。'
    },
    {
      op: 'add',
      parent_id: null,
      parent_ref: 'vol',
      kind: 'chapter',
      ord: 1,
      title: '第二章',
      content: '旧账。'
    }
  ]
  return world.repos.proposal.insert({
    projectId: world.projectId,
    kind: 'blueprint_patch',
    jobId: 'plan_job',
    turnId: 'plan_turn',
    payloadJson: JSON.stringify({ ops }),
    summaryJson: JSON.stringify({ added: 4, updated: 0, removed: 0 })
  }).id
}

function rosterProposal(world: PlanTestWorld): string {
  return world.repos.proposal.insert({
    projectId: world.projectId,
    kind: 'roster',
    jobId: 'plan_job',
    turnId: 'plan_turn',
    payloadJson: JSON.stringify({
      roster: {
        characters: [
          { name: '沈昼', card: fullCard() },
          { name: '沈砚', card: fullCard({ identity: '沈家账房' }) }
        ],
        initial_facts: [
          { subject: '黑漆匣子', predicate: '位置', object: '祠堂供桌下面', visibility: 'secret' },
          { subject: '沈家', predicate: '所在地', object: '临水镇', visibility: 'public' }
        ]
      }
    }),
    summaryJson: JSON.stringify({ characters: 2, facts: 2 })
  }).id
}

describe('提案应用', () => {
  const created: PlanTestWorld[] = []
  const world = (): PlanTestWorld => {
    const item = openPlanWorld()
    created.push(item)
    return item
  }
  const cleanup = (): void => {
    while (created.length > 0) created.pop()!.cleanup()
  }

  it('蓝图提案一次建整棵树，草案版本 +1', () => {
    const w = world()
    try {
      const proposalId = blueprintProposal(w)
      const result = applyProposal(w.handle.db, w.repos, proposalId)
      expect(result.nodesCreated).toBe(4)
      expect(result.blueprintVersion).toBe(1)
      expect(w.repos.outline.listByProject(w.projectId)).toHaveLength(4)
      expect(w.repos.proposal.get(proposalId)!.status).toBe('applied')

      let code = ''
      try {
        applyProposal(w.handle.db, w.repos, proposalId)
      } catch (error) {
        code = error instanceof AppError ? error.code : 'unknown'
      }
      expect(code).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('角色清单提案写角色卡草案与世界初值，不注册正式角色', () => {
    const w = world()
    try {
      const proposalId = rosterProposal(w)
      const result = applyProposal(w.handle.db, w.repos, proposalId)
      expect(result.charactersCreated).toBe(2)
      expect(result.factsCreated).toBe(2)
      expect(w.repos.planCharacter.listByProject(w.projectId)).toHaveLength(2)
      expect(w.repos.planFact.listByProject(w.projectId)).toHaveLength(2)
      expect(w.repos.character.list(w.projectId)).toHaveLength(0)
      expect(w.repos.world.listByProject(w.projectId)).toHaveLength(0)
    } finally {
      cleanup()
    }
  })

  it('G1 锁定后拒绝蓝图提案', () => {
    const w = world()
    try {
      seedBlueprint(w)
      w.repos.project.lockBlueprint(w.projectId)
      const proposalId = blueprintProposal(w)
      let code = ''
      try {
        applyProposal(w.handle.db, w.repos, proposalId)
      } catch (error) {
        code = error instanceof AppError ? error.code : 'unknown'
      }
      expect(code).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('角色卡提案改版递增 card_version 并列出受影响章节', () => {
    const w = world()
    try {
      const character = w.repos.planCharacter.insert({
        projectId: w.projectId,
        name: '沈昼',
        cardJson: JSON.stringify(fullCard())
      })
      const card = fullCard({ want: '换一个动机' })
      const proposal = w.repos.proposal.insert({
        projectId: w.projectId,
        kind: 'character_card',
        jobId: 'plan_job',
        turnId: 'plan_turn',
        payloadJson: JSON.stringify({ character_id: character.id, target: 'plan', card }),
        summaryJson: JSON.stringify({ character_name: '沈昼', affected_chapters: [] })
      })
      const result = applyProposal(w.handle.db, w.repos, proposal.id)
      expect(result.affectedChapters).toEqual([])
      const updated = w.repos.planCharacter.get(character.id)!
      expect(updated.cardVersion).toBe(2)
      expect(JSON.parse(updated.cardJson).want).toBe('换一个动机')
    } finally {
      cleanup()
    }
  })

  it('归一化角色卡时丢弃模型多给的字段，保留 voice 四项', () => {
    const w = world()
    try {
      const card: CharacterCard & Record<string, unknown> = {
        ...emptyCharacterCard(),
        identity: '账房',
        voice: { sentence_length: '短', catchphrase: '嗯', address_habit: '您', banned_words: '无' },
        role: '账房先生',
        extra: '忽略我'
      }
      const proposal = w.repos.proposal.insert({
        projectId: w.projectId,
        kind: 'roster',
        jobId: 'plan_job',
        turnId: 'plan_turn',
        payloadJson: JSON.stringify({
          roster: { characters: [{ name: '沈砚', card }], initial_facts: [] }
        })
      })
      applyProposal(w.handle.db, w.repos, proposal.id)
      const stored = JSON.parse(w.repos.planCharacter.byName(w.projectId, '沈砚')!.cardJson) as Record<string, unknown>
      expect(stored.role).toBeUndefined()
      expect(stored.extra).toBeUndefined()
      expect((stored.voice as Record<string, string>).catchphrase).toBe('嗯')
    } finally {
      cleanup()
    }
  })
})
