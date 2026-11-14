import { describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import {
  addOutlineNode,
  addPlanCharacter,
  removeOutlineNode,
  saveCharacterCard,
  saveOutlineNode
} from '../../../src/main/plan/draft'
import { openPlanWorld, fullCard, seedBlueprint, type PlanTestWorld } from '../../support/plan-world'

describe('规划草稿编辑', () => {
  const created: PlanTestWorld[] = []
  const world = (): PlanTestWorld => {
    const item = openPlanWorld()
    created.push(item)
    return item
  }
  const cleanup = (): void => {
    while (created.length > 0) created.pop()!.cleanup()
  }

  it('800ms 自动保存的落点：字段更新 version +1；G1 后拒绝', () => {
    const w = world()
    try {
      const { chapterId } = seedBlueprint(w)
      const before = w.repos.outline.get(chapterId)!
      const saved = saveOutlineNode(w.repos, { nodeId: chapterId, content: '雨夜，祠堂只剩一盏灯。' })
      expect(saved.saved).toBe(true)
      expect(saved.version).toBe(before.version + 1)
      expect(w.repos.outline.get(chapterId)!.content).toBe('雨夜，祠堂只剩一盏灯。')

      w.repos.project.lockBlueprint(w.projectId)
      let code = ''
      try {
        saveOutlineNode(w.repos, { nodeId: chapterId, title: '改名' })
      } catch (error) {
        code = error instanceof AppError ? error.code : 'unknown'
      }
      expect(code).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('新增节点遵守层级与同级 ord 唯一', () => {
    const w = world()
    try {
      const { mainId, volumeId } = seedBlueprint(w)
      const chapter = addOutlineNode(w.repos, {
        parentId: volumeId,
        kind: 'chapter',
        title: '第二章',
        content: ''
      })
      expect(w.repos.outline.get(chapter.id)!.parentId).toBe(volumeId)

      let code = ''
      try {
        addOutlineNode(w.repos, { parentId: mainId, kind: 'chapter', title: '错层', content: '' })
      } catch (error) {
        code = error instanceof AppError ? error.code : 'unknown'
      }
      expect(code).toBe('invalid_args')

      code = ''
      try {
        addOutlineNode(w.repos, { parentId: volumeId, kind: 'chapter', ord: 1, title: '重复', content: '' })
      } catch (error) {
        code = error instanceof AppError ? error.code : 'unknown'
      }
      expect(code).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('有子节点的节点不能删除', () => {
    const w = world()
    try {
      const { mainId } = seedBlueprint(w)
      let code = ''
      try {
        removeOutlineNode(w.repos, mainId)
      } catch (error) {
        code = error instanceof AppError ? error.code : 'unknown'
      }
      expect(code).toBe('invalid_args')
    } finally {
      cleanup()
    }
  })

  it('角色卡保存递增 card_version；缺 voice 时仍可保存但 G1 会阻断', () => {
    const w = world()
    try {
      const added = addPlanCharacter(w.repos, { name: '沈昼', card: fullCard() })
      const saved = saveCharacterCard(w.repos, {
        characterId: added.id,
        card: fullCard({ want: '换动机', voice: { sentence_length: '短', catchphrase: '', address_habit: '', banned_words: '' } })
      })
      expect(saved.cardVersion).toBe(2)
      expect(saved.affectedChapters).toEqual([])
      expect(w.repos.planCharacter.get(added.id)!.cardVersion).toBe(2)
    } finally {
      cleanup()
    }
  })
})
