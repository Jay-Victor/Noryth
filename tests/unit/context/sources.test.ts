import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectContext } from '../../../src/main/context/sources'
import { openContractWorld, type ContractWorld } from '../../contract/support/world'

describe('上下文取材的可见性（PRD §8.1–8.3）', () => {
  let world: ContractWorld

  beforeAll(() => {
    world = openContractWorld()
  })
  afterAll(() => {
    world?.cleanup()
  })

  function collect(
    agent: 'character:chr_lin' | 'character:chr_shen' | 'narrator',
    beatId = world.beatDraftId
  ) {
    return collectContext(world.repos, {
      projectId: world.projectId,
      chapterId: world.chapterDraftId,
      beatId,
      agent,
      contextWindow: 64_000
    })
  }

  function narratorBeatId(): string {
    const beat = world.repos.beat
      .listByChapter(world.chapterDraftId)
      .find((item) => item.speakerType === 'narrator')
    if (!beat) throw new Error('fixture 缺少旁白拍')
    return beat.id
  }

  let shenBeat: string | null = null
  function shenBeatId(): string {
    if (shenBeat === null) {
      const beat = world.repos.beat.insert({
        chapterId: world.chapterDraftId,
        sceneId: world.sceneId,
        ord: 3,
        speakerType: 'character',
        speakerId: world.characterShen,
        intent: '问匣子的下落',
        status: 'draft',
        createdRevisionId: world.revisionDraftId,
        maxWords: 120
      })
      shenBeat = beat.id
    }
    return shenBeat
  }

  it('角色只拿自己的记忆、本人信念与限知世界状态', () => {
    world.repos.scene.update(world.sceneId, { goal: '确认黑漆匣子在祠堂的下落' })
    const knownSecret = world.repos.world.insert({
      id: 'wf_known_lin',
      projectId: world.projectId,
      subject: '黑漆匣子',
      predicate: '钥匙',
      object: '在林砚手里',
      truth: 'objective',
      visibility: 'secret',
      knownByJson: JSON.stringify([world.characterLin]),
      validFromSeq: 1,
      sourceType: 'author'
    })
    const belief = world.repos.belief.insert({
      projectId: world.projectId,
      characterId: world.characterLin,
      beliefText: '匣子可能藏在供桌下面',
      confidence: 0.7,
      learnedSeq: 2,
      sourceType: 'inference'
    })
    const lin = collect('character:chr_lin')
    const linMemory = lin.input.retrieved.filter((item) => item.refType === 'memory')
    const linFacts = lin.input.retrieved.filter((item) => item.refType === 'fact')
    const linBeliefs = lin.input.retrieved.filter((item) => item.refType === 'belief')

    expect(linMemory.every((item) => item.text.includes('匣子') || item.text.includes('玉镯'))).toBe(true)
    expect(linMemory.some((item) => item.text.includes('祠堂的钥匙在老太爷手里'))).toBe(false)
    expect(linFacts.map((item) => item.id).sort()).toEqual([knownSecret.id, 'wf_public'].sort())
    expect(linBeliefs.map((item) => item.text)).toContain(belief.beliefText)

    const shen = collect('character:chr_shen', shenBeatId())
    const shenMemory = shen.input.retrieved.filter((item) => item.refType === 'memory')
    expect(shenMemory.map((item) => item.text)).toContain('祠堂的钥匙在老太爷手里')
    expect(shenMemory.some((item) => item.text.includes('黑漆匣子'))).toBe(false)
    const shenFacts = shen.input.retrieved.filter((item) => item.refType === 'fact').map((item) => item.id)
    expect(shenFacts).not.toContain('wf_secret')
    expect(shenFacts).not.toContain(knownSecret.id)
    expect(shen.input.retrieved.some((item) => item.refType === 'belief')).toBe(false)
  })

  it('agent 与分拍发言者不一致时拒绝装配，避免拿错人的记忆', () => {
    expect(() => collect('character:chr_shen', world.beatDraftId)).toThrowError(/发言者不一致/)
  })

  it('旁白只拿读者已知投影，不拿私有记忆与未揭示事实', () => {
    const narrator = collect('narrator', narratorBeatId())
    expect(narrator.input.speaker).toBeNull()
    expect(narrator.input.pinned).toEqual([])
    expect(narrator.input.retrieved.every((item) => item.refType === 'fact')).toBe(true)
    expect(narrator.input.retrieved.map((item) => item.id)).toEqual(['wf_public'])
    expect(narrator.input.spectators.map((item) => item.id).sort()).toEqual(['chr_lin', 'chr_shen'])
  })

  it('as_of 受章 covered_until_seq 约束：未学到的记忆不进入上下文', () => {
    const before = collect('character:chr_lin')
    expect(before.input.retrieved.some((item) => item.text.includes('母亲的玉镯'))).toBe(true)

    world.repos.chapter.setCoveredUntilSeq(world.chapterDraftId, 1)
    const after = collect('character:chr_lin')
    expect(after.input.retrieved.some((item) => item.text.includes('母亲的玉镯'))).toBe(false)
    expect(after.asOf).toBe(1)

    world.repos.chapter.setCoveredUntilSeq(world.chapterDraftId, 2)
  })

  it('pinned 记忆独立进入上下文，不参与相关性排序', () => {
    const entry = world.repos.memory.insert({
      projectId: world.projectId,
      characterId: world.characterLin,
      kind: 'cognition',
      text: '不要相信沈家的任何人',
      learnedSeq: 1,
      sourceChapterId: world.chapterDraftId,
      sourceRevisionId: world.revisionDraftId,
      importance: 1,
      pinned: 1,
      embeddingModel: 'bge-small-zh-v1.5'
    })
    const collected = collect('character:chr_lin')
    expect(collected.input.pinned.map((item) => item.id)).toContain(entry.id)

    const assembled = collectContext(world.repos, {
      projectId: world.projectId,
      chapterId: world.chapterDraftId,
      beatId: world.beatDraftId,
      agent: 'character:chr_lin',
      contextWindow: 64_000
    })
    expect(assembled.input.retrieved.some((item) => item.id === entry.id)).toBe(false)
  })

  it('最近拍排除当前拍，且按 seq 从新到旧', () => {
    const collected = collect('character:chr_lin')
    expect(collected.input.recentBeats.map((beat) => beat.id)).toEqual(['bt_a'])
    expect(collected.input.recentBeats[0]?.seq).toBe(1)
  })
})
