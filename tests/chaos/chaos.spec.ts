import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { verifyDatabase } from '../../src/main/db/verify'
import { isBusyError } from '../../src/main/db/busy'
import { publishPendingMirrors } from '../../src/main/doc/publish'
import { chapterMirrorRelPath, renderChapterMarkdown } from '../../src/main/doc/mirror'
import { hashText } from '../../src/main/db/hash'
import { recoverInterrupted } from '../../src/main/doc/recovery'
import { openTestDb } from '../unit/db/support/db'
import { seedFixture } from '../unit/db/support/fixture'
import { tempDir } from '../unit/helpers'

/**
 * CHAOS-01..08（PHASE-10 J3 / DEV-PLAN §13.6）。
 *
 * 全部用真实 SQLite 文件 + 真进程强杀（`taskkill /F`）。被杀的子进程在一个
 * 未提交的事务里写 revision/outbox/memory_entry，验证的正是「要么全写要么全不写」
 * 与「重启后已确认拍零丢失」。
 *
 * 用 `pnpm test:chaos` 跑；不进默认单测（要起子进程、单条 ~5s）。
 */

const WORKER = join(__dirname, 'worker.cjs')
const cleanups: Array<() => void> = []
const children: Array<ReturnType<typeof spawn>> = []

afterEach(() => {
  while (children.length > 0) {
    const child = children.pop()!
    if (child.exitCode === null && child.pid) {
      try {
        execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
      } catch {
        // 已退出
      }
    }
  }
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup() {
  const dir = tempDir('noryth-chaos-')
  cleanups.push(dir.cleanup)
  const handle = openTestDb(dir.path)
  cleanups.push(() => handle.db.close())
  const seed = seedFixture(handle.db, handle.repos, dir.path)
  return { dir: dir.path, handle, seed }
}

/** 起子进程，等它打印 ready（事务已开始/已提交），然后强杀。 */
function runAndKill(dbPath: string, mode: 'tx' | 'committed' | 'memory', chapterId: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [WORKER, dbPath, mode, chapterId], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = ''
    let settled = false
    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolvePromise()
    }
    const timer = setTimeout(() => {
      kill(child)
      finish(new Error(`worker ${mode} did not become ready: ${stdout}`))
    }, 20_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
      if (!stdout.includes('ready')) return
      const cleanExit = kill(child)
      expect(cleanExit).toBe(false)
      finish(null)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stdout += String(chunk)
    })
    child.on('exit', (code) => {
      // 没等到 ready 就退出：立刻失败，而不是让 Promise 永远挂着
      finish(new Error(`worker ${mode} exited before ready (code ${code}): ${stdout}`))
    })
  })
}

/** 返回 false 表示进程是被强杀的（非 0 正常退出）。 */
function kill(child: ReturnType<typeof spawn>): boolean {
  if (!child.pid) return false
  try {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' })
  } catch {
    // 已退出
  }
  const normalized = child.exitCode
  return normalized === 0
}

function readDb(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true })
}

