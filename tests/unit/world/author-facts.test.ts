import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import { allocateSeq } from '../../../src/main/db/seq'
import { withTransaction } from '../../../src/main/db/tx'
import { applyAuthorFact, closeAuthorFact } from '../../../src/main/memory/apply'
import {
  AUTHOR_FACT_LIMITS,
  buildAuthorFactCloseInput,
  buildAuthorFactInput,
  singleValueFor
} from '../../../src/main/world/author-facts'
import { WorldService } from '../../../src/main/world/service'
import { openContractWorld, type ContractWorld } from '../../contract/support/world'

/**
 * 作者世界事实（PHASE-13 M1-18）：
 * - 参数组装/校验在 world/author-facts；写库只在 memory/apply；
 * - `source_type='author'` + `memory_audit(actor='author')`；
 * - 单值槽新值先关旧值，多值谓词并存；
 * - 关闭事实只写 valid_to_seq，不物理删除。
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

function bump(world: ContractWorld, times = 1): number {
  let last = 0
  withTransaction(world.db, () => {
    for (let index = 0; index < times; index += 1) last = allocateSeq(world.db, world.projectId)
  })
  return last
}

function serviceFor(world: ContractWorld): WorldService {
  return new WorldService({
    host: () => ({ db: world.db, repos: world.repos, readOnly: false })
  })
}

const characterIds = new Set(['chr_lin', 'chr_shen'])

describe('作者事实：参数组装与校验', () => {
  it('单值 / 多值谓词由登记表决定，调用方不能传 single_value', () => {
    expect(singleValueFor('位置')).toBe(1)
    expect(singleValueFor('身份')).toBe(1)
    expect(singleValueFor('喜欢')).toBe(0)
    expect(singleValueFor('认识')).toBe(0)

    const built = buildAuthorFactInput(
      { subject: ' 账本 ', predicate: '位置', object: '祠堂', truth: 'objective', visibility: 'public' },
      { projectId: 'prj', seqHead: 7, characterIds }
    )
    expect(built.subject).toBe('账本')
    expect(built.singleValue).toBe(1)
    expect(built.validFromSeq).toBe(7)
    expect(built.revealSeq).toBeNull()
    expect(built.knownByJson).toBe('[]')
  })

  it('空字段 / 超长 / 未知知情者 / 越界序都被拒绝', () => {
    const base = { subject: '账本', predicate: '位置', object: '祠堂', truth: 'objective' as const, visibility: 'public' as const }
    const ctx = { projectId: 'prj', seqHead: 3, characterIds }
    expect(() => buildAuthorFactInput({ ...base, subject: '   ' }, ctx)).toThrowError(AppError)
    expect(() =>
      buildAuthorFactInput({ ...base, object: 'x'.repeat(AUTHOR_FACT_LIMITS.object + 1) }, ctx)
    ).toThrowError(/宾语/)
    expect(() =>
      buildAuthorFactInput({ ...base, knownBy: ['chr_missing'] }, ctx)
    ).toThrowError(/知情者/)
    expect(() => buildAuthorFactInput({ ...base, validFromSeq: 4 }, ctx)).toThrowError(/valid_from_seq/)
    expect(() => buildAuthorFactInput({ ...base, revealSeq: 9 }, ctx)).toThrowError(/reveal_seq/)
    expect(() =>
      buildAuthorFactInput({ ...base, visibility: 'secret', revealSeq: 3, validFromSeq: 3 }, ctx)
    ).toThrowError(/揭示序/)
  })

  it('关闭事实：已关闭的返回 alreadyClosed，关闭序不早于生效序', () => {
    const built = buildAuthorFactCloseInput(
      { factId: 'wf_1', reason: '写错了' },
      {
        projectId: 'prj',
        seqHead: 4,
        fact: { id: 'wf_1', projectId: 'prj', validFromSeq: 9, validToSeq: null }
      }
    )
    expect(built.input.seq).toBe(9)
    expect(built.alreadyClosed).toBe(false)
    expect(() =>
      buildAuthorFactCloseInput({ factId: 'wf_x' }, { projectId: 'prj', seqHead: 1, fact: null })
    ).toThrowError(/不存在/)
  })
})

describe('作者事实：写入与审计（单一写入者）', () => {
  it('新增 objective 事实：source_type=author，审计 actor=author，单值槽关闭旧值', () => {
    const world = setup()
    const seq1 = bump(world)
    const first = applyAuthorFact(world.db, world.repos, {
      projectId: world.projectId,
      subject: '账本',
      predicate: '位置',
      object: '祠堂',
      truth: 'objective',
      visibility: 'public',
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: seq1,
      singleValue: 1
    })
    expect(first.duplicate).toBe(false)
    expect(world.repos.world.get(first.factId)!.sourceType).toBe('author')

    const audits = world.repos.memoryAudit.listByEntity(first.factId)
    expect(audits.some((row) => row.action === 'apply' && row.actor === 'author')).toBe(true)

    const seq2 = bump(world)
    const second = applyAuthorFact(world.db, world.repos, {
      projectId: world.projectId,
      subject: '账本',
      predicate: '位置',
      object: '夹层',
      truth: 'objective',
      visibility: 'public',
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: seq2,
      singleValue: 1
    })
    // 旧值关闭在新值的生效序，不物理删除。
    const old = world.repos.world.get(first.factId)!
    expect(old.validToSeq).toBe(seq2)
    expect(second.superseded).toEqual([first.factId])
    expect(world.repos.memoryAudit.listByEntity(old.id).some((row) => row.action === 'supersede')).toBe(true)
    // 同一 (subject, predicate) 只有一条活着的单值事实。
    expect(world.repos.world.currentSingleValue('账本', '位置')!.id).toBe(second.factId)

    // 重复写同一三元组：不新增行，标记 duplicate。
    const seq3 = bump(world)
    const again = applyAuthorFact(world.db, world.repos, {
      projectId: world.projectId,
      subject: '账本',
      predicate: '位置',
      object: '夹层',
      truth: 'objective',
      visibility: 'public',
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: seq3,
      singleValue: 1
    })
    expect(again.duplicate).toBe(true)
    expect(again.factId).toBe(second.factId)
  })

  it('多值谓词并存；回填早于当前值的单值新增被拒绝', () => {
    const world = setup()
    const seq1 = bump(world)
    const like1 = applyAuthorFact(world.db, world.repos, {
      projectId: world.projectId,
      subject: '林砚',
      predicate: '喜欢',
      object: '摄影',
      truth: 'objective',
      visibility: 'public',
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: seq1,
      singleValue: 0
    })
    const seq2 = bump(world)
    applyAuthorFact(world.db, world.repos, {
      projectId: world.projectId,
      subject: '林砚',
      predicate: '喜欢',
      object: '篆刻',
      truth: 'objective',
      visibility: 'public',
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: seq2,
      singleValue: 0
    })
    expect(world.repos.world.get(like1.factId)!.validToSeq).toBeNull()

    const slot = applyAuthorFact(world.db, world.repos, {
      projectId: world.projectId,
      subject: '沈青梧',
      predicate: '身份',
      object: '族长',
      truth: 'objective',
      visibility: 'public',
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: seq2,
      singleValue: 1
    })
    expect(() =>
      applyAuthorFact(world.db, world.repos, {
        projectId: world.projectId,
        subject: '沈青梧',
        predicate: '身份',
        object: '账房',
        truth: 'objective',
        visibility: 'public',
        knownByJson: '[]',
        revealSeq: null,
        validFromSeq: seq1,
        singleValue: 1
      })
    ).toThrowError(/生效序/)
    expect(world.repos.world.get(slot.factId)!.validToSeq).toBeNull()
  })

  it('唯一索引兜底：同一单值槽不能有两条活着的 objective 事实', () => {
    const world = setup()
    const base = {
      projectId: world.projectId,
      subject: '账本',
      predicate: '位置',
      object: '祠堂',
      singleValue: 1,
      truth: 'objective' as const,
      visibility: 'public' as const,
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: 0,
      sourceType: 'author' as const
    }
    world.repos.world.insert(base)
    // 绕过 applyAuthorFact 直接插第二条：数据库必须拒绝（world_single_value）。
    expect(() => world.repos.world.insert({ ...base, object: '夹层' })).toThrowError(/UNIQUE/i)
  })

  it('关闭事实：valid_to_seq 落盘 + invalidate 审计；重复关闭是 no-op', () => {
    const world = setup()
    const seq = bump(world)
    const added = applyAuthorFact(world.db, world.repos, {
      projectId: world.projectId,
      subject: '账本',
      predicate: '位置',
      object: '祠堂',
      truth: 'objective',
      visibility: 'public',
      knownByJson: '[]',
      revealSeq: null,
      validFromSeq: seq,
      singleValue: 1
    })
    const closed = closeAuthorFact(world.repos, {
      projectId: world.projectId,
      factId: added.factId,
      seq: seq + 5,
      reason: '作者关闭事实'
    })
    expect(closed.duplicate).toBe(false)
    const record = world.repos.world.get(added.factId)!
    expect(record.validToSeq).toBe(seq + 5)
    expect(world.repos.memoryAudit.listByEntity(added.factId).some((row) => row.action === 'invalidate')).toBe(true)

    const again = closeAuthorFact(world.repos, {
      projectId: world.projectId,
      factId: added.factId,
      seq: seq + 9,
      reason: '重复'
    })
    expect(again.duplicate).toBe(true)
    expect(world.repos.world.get(added.factId)!.validToSeq).toBe(seq + 5)
  })
})

describe('WorldService：投影 + 作者编辑器', () => {
  it('作者新增事实后投影按 as_of 过滤；读者已知只认 reveal_seq', () => {
    const world = setup()
    const service = serviceFor(world)
    bump(world, 8)
    const seq = 5

    const before = service.projection({ chapterId: world.chapterDraftId })
    expect(before.asOf).toBe(2) // ch_draft.covered_until_seq
    expect(before.counts.readerKnown).toBeGreaterThan(0)

    // 第 5 序才产生、第 5 序揭示：旧水位看不到，新水位看得到。
    const added = service.addFact({
      chapterId: world.chapterDraftId,
      asOf: 2,
      subject: '账本',
      predicate: '位置',
      object: '祠堂夹层',
      truth: 'objective',
      visibility: 'public',
      revealSeq: seq,
      validFromSeq: seq
    })
    expect(added.factId.length).toBeGreaterThan(0)
    expect(added.projection.asOf).toBe(2)
    expect(added.projection.facts.some((fact) => fact.id === added.factId)).toBe(false)
    expect(added.projection.counts.futureFacts).toBeGreaterThan(0)

    const later = service.projection({ chapterId: world.chapterDraftId, asOf: seq })
    const shown = later.facts.find((fact) => fact.id === added.factId)!
    expect(shown.readerKnown).toBe(true)
    expect(shown.sourceType).toBe('author')

    // 关闭序 = 当前水位 8：从 8 起不再有效，但仍可回放到关闭前。
    const closed = service.closeFact({ chapterId: world.chapterDraftId, factId: added.factId, asOf: 8 })
    expect(closed.projection.facts.some((fact) => fact.id === added.factId)).toBe(false)
    const replay = service.projection({ asOf: seq })
    expect(replay.facts.some((fact) => fact.id === added.factId)).toBe(true)
  })

  it('只读项目拒绝写入；未知章按 invalid_args', () => {
    const world = setup()
    const readOnly = new WorldService({
      host: () => ({ db: world.db, repos: world.repos, readOnly: true })
    })
    expect(() =>
      readOnly.addFact({
        subject: '账本',
        predicate: '位置',
        object: '祠堂',
        truth: 'objective',
        visibility: 'public'
      })
    ).toThrowError(/只读/)
    const service = serviceFor(world)
    expect(() => service.projection({ chapterId: 'ch_missing' })).toThrowError(/本章不存在/)
  })
})
