import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyDatabase } from '../../../src/main/db/verify'
import { openTestDb } from './support/db'
import { seedFixture } from './support/fixture'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-verify-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed, dir: dir.path }
}

function codes(report: ReturnType<typeof verifyDatabase>): string[] {
  return report.issues.map((issue) => issue.code)
}

describe('db.verify()', () => {
  it('fixture 全绿：fixture 与镜像都通过', () => {
    const { handle, dir } = setup()
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(report.issues).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.stats.chapters).toBe(2)
    expect(report.stats.beats).toBe(48)
    expect(report.stats.liveBeats).toBe(48)
    expect(report.stats.mirrorsChecked).toBe(2)
  })

  it('双活拍：删掉部分唯一索引后插入重复槽位能被发现', () => {
    const { handle, seed, dir } = setup()
    const live = handle.repos.beat.listLiveByScene(seed.chapters[0]!.sceneIds[0]!)[0]!
    handle.db.exec('DROP INDEX beat_ord_live')
    handle.repos.beat.insert({
      chapterId: seed.chapterIds[0]!,
      sceneId: live.sceneId,
      ord: live.ord,
      speakerType: 'narrator',
      speakerId: 'narrator',
      body: '非法双活',
      status: 'draft',
      createdRevisionId: seed.chapters[0]!.revisionId
    })
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(report.ok).toBe(false)
    expect(codes(report)).toContain('double_live_beat')
  })

  it('孤儿 current_revision_id 能被发现', () => {
    const { handle, seed, dir } = setup()
    handle.db.prepare("UPDATE chapter SET current_revision_id = 'rev_missing' WHERE id = ?").run(seed.chapterIds[0]!)
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(codes(report)).toContain('orphan_current_revision')
    expect(report.ok).toBe(false)
  })

  it('seq 重复时报 seq_duplicate（ADR-0005 §4：不再按阅读顺序判单调）', () => {
    const { handle, seed, dir } = setup()
    const later = handle.repos.beat.listLiveByChapter(seed.chapterIds[0]!)[5]!
    handle.db.prepare('UPDATE beat SET seq = 1 WHERE id = ?').run(later.id)
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(codes(report)).toContain('seq_duplicate')
  })

  it('改早期拍（seq 变大）不再误报，阅读顺序不参与判定', () => {
    const { handle, seed, dir } = setup()
    const live = handle.repos.beat.listLiveByChapter(seed.chapterIds[0]!)
    const first = live[0]!
    const maxSeq = live.reduce((max, beat) => Math.max(max, beat.seq ?? 0), 0)
    handle.db.prepare('UPDATE beat SET seq = ? WHERE id = ?').run(maxSeq + 1, first.id)
    handle.db.prepare('UPDATE project SET seq_head = ?').run(maxSeq + 1)
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(codes(report)).not.toContain('seq_not_monotonic')
    expect(codes(report)).not.toContain('seq_duplicate')
  })

  it('槽位复用旧 seq 时报 seq_not_monotonic', () => {
    const { handle, seed, dir } = setup()
    const [live, older] = handle.repos.beat.listLiveByChapter(seed.chapterIds[0]!)
    // 伪造一次替换：同一槽位留下 superseded 版本，活拍 seq 反而更小。
    handle.db
      .prepare("UPDATE beat SET status = 'superseded', seq = ? WHERE id = ?")
      .run((live!.seq ?? 0) + 5, live!.id)
    handle.repos.beat.insert({
      chapterId: seed.chapterIds[0]!,
      sceneId: live!.sceneId,
      ord: live!.ord,
      seq: live!.seq,
      speakerType: 'narrator',
      speakerId: 'narrator',
      body: '复用旧 seq',
      status: 'confirmed',
      supersedesId: live!.id,
      createdRevisionId: seed.chapters[0]!.revisionId
    })
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(codes(report)).toContain('seq_not_monotonic')
    void older
  })

  it('revision.content_hash 漂移时报 revision_hash_mismatch', () => {
    const { handle, seed, dir } = setup()
    handle.db.prepare("UPDATE revision SET content_hash = 'deadbeef' WHERE id = ?").run(seed.chapters[0]!.revisionId)
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(codes(report)).toContain('revision_hash_mismatch')
  })

  it('镜像被外部修改：只告警，不改变 ok', () => {
    const { handle, dir } = setup()
    writeFileSync(join(dir, 'manuscript', 'ch-001.md'), '外部改动\n', 'utf8')
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(report.ok).toBe(true)
    expect(codes(report)).toContain('mirror_hash_mismatch')
  })

  it('foreign_key_check 能发现禁用外键时插入的坏行', () => {
    const { handle, dir } = setup()
    handle.db.pragma('foreign_keys = OFF')
    handle.db
      .prepare(
        `INSERT INTO gate_record (id, project_id, gate_id, entity_type, entity_id, decision, actor, payload_json, created_at)
         VALUES ('gate_bad', 'prj_missing', 'G2', 'chapter', 'ch_missing', 'approve', 'author', '{}', '2026-11-14T00:00:00.000Z')`
      )
      .run()
    handle.db.pragma('foreign_keys = ON')
    const report = verifyDatabase(handle.db, { projectDir: dir })
    expect(codes(report)).toContain('foreign_key_check')
    expect(report.ok).toBe(false)
  })
})
