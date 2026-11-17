import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { TOOL_CALL_PAGE_SIZE } from '../../../src/main/db/repos/tool-call'
import { openTestDb } from './support/db'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/**
 * tool_call 审计（PHASE-18 M1-23）：
 * - 章 / Agent / 状态三个过滤；
 * - 分页 50，按时间倒序；
 * - 记录里只有 args_hash，没有参数原文。
 */
describe('tool_call 审计', () => {
  function setup() {
    const dir = tempDir('noryth-tool-call-')
    cleanups.push(dir.cleanup)
    mkdirSync(join(dir.path, 'manuscript'), { recursive: true })
    const { db, repos } = openTestDb(dir.path)
    cleanups.push(() => db.close())
    const project = repos.project.create({
      title: '审计',
      genre: '悬疑',
      pov: 'third_limited',
      targetWords: 100_000,
      embeddingModel: 'hash-bigram-v1',
      embeddingDim: 512,
      defaultPreset: 'deepseek',
      schemaVersion: LATEST_SCHEMA_VERSION
    })
    const insert = (
      index: number,
      input: Partial<{ chapterId: string | null; actorId: string; status: 'ok' | 'error'; tool: string }> = {}
    ): void => {
      repos.toolCall.insert({
        id: `tc_${String(index).padStart(3, '0')}`,
        projectId: project.id,
        jobId: `job_${index}`,
        turnId: `turn_${index}`,
        tool: input.tool ?? 'memory.search_own',
        toolVersion: '1.0.0',
        actorId: input.actorId ?? 'narrator',
        scopeJson: JSON.stringify({ actor_id: input.actorId ?? 'narrator', as_of: index }),
        argsHash: `${index}`.padStart(64, '0'),
        status: input.status ?? 'ok',
        errorCode: input.status === 'error' ? 'invalid_args' : null,
        latencyMs: index,
        degraded: 'none',
        chapterId: input.chapterId === undefined ? 'ch_1' : input.chapterId,
        // 时间递增，倒序分页才有确定顺序。
        createdAt: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.${String(index).padStart(3, '0')}Z`
      })
    }
    return { project, repos, insert }
  }

  it('按章 / Agent / 状态过滤，计数与列表同口径', () => {
    const { project, repos, insert } = setup()
    insert(1, { chapterId: 'ch_1', actorId: 'narrator' })
    insert(2, { chapterId: 'ch_1', actorId: 'character:chr_a' })
    insert(3, { chapterId: 'ch_2', actorId: 'narrator', status: 'error' })
    insert(4, { chapterId: null, actorId: 'planner' })

    expect(repos.toolCall.listByProject(project.id)).toHaveLength(4)
    expect(repos.toolCall.listByProject(project.id, { chapterId: 'ch_1' })).toHaveLength(2)
    expect(repos.toolCall.listByProject(project.id, { actorId: 'narrator' })).toHaveLength(2)
    expect(repos.toolCall.listByProject(project.id, { status: 'error' })).toHaveLength(1)
    expect(
      repos.toolCall.listByProject(project.id, { chapterId: 'ch_1', actorId: 'narrator', status: 'ok' })
    ).toHaveLength(1)
    expect(repos.toolCall.countByProject(project.id, { chapterId: 'ch_1' })).toBe(2)
    expect(repos.toolCall.countByProject(project.id, { status: 'error' })).toBe(1)
    expect(repos.toolCall.countByProject(project.id)).toBe(4)
    expect(repos.toolCall.distinctActors(project.id)).toEqual(['character:chr_a', 'narrator', 'planner'])
  })

  it('分页固定 50、时间倒序；越界页返回空列表但总数不变', () => {
    const { project, repos, insert } = setup()
    for (let index = 1; index <= 55; index += 1) insert(index)

    const first = repos.toolCall.listByProject(project.id)
    expect(first).toHaveLength(TOOL_CALL_PAGE_SIZE)
    expect(first[0]!.id).toBe('tc_055')
    expect(first.at(-1)!.id).toBe('tc_006')

    const second = repos.toolCall.listByProject(project.id, { offset: TOOL_CALL_PAGE_SIZE })
    expect(second).toHaveLength(5)
    expect(second[0]!.id).toBe('tc_005')

    expect(repos.toolCall.countByProject(project.id)).toBe(55)
    expect(repos.toolCall.listByProject(project.id, { offset: 500 })).toEqual([])
    // 上限 200：面板不能一次把整张表读进 renderer。
    expect(repos.toolCall.listByProject(project.id, { limit: 500 })).toHaveLength(55)
  })

  it('记录只带 args_hash：参数原文与结果 ID 不落到面板字段', () => {
    const { project, repos, insert } = setup()
    insert(1)
    const [record] = repos.toolCall.listByProject(project.id)
    expect(record).toBeDefined()
    expect(record!.argsHash).toMatch(/^[0-9]{64}$/)
    expect(Object.keys(record!)).not.toContain('args')
    expect(record!.scopeJson).not.toContain('正文')
    expect(record!.chapterId).toBe('ch_1')
  })
})
