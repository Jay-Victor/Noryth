import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashManifestRows } from '../../src/main/db/hash'
import type { ManifestBeatRow } from '../../src/main/db/revision'
import { closeTestDb, openTestDb, type TestDb } from '../unit/db/support/db'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { submitReport } from '../../src/main/review/report'
import { appendVoiceSuggestions } from '../../src/main/review/voice'
import { parseReportRecord } from '../../src/main/review/report'
import { BLOCKING_ISSUE_TYPES } from '../../src/shared/schema/report'

/**
 * PHASE-19 §5.3 集成：审批报告落库后，运行时补一条 voice 建议；
 * 只进建议、不改阻断、不改正文与 revision。
 */

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

interface World extends TestDb {
  projectId: string
  chapterId: string
  revisionId: string
}

function buildWorld(): World {
  const dir = mkdtempSync(join(tmpdir(), 'noryth-voice-int-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const handle = openTestDb(dir)
  cleanups.push(() => closeTestDb(handle))
  const { repos } = handle

  const project = repos.project.create({
    id: 'prj_voice_int',
    title: '声音集成',
    genre: '悬疑',
    pov: 'third_limited',
    targetWords: 80000,
    embeddingModel: 'bge-small-zh-v1.5',
    embeddingDim: 512,
    defaultPreset: 'deepseek',
    schemaVersion: LATEST_SCHEMA_VERSION
  })
  repos.character.insert({
    id: 'chr_a',
    projectId: project.id,
    name: '沈昼',
    cardJson: JSON.stringify({ voice: { catchphrase: '罢了' } })
  })
  repos.character.insert({
    id: 'chr_b',
    projectId: project.id,
    name: '林晚',
    cardJson: JSON.stringify({ voice: { catchphrase: '罢了' } })
  })
  const main = repos.outline.insert({
    id: 'out_main',
    projectId: project.id,
    parentId: null,
    kind: 'main',
    ord: 0,
    title: '主线',
    content: '',
    status: 'approved'
  })
  const node = repos.outline.insert({
    id: 'out_ch',
    projectId: project.id,
    parentId: main.id,
    kind: 'chapter',
    ord: 1,
    title: '第一章',
    content: '',
    status: 'draft'
  })
  repos.chapter.insert({
    id: 'ch_1',
    projectId: project.id,
    outlineNodeId: node.id,
    ord: 1,
    status: 'under_review',
    coveredUntilSeq: 4,
    currentRevisionId: null
  })
  repos.scene.insert({
    id: 'scn_1',
    projectId: project.id,
    ord: 1,
    location: '祠堂',
    participantsJson: JSON.stringify(['chr_a', 'chr_b']),
    goal: '对质',
    exitJson: '{}',
    status: 'closed'
  })
  repos.scene.linkToChapter('ch_1', 'scn_1', 1)

  const rows: ManifestBeatRow[] = [
    {
      beatId: 'bt_1',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 1,
      speakerType: 'character',
      speakerId: 'chr_a',
      body: '灯灭了。雨停了。罢了，先回去。'
    },
    {
      beatId: 'bt_2',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 2,
      speakerType: 'character',
      speakerId: 'chr_b',
      body: '门没锁。灰上有脚印。罢了，先回去。'
    },
    {
      beatId: 'bt_3',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 3,
      speakerType: 'character',
      speakerId: 'chr_a',
      body: '有人来过。钥匙不在。'
    },
    {
      beatId: 'bt_4',
      sceneId: 'scn_1',
      sceneOrd: 1,
      beatOrd: 4,
      speakerType: 'character',
      speakerId: 'chr_b',
      body: '供桌下面有印子。别出声。'
    }
  ]
  repos.revision.insert({
    id: 'rev_1',
    chapterId: 'ch_1',
    parentRevisionId: null,
    kind: 'draft',
    contentHash: hashManifestRows(rows),
    createdBy: 'doc_controller'
  })
  rows.forEach((row, index) => {
    repos.beat.insert({
      id: row.beatId,
      chapterId: 'ch_1',
      sceneId: 'scn_1',
      ord: index + 1,
      seq: index + 1,
      speakerType: 'character',
      speakerId: row.speakerId,
      body: row.body,
      status: 'confirmed',
      createdRevisionId: 'rev_1'
    })
  })
  repos.revision.insertMembers(
    'rev_1',
    rows.map((row) => ({ revisionId: 'rev_1', beatId: row.beatId, sceneOrd: row.sceneOrd, beatOrd: row.beatOrd }))
  )
  repos.chapter.setCurrentRevision('ch_1', 'rev_1')
  return { ...handle, projectId: project.id, chapterId: 'ch_1', revisionId: 'rev_1' }
}

describe('审批报告 + 声音建议', () => {
  it('pass 报告追加 voice 建议后变 pass_with_notes；重复调用不叠加；正文与 revision 不变', () => {
    const world = buildWorld()
    const beforeBeats = world.repos.revision.manifest(world.revisionId)
    const beforeHash = world.repos.revision.get(world.revisionId)!.contentHash
    const beforeRevisions = world.repos.revision.listByChapter(world.chapterId).length

    const submitted = submitReport(world.repos, {
      projectId: world.projectId,
      chapterId: world.chapterId,
      revisionId: world.revisionId,
      draft: { verdict: 'pass', blocking: [], suggestions: [] }
    })
    expect(submitted.report.verdict).toBe('pass')

    const result = appendVoiceSuggestions(world.repos, {
      chapterId: world.chapterId,
      reportId: submitted.report.id,
      persist: true
    })
    expect(result.appended).toBeGreaterThan(0)
    expect(result.belowThreshold).toBe(result.appended)

    const parsed = parseReportRecord(world.repos.review.getReport(submitted.report.id)!)
    expect(parsed.verdict).toBe('pass_with_notes')
    expect(parsed.blocking).toEqual([])
    const voiceIssues = parsed.suggestions.filter((issue) => issue.type === 'voice')
    expect(voiceIssues).toHaveLength(result.appended)
    expect(voiceIssues[0]!.beat_id).toBe('')
    expect(voiceIssues[0]!.evidence).toContain('区分度')
    expect(voiceIssues[0]!.evidence).not.toContain('灯灭了') // 不复制正文
    expect(BLOCKING_ISSUE_TYPES).not.toContain('voice')

    // 幂等：已有 voice 建议就跳过
    const again = appendVoiceSuggestions(world.repos, {
      chapterId: world.chapterId,
      reportId: submitted.report.id,
      persist: true
    })
    expect(again.appended).toBe(0)
    expect(parseReportRecord(world.repos.review.getReport(submitted.report.id)!).suggestions).toHaveLength(
      voiceIssues.length
    )

    // 指标写入了派生表，但正文、清单、revision 数不变
    expect(world.repos.voice.listByChapter(world.projectId, world.chapterId)).toHaveLength(1)
    expect(world.repos.revision.manifest(world.revisionId)).toEqual(beforeBeats)
    expect(world.repos.revision.get(world.revisionId)!.contentHash).toBe(beforeHash)
    expect(world.repos.revision.listByChapter(world.chapterId)).toHaveLength(beforeRevisions)
    expect(world.repos.beat.get('bt_1')!.body).toBe('灯灭了。雨停了。罢了，先回去。')
  })

  it('区分度足够高时不追加建议，报告保持 pass', () => {
    const world = buildWorld()
    // 改一个角色的语气：长句 + 问句 + 第一人称 → 区分度拉高。
    world.db
      .prepare("UPDATE character SET card_json = ? WHERE id = 'chr_b'")
      .run(JSON.stringify({ voice: { catchphrase: '你知道的' } }))
    world.db
      .prepare(
        "UPDATE beat SET body = '我一直在想，父亲为什么把匣子藏在祠堂，究竟是在躲谁？' WHERE speaker_id = 'chr_b'"
      )
      .run()
    const hash = hashManifestRows(world.repos.revision.manifest(world.revisionId))
    world.db.prepare('UPDATE revision SET content_hash = ? WHERE id = ?').run(hash, world.revisionId)

    const submitted = submitReport(world.repos, {
      projectId: world.projectId,
      chapterId: world.chapterId,
      revisionId: world.revisionId,
      draft: { verdict: 'pass', blocking: [], suggestions: [] }
    })
    const result = appendVoiceSuggestions(world.repos, {
      chapterId: world.chapterId,
      reportId: submitted.report.id,
      persist: true
    })
    expect(result.appended).toBe(0)
    expect(parseReportRecord(world.repos.review.getReport(submitted.report.id)!).verdict).toBe('pass')
  })
})
