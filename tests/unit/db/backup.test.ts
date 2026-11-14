import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '../../../src/shared/domain/app-error'
import {
  createCheckpoint,
  createDailyBackup,
  listBackups,
  pruneBackups,
  restoreBackupToDirectory
} from '../../../src/main/db/backup'
import { openDatabase } from '../../../src/main/db/project-db'
import { openTestDb } from './support/db'
import { seedFixture } from './support/fixture'
import { tempDir, vecExtensionPath } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-backup-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { handle, seed, dir: dir.path }
}

describe('备份与恢复', () => {
  it('createCheckpoint 生成可打开的 VACUUM INTO 快照', () => {
    const { handle, seed, dir } = setup()
    const checkpoint = createCheckpoint(handle.db, dir, seed.chapters[0]!.seqEnd)
    expect(existsSync(checkpoint.path)).toBe(true)
    expect(checkpoint.bytes).toBeGreaterThan(0)

    const snapshot = openDatabase(checkpoint.path, { readonly: true, vecExtension: vecExtensionPath() })
    try {
      expect(snapshot.pragma('integrity_check', { simple: true })).toBe('ok')
      const project = snapshot.prepare('SELECT id FROM project LIMIT 1').get() as { id: string }
      expect(project.id).toBe(seed.projectId)
    } finally {
      snapshot.close()
    }
  })

  it('每日备份同一天只建一次，且包含 manuscript 镜像', () => {
    const { handle, dir } = setup()
    const first = createDailyBackup(handle.db, dir, { date: '2026-11-14' })
    expect(first.created).toBe(true)
    expect(existsSync(join(first.path, 'noryth.db'))).toBe(true)
    expect(existsSync(join(first.path, 'manuscript', 'ch-001.md'))).toBe(true)

    const second = createDailyBackup(handle.db, dir, { date: '2026-11-14' })
    expect(second.created).toBe(false)
    expect(second.path).toBe(first.path)
  })

  it('恢复到新目录后 db.verify() 全绿，正文镜像一并恢复', () => {
    const { handle, seed, dir } = setup()
    const daily = createDailyBackup(handle.db, dir, { date: '2026-11-14' })
    const target = tempDir('noryth-restore-')
    cleanups.push(target.cleanup)

    const restored = restoreBackupToDirectory({
      source: daily.path,
      targetDir: target.path,
      vecExtension: vecExtensionPath()
    })
    expect(restored.report.ok).toBe(true)
    expect(restored.report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
    expect(existsSync(join(target.path, 'manuscript', 'ch-001.md'))).toBe(true)

    const db = openDatabase(restored.path, { readonly: true, vecExtension: vecExtensionPath() })
    try {
      const project = db.prepare('SELECT id FROM project LIMIT 1').get() as { id: string }
      expect(project.id).toBe(seed.projectId)
      const beats = db.prepare('SELECT COUNT(*) AS count FROM beat').get() as { count: number }
      expect(beats.count).toBe(48)
    } finally {
      db.close()
    }
  })

  it('checkpoint 恢复到新目录：DB 完整，缺镜像只告警不失败', () => {
    const { handle, seed, dir } = setup()
    const checkpoint = createCheckpoint(handle.db, dir, seed.chapters[0]!.seqEnd)
    const target = tempDir('noryth-restore-checkpoint-')
    cleanups.push(target.cleanup)
    const restored = restoreBackupToDirectory({
      source: checkpoint.path,
      targetDir: target.path,
      vecExtension: vecExtensionPath()
    })
    expect(restored.report.ok).toBe(true)
    expect(restored.report.issues.some((issue) => issue.code === 'mirror_missing')).toBe(true)
  })

  it('保留策略：10 个检查点 + 7 个日备份', () => {
    const dir = tempDir('noryth-prune-')
    cleanups.push(dir.cleanup)
    const backups = join(dir.path, 'backups')
    mkdirSync(backups, { recursive: true })
    for (let index = 1; index <= 12; index += 1) {
      writeFileSync(join(backups, `checkpoint-${index}.db`), 'x')
    }
    for (let index = 1; index <= 9; index += 1) {
      mkdirSync(join(backups, `daily-2026-11-${String(index).padStart(2, '0')}`), { recursive: true })
    }
    const removed = pruneBackups(dir.path)
    expect(removed).toHaveLength(2 + 2)
    const listing = listBackups(dir.path)
    expect(listing.checkpoints).toHaveLength(10)
    expect(listing.checkpoints[0]!.seq).toBe(3)
    expect(listing.dailies).toHaveLength(7)
    expect(listing.dailies[0]!.date).toBe('2026-11-03')
  })

  it('verify 有 error 时拒绝建检查点', () => {
    const { handle, seed, dir } = setup()
    handle.db.prepare("UPDATE chapter SET current_revision_id = 'rev_missing' WHERE id = ?").run(seed.chapterIds[0]!)
    let thrown: unknown
    try {
      createCheckpoint(handle.db, dir, 999)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('internal_error')
    expect(existsSync(join(dir, 'backups', 'checkpoint-999.db'))).toBe(false)
  })
})
