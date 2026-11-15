import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { collectContext, resolveChapterAsOf } from '../../../src/main/context/sources'
import { openContractWorld, type ContractWorld } from '../../contract/support/world'

/**
 * 认知水位（PHASE-13 §5.1 / M1-19）：
 * - 已写章：本章 covered_until_seq；
 * - 新章：前一章 covered_until_seq（第一章 0），绝不 fallback 到 project.seq_head；
 * - 审批：严格本章水位，为 0 时拒绝（invalid_args）。
 */

const worlds: ContractWorld[] = []

afterEach(() => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
})

function setup(): ContractWorld {
  const world = openContractWorld()
  worlds.push(world)
  return world
}

describe('resolveChapterAsOf', () => {
  it('已写章取本章水位；新章取前一章水位；第一章为 0', () => {
    const world = setup()
    const draft = world.repos.chapter.get(world.chapterDraftId)!
    const final = world.repos.chapter.get(world.chapterFinalId)!
    expect(resolveChapterAsOf(world.repos, draft, 'write')).toBe(2)
    expect(resolveChapterAsOf(world.repos, final, 'write')).toBe(3)

    // 新章（还没有确认拍）：看前一章结束时的认知。
    const node = world.repos.outline.insert({
      projectId: world.projectId,
      parentId: null,
      kind: 'chapter',
      ord: 3,
      title: '第三章',
      content: '占位',
      status: 'draft'
    })
    const chapter = world.repos.chapter.insert({
      projectId: world.projectId,
      outlineNodeId: node.id,
      ord: 3,
      status: 'planned',
      coveredUntilSeq: 0
    })
    expect(resolveChapterAsOf(world.repos, chapter, 'write')).toBe(3)

    // 第一章没有前一章 → 0（G1 的世界事实 valid_from_seq=0 仍可见）。
    world.repos.chapter.setCoveredUntilSeq(draft.id, 0)
    expect(resolveChapterAsOf(world.repos, world.repos.chapter.get(draft.id)!, 'write')).toBe(0)
  })

  it('审批模式严格用本章水位；0 时 invalid_args，不 fallback seq_head', () => {
    const world = setup()
    const draft = world.repos.chapter.get(world.chapterDraftId)!
    expect(resolveChapterAsOf(world.repos, draft, 'review')).toBe(2)

    world.repos.chapter.setCoveredUntilSeq(draft.id, 0)
    let error: unknown = null
    try {
      resolveChapterAsOf(world.repos, world.repos.chapter.get(draft.id)!, 'review')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('invalid_args')
    expect((error as AppError).message).toContain('不能按章复审')
  })

  it('collectContext 用同一套水位；review 模式在 0 水位拒绝', () => {
    const world = setup()
    const collected = collectContext(world.repos, {
      projectId: world.projectId,
      chapterId: world.chapterDraftId,
      beatId: world.beatDraftId,
      agent: `character:${world.characterLin}`,
      mode: 'write'
    })
    expect(collected.asOf).toBe(2)

    expect(() =>
      collectContext(world.repos, {
        projectId: world.projectId,
        chapterId: world.chapterDraftId,
        beatId: world.beatDraftId,
        agent: `character:${world.characterLin}`,
        mode: 'review'
      })
    ).not.toThrow()

    world.repos.chapter.setCoveredUntilSeq(world.chapterDraftId, 0)
    expect(() =>
      collectContext(world.repos, {
        projectId: world.projectId,
        chapterId: world.chapterDraftId,
        beatId: world.beatDraftId,
        agent: `character:${world.characterLin}`,
        mode: 'review'
      })
    ).toThrowError(/不能按章复审/)
  })
})
