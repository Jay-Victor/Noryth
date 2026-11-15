import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { ALL_MANIFESTS } from '../../../src/main/tools/manifests'
import { openContractWorld, type ContractWorld } from '../../contract/support/world'

/**
 * T19 / T20 的 as-of 边界（PHASE-13 M1-19 / §5.3）：
 * - `manuscript.search_final` 只返回 `chapter.ord <= 当前章` 的定稿；
 * - `manuscript.get_final_chapter` 显式请求更晚章 → invalid_args；
 * - `memory.retrieve_audit` 的 as_of 受当前章水位约束（审批不能借审计通道看未来记忆）。
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

function toolFor(name: string) {
  const tool = ALL_MANIFESTS.find((item) => item.name === name)
  if (!tool) throw new Error(`未注册工具 ${name}`)
  return tool
}

async function run(
  world: ContractWorld,
  name: string,
  args: Record<string, unknown>,
  context: { chapterId: string | null; asOf?: number }
) {
  return toolFor(name).handler(
    args,
    { runtime: { project_id: world.projectId, as_of: context.asOf ?? 3, actor_id: 'reviewer' }, chapterId: context.chapterId } as never,
    { repos: world.repos } as never
  )
}

describe('manuscript.search_final 按章截断', () => {
  it('第 1 章上下文看不到第 2 章定稿；第 2 章看得到', async () => {
    const world = setup()
    const early = await run(world, 'manuscript.search_final', { query: '匣子' }, { chapterId: world.chapterDraftId })
    expect((early.data as { hit_count: number }).hit_count).toBe(0)

    const late = await run(world, 'manuscript.search_final', { query: '匣子' }, { chapterId: world.chapterFinalId })
    const data = late.data as { hit_count: number; items: Array<{ chapter_id: string }> }
    expect(data.hit_count).toBeGreaterThan(0)
    expect(data.items.every((item) => item.chapter_id === world.chapterFinalId)).toBe(true)
  })

  it('显式请求更晚章 → invalid_args（带章序细节）', async () => {
    const world = setup()
    let error: unknown = null
    try {
      await run(
        world,
        'manuscript.search_final',
        { query: '匣子', chapter_id: world.chapterFinalId },
        { chapterId: world.chapterDraftId }
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('invalid_args')
    expect((error as AppError).details as Record<string, unknown>).toMatchObject({ currentOrd: 1 })
  })
})

describe('manuscript.get_final_chapter 按章截断', () => {
  it('第 1 章请求第 2 章定稿 → invalid_args；本章返回 found=true', async () => {
    const world = setup()
    await expect(
      run(world, 'manuscript.get_final_chapter', { chapter_id: world.chapterFinalId }, { chapterId: world.chapterDraftId })
    ).rejects.toThrowError(/本章之后/)

    const same = await run(
      world,
      'manuscript.get_final_chapter',
      { chapter_id: world.chapterFinalId },
      { chapterId: world.chapterFinalId }
    )
    expect((same.data as { found: boolean }).found).toBe(true)
  })
})

describe('memory.retrieve_audit 受水位约束', () => {
  it('as_of 越小，能看到的记忆越少；未来记忆不出现', async () => {
    const world = setup()
    const at3 = await run(
      world,
      'memory.retrieve_audit',
      { character_id: world.characterShen, query: '钥匙', issue_ref: 'ISSUE-1' },
      { chapterId: world.chapterFinalId, asOf: 3 }
    )
    expect((at3.data as { hit_count: number }).hit_count).toBe(1)

    const at1 = await run(
      world,
      'memory.retrieve_audit',
      { character_id: world.characterShen, query: '钥匙', issue_ref: 'ISSUE-1' },
      { chapterId: world.chapterFinalId, asOf: 1 }
    )
    // mem_shen_1 的 learned_seq = 2，as_of=1 时尚未学到。
    expect((at1.data as { hit_count: number }).hit_count).toBe(0)
  })
})
