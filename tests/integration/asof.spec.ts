import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { hashManifestRows } from '../../src/main/db/hash'
import { allocateSeq } from '../../src/main/db/seq'
import type { MemoryEntryRecord } from '../../src/main/db/repos/memory'
import { withTransaction } from '../../src/main/db/tx'
import { createOpenAiCompatAdapter } from '../../src/main/model/openai-compat'
import { runReviewTurn } from '../../src/main/review/run'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { WorldService } from '../../src/main/world/service'
import { AppError } from '../../src/shared/domain/app-error'
import type { ReviewReport } from '../../src/shared/schema/report'
import { openTestDb, type TestDb } from '../unit/db/support/db'
import { startFakeLlm, type FakeLlmServer } from './support/fake-llm'

/**
 * E2E-M1-ASOF-01 的集成层（PHASE-13 §6 / M1-19）。
 *
 * 三章：第 1 章定稿、第 3 章 draft_complete（可审）、第 20 章定稿。
 * 四条事实分别验证四种可见性：
 *   f_old        第 1 序产生、第 1 序揭示   → ch3 可见且读者已知
 *   f_secret     秘密，known_by 含林砚      → ch3 存在，读者不知
 *   f_late       第 1 序产生、第 92 序揭示  → ch3 存在（审计可见）但读者未知
 *   f_future     第 90 序才产生             → ch3 **不存在**（futureFacts）
 *
 * 断言重点：审批第 3 章时，工具结果里没有 f_future，但保留 f_late——
 * 「读者未知」不等于「不存在」（PHASE-13 §5.3）。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const GATE_SECRET = 'integration-asof-gate'
const CH3_LINES = [
  '她把茶盏推过去：「匣子的事，你听谁说的？」',
  '他低头拨灯芯，没有接话。',
  '窗外的雨忽然大了。',
  '她起身把门掩上，屋里只剩灯影。'
]

interface AsofWorld {
  dir: string
  handle: TestDb
  projectId: string
  chapterOne: string
  chapterThree: string
  chapterTwenty: string
  chapterEmpty: string
  beats: { one: string[]; three: string[]; twenty: string[] }
  memories: MemoryEntryRecord[]
  cleanup: () => void
}

const worlds: AsofWorld[] = []
const servers: FakeLlmServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  for (const world of worlds.splice(0)) world.cleanup()
})

function buildWorld(): AsofWorld {
  const dir = mkdtempSync(join(tmpdir(), 'noryth-asof-'))
  const handle = openTestDb(dir)
  const repos = handle.repos

  const built = withTransaction(handle.db, () => {
    const project = repos.project.create({
      title: '黑漆匣子 · as-of',
      genre: '悬疑',
      pov: 'third_limited',
      targetWords: 100_000,
      embeddingModel: 'bge-small-zh-v1.5',
      embeddingDim: 512,
      defaultPreset: 'deepseek',
      schemaVersion: LATEST_SCHEMA_VERSION
    })
    repos.project.setSetupState(project.id, 'complete')
    repos.project.lockBlueprint(project.id)

    const lin = repos.character.insert({
      id: 'chr_lin',
      projectId: project.id,
      name: '林砚',
      cardJson: JSON.stringify({ role: '主角', want: '查清真相', fear: '成为共犯', voice: '短句' })
    })
    const shen = repos.character.insert({
      id: 'chr_shen',
      projectId: project.id,
      name: '沈青梧',
      cardJson: JSON.stringify({ role: '女主', want: '守住祠堂', fear: '被逐出族谱', voice: '客气' })
    })

    const addChapter = (input: {
      id: string
      ord: number
      title: string
      status: 'draft_complete' | 'finalized' | 'planned'
      covered: number
      seqs: number[]
      lines: readonly string[]
      final: boolean
    }): string[] => {
      const node = repos.outline.insert({
        id: `out_${input.id}`,
        projectId: project.id,
        parentId: null,
        kind: 'chapter',
        ord: input.ord,
        title: input.title,
        content: `${input.title}的章纲`,
        status: 'approved'
      })
      const chapter = repos.chapter.insert({
        id: input.id,
        projectId: project.id,
        outlineNodeId: node.id,
        ord: input.ord,
        status: input.status,
        coveredUntilSeq: input.covered
      })
      const scene = repos.scene.insert({
        id: `scn_${input.id}`,
        projectId: project.id,
        ord: input.ord,
        location: `第 ${input.ord} 章的地点`,
        participantsJson: JSON.stringify([lin.id, shen.id]),
        goal: `第 ${input.ord} 章目标`,
        entry: '',
        exitJson: JSON.stringify({ dtype: 'beats', count: input.lines.length }),
        status: input.final ? 'closed' : 'open'
      })
      repos.scene.linkToChapter(chapter.id, scene.id, 1)

      const revisionId = `rev_${input.id}`
      const beatIds = input.lines.map((_line, index) => `bt_${input.id}_${index + 1}`)
      const manifest = beatIds.map((beatId, index) => ({
        beatId,
        sceneId: scene.id,
        sceneOrd: 1,
        beatOrd: index + 1,
        speakerType: index % 2 === 0 ? ('character' as const) : ('narrator' as const),
        speakerId: index % 2 === 0 ? lin.id : 'narrator',
        body: input.lines[index]!
      }))
      repos.revision.insert({
        id: revisionId,
        chapterId: chapter.id,
        parentRevisionId: null,
        kind: input.final ? 'final' : 'draft',
        contentHash: hashManifestRows(manifest),
        createdBy: 'doc_controller'
      })
      for (const [index, member] of manifest.entries()) {
        repos.beat.insert({
          id: member.beatId,
          chapterId: chapter.id,
          sceneId: member.sceneId,
          ord: member.beatOrd,
          seq: input.seqs[index]!,
          speakerType: member.speakerType,
          speakerId: member.speakerId,
          body: member.body,
          status: 'confirmed',
          createdRevisionId: revisionId,
          wordCount: [...member.body].length
        })
      }
      repos.revision.insertMembers(
        revisionId,
        manifest.map((member) => ({
          revisionId,
          beatId: member.beatId,
          sceneOrd: member.sceneOrd,
          beatOrd: member.beatOrd
        }))
      )
      repos.chapter.setCurrentRevision(chapter.id, revisionId)
      if (input.final) repos.chapter.setFinalRevision(chapter.id, revisionId)
      return beatIds
    }

    const one = addChapter({
      id: 'ch_001',
      ord: 1,
      title: '第一章 祠堂夜谈',
      status: 'finalized',
      covered: 2,
      seqs: [1, 2],
      lines: ['她把茶盏推过去：「匣子的事，你听谁说的？」', '他低头拨灯芯，没有接话。'],
      final: true
    })
    const three = addChapter({
      id: 'ch_003',
      ord: 3,
      title: '第三章 旧账',
      status: 'draft_complete',
      covered: 24,
      seqs: [21, 22, 23, 24],
      lines: CH3_LINES,
      final: false
    })
    const twenty = addChapter({
      id: 'ch_020',
      ord: 20,
      title: '第二十章 夹层',
      // 合成夹具：保留 final revision（定稿检索用），但状态停在 draft_complete，
      // 这样同一章既能被审批，又能被 manuscript 检索到。
      status: 'draft_complete',
      covered: 92,
      seqs: [90, 91, 92],
      lines: ['他撬开供桌的夹层，账本躺在里面。', '夹层底下还有一张旧照片。', '雨停了。'],
      final: true
    })
    // 没写过正文的章：covered = 0，审批必须拒绝（M1-19）。
    addChapter({
      id: 'ch_007',
      ord: 7,
      title: '第七章 空稿',
      status: 'draft_complete',
      covered: 0,
      seqs: [],
      lines: [],
      final: false
    })

    repos.world.insert({
      id: 'wf_old',
      projectId: project.id,
      subject: '账本',
      predicate: '位置',
      object: '祠堂供桌下面',
      truth: 'objective',
      visibility: 'public',
      revealSeq: 1,
      validFromSeq: 1,
      // 第 90 序被新值（祠堂夹层）关掉：单值槽不能同时有两个活着的值。
      validToSeq: 90,
      sourceType: 'author'
    })
    repos.world.insert({
      id: 'wf_secret',
      projectId: project.id,
      subject: '林砚',
      predicate: '身份',
      object: '账房学徒',
      truth: 'objective',
      visibility: 'secret',
      knownByJson: JSON.stringify([lin.id]),
      validFromSeq: 1,
      sourceType: 'author'
    })
    repos.world.insert({
      id: 'wf_late_reveal',
      projectId: project.id,
      subject: '沈老太爷',
      predicate: '秘密',
      object: '早夭的名字',
      truth: 'objective',
      visibility: 'public',
      revealSeq: 92,
      validFromSeq: 1,
      sourceType: 'author'
    })
    repos.world.insert({
      id: 'wf_future',
      projectId: project.id,
      subject: '账本',
      predicate: '位置',
      object: '祠堂夹层',
      truth: 'objective',
      visibility: 'public',
      revealSeq: 90,
      validFromSeq: 90,
      sourceType: 'memory'
    })

    repos.belief.insert({
      projectId: project.id,
      characterId: lin.id,
      beliefText: '账本可能藏在祠堂',
      confidence: 0.6,
      learnedSeq: 22,
      sourceType: 'inference'
    })
    repos.relationship.insert({
      projectId: project.id,
      fromId: lin.id,
      toId: shen.id,
      axis: 'trust',
      value: 0.5,
      sinceSeq: 21,
      sourceType: 'event'
    })

    // 合成世界里 beat 的 seq 是手工给的，把 project.seq_head 推到同一水位。
    // 生产里由 allocateSeq 在写事务内递增；少了这一步 as_of 会被 clamp 到 0。
    for (let index = 0; index < 92; index += 1) allocateSeq(handle.db, project.id)

    const memories = [
      repos.memory.insert({
        projectId: project.id,
        characterId: lin.id,
        kind: 'experience',
        text: '在祠堂夜谈里试探匣子的下落',
        learnedSeq: 21,
        sourceChapterId: 'ch_001',
        sourceRevisionId: 'rev_ch_001',
        importance: 0.7,
        embeddingModel: 'hash-bigram-v1'
      })
    ]

    return {
      projectId: project.id,
      chapterOne: 'ch_001',
      chapterThree: 'ch_003',
      chapterTwenty: 'ch_020',
      chapterEmpty: 'ch_007',
      beats: { one, three, twenty },
      memories
    }
  })

  return {
    dir,
    handle,
    ...built,
    cleanup: () => {
      handle.db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

function newWorld(): AsofWorld {
  const world = buildWorld()
  worlds.push(world)
  return world
}

function worldService(world: AsofWorld): WorldService {
  return new WorldService({
    host: () => ({ db: world.handle.db, repos: world.handle.repos, readOnly: false })
  })
}

function adapterFor(server: FakeLlmServer) {
  return createOpenAiCompatAdapter(
    { provider: 'deepseek', baseUrl: server.baseUrl, model: 'deepseek-flash' },
    { retry: { sleep: async () => undefined, jitter: () => 0 }, totalTimeoutMs: 5_000, firstTokenTimeoutMs: 5_000 }
  )
}

describe('世界状态 as-of 投影（第 3 章 vs 第 20 章）', () => {
  it('两个 as-of 返回不同事实；事实与信念分节；未来事实与读者未知分开计数', () => {
    const world = newWorld()
    const service = worldService(world)

    const early = service.projection({ chapterId: world.chapterThree })
    expect(early.asOf).toBe(24)
    expect(early.coverage).toBe(24)
    expect(early.facts.map((fact) => fact.id).sort()).toEqual(['wf_late_reveal', 'wf_old', 'wf_secret'])
    expect(early.counts.futureFacts).toBe(1) // wf_future
    expect(early.counts.readerKnown).toBe(1) // wf_old
    expect(early.beliefs).toHaveLength(1)
    expect(early.edges).toHaveLength(1)
    expect(early.facts.find((fact) => fact.id === 'wf_late_reveal')!.pendingReveal).toBe(true)

    const late = service.projection({ chapterId: world.chapterTwenty })
    expect(late.asOf).toBe(92)
    // wf_old 在第 90 序被 wf_future 关掉：单值槽只留新值。
    expect(late.facts.map((fact) => fact.id).sort()).toEqual(['wf_future', 'wf_late_reveal', 'wf_secret'])
    expect(late.counts.futureFacts).toBe(0)
    expect(late.counts.readerKnown).toBe(2) // late_reveal / future；secret 不算

    // 第 1 章水位：wf_future 还不存在；wf_old 仍有效。
    const first = service.projection({ asOf: 2 })
    expect(first.facts.map((fact) => fact.id).sort()).toEqual(['wf_late_reveal', 'wf_old', 'wf_secret'])
    expect(first.counts.futureFacts).toBe(1)
  })
})

describe('审批的 as-of 边界（M1-19）', () => {
  it('第 3 章审批：工具结果没有第 20 章新事实，但保留「读者未知」的旧事实', async () => {
    const world = newWorld()
    const server = await startFakeLlm((body, index) => {
      const text = body.messages.map((message) => message.content).join('\n')
      const beatId = /\[(bt_[A-Za-z0-9_-]+)\]/.exec(text)?.[1] ?? ''
      if (index === 0) {
        return {
          reasoning: '先看客观事实，再判断是否越界。',
          toolCalls: [{ id: 'call_world', name: 'world.get_objective', args: {} }],
          usage: { in: 600, out: 20 }
        }
      }
      if (index === 1) {
        const report = {
          verdict: 'pass_with_notes',
          blocking: [],
          suggestions: beatId
            ? [
                {
                  issue_id: 'iss_01',
                  type: 'prose',
                  beat_id: beatId,
                  evidence: '',
                  why: '这一拍节奏偏慢',
                  suggestion: '删一句过渡'
                }
              ]
            : [],
          dimensions: { character_consistency: 4, plot_logic: 4, outline_alignment: 4, prose: 3 }
        }
        return {
          toolCalls: [{ id: 'call_report', name: 'report.submit', args: { report } }],
          usage: { in: 900, out: 60 }
        }
      }
      return {
        text: JSON.stringify({
          verdict: 'pass_with_notes',
          blocking: [],
          suggestions: [],
          dimensions: { character_consistency: 4, plot_logic: 4, outline_alignment: 4, prose: 3 }
        }),
        usage: { in: 1_100, out: 40 }
      }
    })
    servers.push(server)

    const outcome = await runReviewTurn(
      {
        db: world.handle.db,
        repos: world.handle.repos,
        registry,
        adapter: adapterFor(server),
        gateSecret: GATE_SECRET
      },
      { chapterId: world.chapterThree, messageId: 'msg_asof', mode: 'report' }
    )
    expect(outcome.reportId).not.toBeNull()

    // 工具结果（第 2 次请求里的 tool 消息）落在第 3 章水位上。
    const toolTurn = server.requests[1]!.messages.filter((message) => message.role === 'tool')
    expect(toolTurn).toHaveLength(1)
    const toolText = toolTurn[0]!.content
    expect(toolText).toContain('"as_of":24')
    expect(toolText).toContain('早夭的名字') // 旧事实：审批审计看得到
    expect(toolText).not.toContain('祠堂夹层') // 第 20 章才产生的事实：看不到
    expect(toolText).not.toContain('账本 位置 祠堂夹层')

    // 报告里引用的证据全部 ≤ 第 3 章水位。
    const reportRecord = world.handle.repos.review.getReport(outcome.reportId!)!
    const report = JSON.parse(reportRecord.blockingJson) as ReviewReport['blocking']
    for (const issue of report) {
      const beat = world.handle.repos.beat.get(issue.beat_id)
      if (!beat) continue
      expect(beat.chapterId).toBe(world.chapterThree)
      expect(beat.seq ?? 0).toBeLessThanOrEqual(24)
    }
  })

  it('第 20 章审批：能看到自己章节产生的事实', async () => {
    const world = newWorld()
    const server = await startFakeLlm((_body, index) => {
      if (index === 0) {
        return { toolCalls: [{ id: 'call_world', name: 'world.get_objective', args: {} }] }
      }
      return {
        text: JSON.stringify({
          verdict: 'pass',
          blocking: [],
          suggestions: [],
          dimensions: { character_consistency: 4, plot_logic: 4, outline_alignment: 4, prose: 4 }
        })
      }
    })
    servers.push(server)

    await runReviewTurn(
      {
        db: world.handle.db,
        repos: world.handle.repos,
        registry,
        adapter: adapterFor(server),
        gateSecret: GATE_SECRET
      },
      { chapterId: world.chapterTwenty, messageId: 'msg_asof_20', mode: 'report' }
    )

    const toolText = server.requests[1]!.messages.find((message) => message.role === 'tool')!.content
    expect(toolText).toContain('"as_of":92')
    expect(toolText).toContain('祠堂夹层')
  })

  it('没写过正文的章（covered=0）拒绝复审：invalid_args，不 fallback seq_head', async () => {
    const world = newWorld()
    const server = await startFakeLlm(() => ({ text: '{}' }))
    servers.push(server)
    let error: unknown = null
    try {
      await runReviewTurn(
        {
          db: world.handle.db,
          repos: world.handle.repos,
          registry,
          adapter: adapterFor(server),
          gateSecret: GATE_SECRET
        },
        { chapterId: world.chapterEmpty, messageId: 'msg_empty', mode: 'report' }
      )
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('invalid_args')
    expect(server.requests).toHaveLength(0)
  })
})

describe('定稿检索与作者事实的 as-of 边界', () => {
  it('manuscript 在第 3 章只返回 ch1；显式请求第 20 章被拒绝', async () => {
    const world = newWorld()
    const tool = ALL_MANIFESTS.find((item) => item.name === 'manuscript.search_final')!
    const result = await tool.handler(
      { query: '匣子' },
      {
        runtime: { project_id: world.projectId, as_of: 24, actor_id: 'reviewer' },
        chapterId: world.chapterThree
      } as never,
      { repos: world.handle.repos } as never
    )
    const data = result.data as { hit_count: number; items: Array<{ chapter_id: string }> }
    expect(data.hit_count).toBeGreaterThan(0)
    expect(data.items.every((item) => item.chapter_id === world.chapterOne)).toBe(true)

    expect(() =>
      tool.handler(
        { query: '夹层', chapter_id: world.chapterTwenty },
        {
          runtime: { project_id: world.projectId, as_of: 24, actor_id: 'reviewer' },
          chapterId: world.chapterThree
        } as never,
        { repos: world.handle.repos } as never
      )
    ).toThrowError(/本章之后/)
  })

  it('作者新增事实：写 source_type=author，按 as_of 生效，关闭后仍可回放', () => {
    const world = newWorld()
    const service = worldService(world)

    const added = service.addFact({
      chapterId: world.chapterThree,
      asOf: 24,
      subject: '账本',
      predicate: '页数',
      object: '三十七页',
      truth: 'objective',
      visibility: 'public',
      revealSeq: 24
    })
    // 新增发生在 seq_head=92，所以第 3 章水位（24）看不到。
    const early = service.projection({ chapterId: world.chapterThree })
    expect(early.facts.some((fact) => fact.id === added.factId)).toBe(false)

    const now = service.projection({ chapterId: world.chapterTwenty })
    expect(now.facts.find((fact) => fact.id === added.factId)?.sourceType).toBe('author')

    const audits = world.handle.repos.memoryAudit
      .listByEntity(added.factId)
      .filter((row) => row.action === 'apply' && row.actor === 'author')
    expect(audits).toHaveLength(1)
    expect(world.handle.repos.world.get(added.factId)!.sourceType).toBe('author')

    const closed = service.closeFact({ chapterId: world.chapterTwenty, factId: added.factId })
    expect(closed.projection.facts.some((fact) => fact.id === added.factId)).toBe(false)
  })
})