describe('CHAOS-01..08：强杀、事务、锁与写失败', () => {
  it('CHAOS-01/02 落盘事务中强杀：没有半条 revision，也没有孤儿', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const before = handle.repos.revision.listByChapter(chapterId).length
    const dbPath = join(dir, 'noryth.db')
    // 先关掉父进程连接，避免 WAL 被两个进程同时持有
    handle.db.close()

    await runAndKill(dbPath, 'tx', chapterId)

    const db = readDb(dbPath)
    try {
      const revisions = db.prepare('SELECT COUNT(*) AS count FROM revision WHERE chapter_id = ?').get(chapterId) as {
        count: number
      }
      expect(revisions.count).toBe(before)
      const orphans = db
        .prepare('SELECT COUNT(*) AS count FROM revision_beat rb LEFT JOIN beat b ON b.id = rb.beat_id WHERE b.id IS NULL')
        .get() as { count: number }
      expect(orphans.count).toBe(0)
      const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      expect(integrity.integrity_check).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('CHAOS-03 outbox 中断：重启补发，陈旧临时文件被覆盖，hash 一致', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const chapter = handle.repos.chapter.get(chapterId)!
    const revision = handle.repos.revision.listByChapter(chapterId).at(-1)!
    const rel = chapterMirrorRelPath(chapter.ord)
    const absolute = join(dir, rel)
    mkdirSync(join(dir, 'manuscript'), { recursive: true })
    // 模拟「写完临时文件后崩溃」：目标文件还没 rename 过去
    writeFileSync(`${absolute}.tmp`, '半截内容', 'utf8')
    rmSync(absolute, { force: true })
    // 清掉 fixture 已发布的 outbox 行，造一条待发布
    const rendered = renderChapterMarkdown(handle.db, { chapterId, revisionId: revision.id })
    const outbox = handle.repos.outbox.listPending(handle.repos.project.get()!.id, new Date().toISOString(), 10)
    for (const row of outbox) handle.repos.outbox.markPublished(row.id, new Date().toISOString())
    const created = handle.repos.outbox.enqueue({
      projectId: handle.repos.project.get()!.id,
      chapterId,
      revisionId: revision.id,
      path: rel,
      expectedHash: hashText(rendered)
    })
    expect(created.id).toBeTruthy()

    const report = publishPendingMirrors(handle.db, dir)
    expect(report.failed).toHaveLength(0)
    expect(report.published.length).toBeGreaterThan(0)
    const content = readFileSync(absolute, 'utf8')
    expect(content).toBe(rendered)
    expect(hashText(content)).toBe(hashText(rendered))
    // 已发布的行不会再被重复发布
    const second = publishPendingMirrors(handle.db, dir)
    expect(second.published).toHaveLength(0)
    expect(handle.repos.chapter.get(chapterId)!.status).toBe(chapter.status)
  })

  it('CHAOS-04 记忆 apply 中断：事务未提交则一条不写', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const dbPath = join(dir, 'noryth.db')
    const before = ((): number => {
      const db = readDb(dbPath)
      try {
        return (db.prepare('SELECT COUNT(*) AS count FROM memory_entry').get() as { count: number }).count
      } finally {
        db.close()
      }
    })()
    handle.db.close()

    await runAndKill(dbPath, 'memory', chapterId)

    const db = readDb(dbPath)
    try {
      const after = (db.prepare('SELECT COUNT(*) AS count FROM memory_entry').get() as { count: number }).count
      expect(after).toBe(before)
      const audit = (db.prepare("SELECT COUNT(*) AS count FROM memory_audit WHERE action = 'apply'").get() as { count: number }).count
      expect(audit).toBe(0)
    } finally {
      db.close()
    }
  })

  it('CHAOS-05 数据库锁：第二个连接持有写锁，5s 后报 SQLITE_BUSY', () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const other = new Database(join(dir, 'noryth.db'))
    try {
      other.pragma('busy_timeout = 200')
      other.exec('BEGIN IMMEDIATE')
      other
        .prepare(
          "INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at) VALUES ('rev_lock_holder', ?, NULL, 'draft', 'x', 'doc_controller', NULL, ?)"
        )
        .run(chapterId, new Date().toISOString())

      const started = Date.now()
      let caught: unknown = null
      try {
        handle.db
          .prepare(
            "INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at) VALUES ('rev_should_not_write', ?, NULL, 'draft', 'x', 'author', NULL, ?)"
          )
          .run(chapterId, new Date().toISOString())
      } catch (error) {
        caught = error
      }
      expect(isBusyError(caught)).toBe(true)
      expect(Date.now() - started).toBeGreaterThanOrEqual(150)
      other.exec('ROLLBACK')
    } finally {
      other.close()
    }
  })

  it('CHAOS-06 写失败（磁盘满/只读目录的等价注入）：报错明确，库仍完整', () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    const chapter = handle.repos.chapter.get(chapterId)!
    const revision = handle.repos.revision.listByChapter(chapterId).at(-1)!
    const rel = chapterMirrorRelPath(chapter.ord)
    // 把 manuscript 换成一个「同名文件」：目录建不出来，写文件必然失败
    rmSync(join(dir, 'manuscript'), { recursive: true, force: true })
    writeFileSync(join(dir, 'manuscript'), 'not a directory', 'utf8')
    const rendered = renderChapterMarkdown(handle.db, { chapterId, revisionId: revision.id })
    for (const row of handle.repos.outbox.listPending(handle.repos.project.get()!.id, new Date().toISOString(), 10)) {
      handle.repos.outbox.markPublished(row.id, new Date().toISOString())
    }
    handle.repos.outbox.enqueue({
      projectId: handle.repos.project.get()!.id,
      chapterId,
      revisionId: revision.id,
      path: rel,
      expectedHash: hashText(rendered)
    })

    const report = publishPendingMirrors(handle.db, dir)
    expect(report.failed.length + report.conflicts.length).toBeGreaterThan(0)
    expect(report.published).toHaveLength(0)
    // DB 仍是权威：完整、可校验、不是 0 字节
    const dbPath = join(dir, 'noryth.db')
    expect(statSync(dbPath).size).toBeGreaterThan(0)
    const verify = verifyDatabase(handle.db, { projectDir: dir, checkMirror: false })
    expect(verify.ok, JSON.stringify(verify.issues)).toBe(true)
  })

  it('CHAOS-07 更新中断：检查失败不阻塞启动（启动路径不依赖网络）', async () => {
    const { dir } = setup()
    // 更新检查器必须吞掉网络错误，并在超时内返回；这里用不可达地址验证不抛错
    const { checkForUpdates } = await import('../../src/main/update')
    const result = await checkForUpdates({ feedUrl: 'http://127.0.0.1:9/nope', timeoutMs: 500, currentVersion: '0.1.0' })
    expect(result.status).toBe('failed')
    expect(result.blocking).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })

  it('CHAOS-08 已确认拍零丢失：强杀后逐拍比对 body 与 hash', async () => {
    const { dir, handle, seed } = setup()
    const chapterId = seed.chapterIds[0]!
    // 让 fixture 的拍处于 confirmed（seed 默认是 draft）
    const beats = handle.repos.beat.listLiveByChapter(chapterId)
    for (const beat of beats) {
      handle.repos.beat.setStatus(beat.id, 'confirmed')
    }
    const before = beats.map((beat) => ({
      id: beat.id,
      body: beat.body,
      hash: hashText(`${beat.speakerType}:${beat.speakerId}:${beat.body}`)
    }))
    const dbPath = join(dir, 'noryth.db')
    handle.db.close()

    await runAndKill(dbPath, 'committed', chapterId)

    const db = readDb(dbPath)
    try {
      const rows = db
        .prepare(
          "SELECT id, body, speaker_type, speaker_id FROM beat WHERE chapter_id = ? AND status = 'confirmed' ORDER BY ord"
        )
        .all(chapterId) as Array<{ id: string; body: string; speaker_type: string; speaker_id: string }>
      expect(rows).toHaveLength(before.length)
      for (const row of rows) {
        const expected = before.find((entry) => entry.id === row.id)!
        expect(row.body).toBe(expected.body)
        expect(hashText(`${row.speaker_type}:${row.speaker_id}:${row.body}`)).toBe(expected.hash)
      }
    } finally {
      db.close()
    }

    // 重开项目：running/generating 一律 interrupted，不自动重放
    const reopened = openTestDb(dir)
    cleanups.push(() => reopened.db.close())
    const report = recoverInterrupted(reopened.repos)
    expect(Array.isArray(report.jobs) && Array.isArray(report.beats)).toBe(true)
    // 已确认的拍不参与恢复
    const reopenedBeats = reopened.repos.beat.listLiveByChapter(chapterId)
    expect(reopenedBeats.every((beat) => beat.status === 'confirmed')).toBe(true)
  })
})
