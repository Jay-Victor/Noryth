import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from '../../../src/main/db/project-db'
import type { Repos } from '../../../src/main/db/repos'
import { LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { withTransaction } from '../../../src/main/db/tx'
import { hashManifestRows } from '../../../src/main/db/hash'
import type { ManifestBeatRow } from '../../../src/main/db/revision'
import { openTestDb, closeTestDb } from '../../unit/db/support/db'

/**
 * 契约测试的合成项目：一个草稿章 + 一个定稿章，足够覆盖 36 个工具。
 * 数据全部是测试文案，不含真实作品内容。
 */

export interface ContractWorld {
  db: Db
  repos: Repos
  dir: string
  projectId: string
  chapterDraftId: string
  chapterFinalId: string
  revisionDraftId: string
  revisionFinalId: string
  sceneId: string
  beatDraftId: string
  beatFinalId: string
  beatDraftBody: string
  characterLin: string
  characterShen: string
  memoryLinId: string
  memoryShenId: string
  proposalJobId: string
  proposalItemAcceptId: string
  proposalItemRejectId: string
  cleanup: () => void
}

export function openContractWorld(): ContractWorld {
  const dir = mkdtempSync(join(tmpdir(), 'noryth-contract-'))
  mkdirSync(dir, { recursive: true })
  const handle = openTestDb(dir)
  const { db, repos } = handle

  const ids = withTransaction(db, () => {
    const project = repos.project.create({
      id: 'prj_contract',
      title: '契约测试项目',
      genre: '悬疑',
      pov: 'third_limited',
      targetWords: 120000,
      embeddingModel: 'bge-small-zh-v1.5',
      embeddingDim: 512,
      defaultPreset: 'deepseek',
      schemaVersion: LATEST_SCHEMA_VERSION
    })

    for (const character of [
      { id: 'chr_lin', name: '林砚', card: { role: '主角', want: '查清真相', fear: '成为共犯', voice: '短句' } },
      { id: 'chr_shen', name: '沈青梧', card: { role: '女主', want: '守住祠堂', fear: '被逐出族谱', voice: '客气' } }
    ]) {
      repos.character.insert({
        id: character.id,
        projectId: project.id,
        name: character.name,
        cardJson: JSON.stringify(character.card)
      })
    }

    const main = repos.outline.insert({
      id: 'out_main',
      projectId: project.id,
      parentId: null,
      kind: 'main',
      ord: 0,
      title: '主线：黑漆匣子',
      content: '黑漆匣子藏在祠堂供桌下面，与林家的旧账有关。',
      status: 'approved'
    })
    const nodeDraft = repos.outline.insert({
      id: 'out_ch_draft',
      projectId: project.id,
      parentId: main.id,
      kind: 'chapter',
      ord: 1,
      title: '第一章 祠堂夜谈',
      content: '确认黑漆匣子的下落。',
      status: 'draft'
    })
    const nodeFinal = repos.outline.insert({
      id: 'out_ch_final',
      projectId: project.id,
      parentId: main.id,
      kind: 'chapter',
      ord: 2,
      title: '第二章 旧账最后一页',
      content: '从穆掌柜手里拿到旧账。',
      status: 'approved'
    })

    repos.chapter.insert({
      id: 'ch_draft',
      projectId: project.id,
      outlineNodeId: nodeDraft.id,
      ord: 1,
      status: 'drafting',
      coveredUntilSeq: 2,
      currentRevisionId: null
    })
    repos.chapter.insert({
      id: 'ch_final',
      projectId: project.id,
      outlineNodeId: nodeFinal.id,
      ord: 2,
      status: 'finalized',
      coveredUntilSeq: 3,
      currentRevisionId: 'rev_final',
      finalRevisionId: 'rev_final',
      finalizedAt: '2026-01-01T00:00:00.000Z'
    })

    repos.scene.insert({
      id: 'scn_a',
      projectId: project.id,
      ord: 1,
      location: '沈家祠堂',
      participantsJson: JSON.stringify(['chr_lin', 'chr_shen']),
      goal: '确认黑漆匣子的下落',
      entry: '雨夜，祠堂只剩一盏灯',
      exitJson: JSON.stringify({ resolved: false, hook: '匣子底部刻着林家的记号' }),
      status: 'open'
    })
    repos.scene.linkToChapter('ch_draft', 'scn_a', 1)

    repos.scene.insert({
      id: 'scn_final',
      projectId: project.id,
      ord: 2,
      location: '沈家祠堂',
      participantsJson: JSON.stringify(['chr_lin']),
      goal: '把匣子放回原处',
      entry: '夜深，祠堂无人',
      exitJson: JSON.stringify({ resolved: true, hook: null }),
      status: 'closed'
    })
    repos.scene.linkToChapter('ch_final', 'scn_final', 1)

    const beatDraftBody = '「见过。匣子不在书房，在祠堂的供桌下面。」'
    const manifest: ManifestBeatRow[] = [
      {
        beatId: 'bt_a',
        sceneId: 'scn_a',
        sceneOrd: 1,
        beatOrd: 1,
        speakerType: 'narrator',
        speakerId: 'narrator',
        body: '她把茶盏往他那边推了推，窗外的雨还没有停。'
      },
      {
        beatId: 'bt_b',
        sceneId: 'scn_a',
        sceneOrd: 1,
        beatOrd: 2,
        speakerType: 'character',
        speakerId: 'chr_lin',
        body: beatDraftBody
      }
    ]

    repos.revision.insert({
      id: 'rev_draft',
      chapterId: 'ch_draft',
      parentRevisionId: null,
      kind: 'draft',
      contentHash: hashManifestRows(manifest),
      createdBy: 'author'
    })
    const finalManifest: ManifestBeatRow[] = [
      {
        beatId: 'bt_final',
        sceneId: 'scn_final',
        sceneOrd: 1,
        beatOrd: 1,
        speakerType: 'character',
        speakerId: 'chr_lin',
        body: '她把匣子放回供桌下面，没有点灯。'
      }
    ]
    repos.revision.insert({
      id: 'rev_final',
      chapterId: 'ch_final',
      parentRevisionId: null,
      kind: 'final',
      contentHash: hashManifestRows(finalManifest),
      createdBy: 'author'
    })

    repos.beat.insert({
      id: 'bt_a',
      chapterId: 'ch_draft',
      sceneId: 'scn_a',
      ord: 1,
      seq: 1,
      speakerType: 'narrator',
      speakerId: 'narrator',
      body: '她把茶盏往他那边推了推，窗外的雨还没有停。',
      status: 'draft',
      createdRevisionId: 'rev_draft'
    })
    repos.beat.insert({
      id: 'bt_b',
      chapterId: 'ch_draft',
      sceneId: 'scn_a',
      ord: 2,
      seq: 2,
      speakerType: 'character',
      speakerId: 'chr_lin',
      intent: '试探匣子的下落',
      body: beatDraftBody,
      groundingJson: JSON.stringify([
        { type: 'memory', id: 'mem_lin_1', quote: '父亲书房有一只上锁的黑漆匣子' }
      ]),
      status: 'draft',
      createdRevisionId: 'rev_draft',
      maxWords: 120,
      wordCount: [...beatDraftBody].length
    })
    repos.beat.insert({
      id: 'bt_final',
      chapterId: 'ch_final',
      sceneId: 'scn_final',
      ord: 1,
      seq: 3,
      speakerType: 'character',
      speakerId: 'chr_lin',
      body: '她把匣子放回供桌下面，没有点灯。',
      status: 'confirmed',
      createdRevisionId: 'rev_final',
      wordCount: 16
    })

    repos.revision.insertMembers('rev_draft', [
      { revisionId: 'rev_draft', beatId: 'bt_a', sceneOrd: 1, beatOrd: 1 },
      { revisionId: 'rev_draft', beatId: 'bt_b', sceneOrd: 1, beatOrd: 2 }
    ])
    repos.revision.insertMembers('rev_final', [
      { revisionId: 'rev_final', beatId: 'bt_final', sceneOrd: 1, beatOrd: 1 }
    ])
    repos.chapter.setCurrentRevision('ch_draft', 'rev_draft')

    for (const memory of [
      {
        id: 'mem_lin_1',
        characterId: 'chr_lin',
        kind: 'experience' as const,
        text: '父亲书房有一只上锁的黑漆匣子',
        learnedSeq: 1,
        importance: 0.9
      },
      {
        id: 'mem_lin_2',
        characterId: 'chr_lin',
        kind: 'cognition' as const,
        text: '她记得母亲的玉镯在祠堂',
        learnedSeq: 2,
        importance: 0.4
      },
      {
        id: 'mem_shen_1',
        characterId: 'chr_shen',
        kind: 'fact' as const,
        text: '祠堂的钥匙在老太爷手里',
        learnedSeq: 2,
        importance: 0.7
      }
    ]) {
      repos.memory.insert({
        projectId: project.id,
        characterId: memory.characterId,
        kind: memory.kind,
        text: memory.text,
        learnedSeq: memory.learnedSeq,
        sourceChapterId: 'ch_draft',
        sourceRevisionId: 'rev_draft',
        importance: memory.importance,
        embeddingModel: 'bge-small-zh-v1.5'
      })
    }

    repos.world.insert({
      id: 'wf_public',
      projectId: project.id,
      subject: '黑漆匣子',
      predicate: '位置',
      object: '祠堂供桌下面',
      truth: 'objective',
      visibility: 'public',
      revealSeq: 1,
      validFromSeq: 1,
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
      knownByJson: JSON.stringify(['chr_lin']),
      validFromSeq: 1,
      sourceType: 'author'
    })
    repos.world.insert({
      id: 'wf_hidden',
      projectId: project.id,
      subject: '沈老太爷',
      predicate: '秘密',
      object: '早夭的名字',
      truth: 'objective',
      visibility: 'public',
      revealSeq: 99,
      validFromSeq: 1,
      sourceType: 'author'
    })

    repos.belief.insert({
      projectId: project.id,
      characterId: 'chr_lin',
      beliefText: '账本可能藏在祠堂',
      confidence: 0.6,
      learnedSeq: 2,
      sourceType: 'inference'
    })

    repos.relationship.insert({
      projectId: project.id,
      fromId: 'chr_lin',
      toId: 'chr_shen',
      axis: 'trust',
      value: 0.6,
      sinceSeq: 1,
      sourceType: 'event'
    })
    repos.relationship.insert({
      projectId: project.id,
      fromId: 'chr_shen',
      toId: 'chr_lin',
      axis: 'tension',
      value: 0.4,
      sinceSeq: 2,
      sourceType: 'event'
    })

    repos.review.insertReport({
      projectId: project.id,
      chapterId: 'ch_final',
      revisionId: 'rev_final',
      round: 1,
      verdict: 'pass',
      blockingJson: '[]',
      suggestionsJson: '[]'
    })

    repos.memoryProposal.insert({
      id: 'mpi_accept',
      projectId: project.id,
      jobId: 'job_prop',
      kind: 'experience',
      characterId: 'chr_lin',
      text: '她确认匣子在祠堂供桌下面',
      sourceChapterId: 'ch_final',
      sourceRevisionId: 'rev_final',
      sourceBeatId: 'bt_final',
      importance: 0.8
    })
    repos.memoryProposal.insert({
      id: 'mpi_reject',
      projectId: project.id,
      jobId: 'job_prop',
      kind: 'world_fact',
      text: '匣子是林家的',
      payloadJson: JSON.stringify({
        subject: '黑漆匣子',
        predicate: '归属',
        object: '林家',
        truth: 'objective',
        visibility: 'secret',
        single_value: 1
      }),
      sourceChapterId: 'ch_final',
      sourceRevisionId: 'rev_final',
      sourceBeatId: 'bt_final'
    })

    return { beatDraftBody }
  })

  return {
    db,
    repos,
    dir,
    projectId: 'prj_contract',
    chapterDraftId: 'ch_draft',
    chapterFinalId: 'ch_final',
    revisionDraftId: 'rev_draft',
    revisionFinalId: 'rev_final',
    sceneId: 'scn_a',
    beatDraftId: 'bt_b',
    beatFinalId: 'bt_final',
    beatDraftBody: ids.beatDraftBody,
    characterLin: 'chr_lin',
    characterShen: 'chr_shen',
    memoryLinId: 'mem_lin_1',
    memoryShenId: 'mem_shen_1',
    proposalJobId: 'job_prop',
    proposalItemAcceptId: 'mpi_accept',
    proposalItemRejectId: 'mpi_reject',
    cleanup: () => {
      closeTestDb(handle)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
