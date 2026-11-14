import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from './project-db'
import { hashFile, hashText } from './hash'
import { writeMirrorAtomic } from '../doc/mirror'
import { systemClock, type Clock } from './repos/common'
import type { OutboxRecord } from './repos/outbox'
import { OutboxRepo } from './repos/outbox'
import { ProjectRepo } from './repos/project'

export interface PublishConflict {
  id: string
  path: string
  expectedHash: string
  diskHash: string
}

export interface PublishFailure {
  id: string
  path: string
  error: string
}

export interface PublishReport {
  published: string[]
  /** 磁盘 hash 已等于期望值，跳过写入（幂等恢复）。 */
  skipped: string[]
  conflicts: PublishConflict[]
  failed: PublishFailure[]
  /** 已达到最大重试次数、不再自动重试的行。 */
  exhausted: string[]
}

export interface OutboxPublisherOptions {
  db: Db
  projectDir: string
  /** 从 revision 渲染文件内容；由 doc 层提供，db 层不反向依赖业务。 */
  render: (row: OutboxRecord) => string
  now?: Clock
  maxAttempts?: number
  backoffMs?: (attempt: number) => number
  limit?: number
}

/**
 * outbox 发布器（DEV-PLAN §5.8 / §8.7）：
 * 1. 事务提交后读未发布行；
 * 2. 渲染 → 临时文件 → fsync → rename；
 * 3. 磁盘 hash 与 expected_hash 不一致 → 不覆盖，记 file_conflict 并退避重试；
 * 4. 进程被杀后新建实例会从 published_at IS NULL 继续，hash 相同则跳过。
 */
export class OutboxPublisher {
  private readonly repo: OutboxRepo
  private readonly now: Clock
  private readonly maxAttempts: number
  private readonly backoffMs: (attempt: number) => number
  private readonly limit: number

  constructor(private readonly options: OutboxPublisherOptions) {
    this.repo = new OutboxRepo(options.db, options.now ?? systemClock)
    this.now = options.now ?? systemClock
    this.maxAttempts = options.maxAttempts ?? 5
    this.backoffMs = options.backoffMs ?? ((attempt) => Math.min(60_000, 500 * 2 ** (attempt - 1)))
    this.limit = options.limit ?? 100
  }

  publishPending(): PublishReport {
    const report: PublishReport = {
      published: [],
      skipped: [],
      conflicts: [],
      failed: [],
      exhausted: []
    }
    const project = new ProjectRepo(this.options.db).get()
    if (!project) return report

    const rows = this.repo.listPending(project.id, this.now(), this.limit)
    for (const row of rows) {
      if (row.attempts >= this.maxAttempts) {
        report.exhausted.push(row.id)
        continue
      }
      this.publishOne(row, report)
    }
    return report
  }

  private publishOne(row: OutboxRecord, report: PublishReport): void {
    if (!row.chapterId || !row.revisionId) {
      this.fail(row, report, 'missing_chapter_or_revision')
      return
    }

    if (this.repo.hasNewerPublished(row.chapterId, row.createdAt, row.id)) {
      // 更晚的 revision 已经上盘；旧行直接出队，不能把镜像回退。
      this.repo.markPublished(row.id, this.now())
      report.skipped.push(row.id)
      return
    }

    let content: string
    try {
      content = this.options.render(row)
    } catch (error) {
      this.fail(row, report, `render_failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    const renderedHash = hashText(content)
    if (renderedHash !== row.expectedHash) {
      // revision 不可变，说明渲染或清单有 bug；不写盘，留给重试与诊断。
      this.fail(row, report, `render_hash_mismatch: rendered=${renderedHash} expected=${row.expectedHash}`)
      return
    }

    const absolute = join(this.options.projectDir, row.path)

    if (existsSync(absolute)) {
      const diskHash = hashFile(absolute)
      if (diskHash === row.expectedHash) {
        this.repo.markPublished(row.id, this.now())
        report.skipped.push(row.id)
        return
      }
      const previous = this.repo.latestPublishedHash(row.chapterId, row.id)
      if (diskHash !== previous) {
        // 既不是当前 revision，也不是上一份已发布内容 → 外部改动，绝不覆盖。
        const failed = this.repo.recordFailure(row.id, 'file_conflict', this.nextAttemptAt(row.attempts))
        report.conflicts.push({
          id: row.id,
          path: row.path,
          expectedHash: row.expectedHash,
          diskHash
        })
        if (failed.attempts >= this.maxAttempts) report.exhausted.push(row.id)
        return
      }
    }

    try {
      writeMirrorAtomic(absolute, content)
    } catch (error) {
      this.fail(row, report, `write_failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (hashFile(absolute) !== row.expectedHash) {
      this.fail(row, report, 'post_write_hash_mismatch')
      return
    }

    this.repo.markPublished(row.id, this.now())
    report.published.push(row.id)
  }

  private fail(row: OutboxRecord, report: PublishReport, error: string): void {
    const failed = this.repo.recordFailure(row.id, error, this.nextAttemptAt(row.attempts))
    report.failed.push({ id: row.id, path: row.path, error })
    if (failed.attempts >= this.maxAttempts) report.exhausted.push(row.id)
  }

  private nextAttemptAt(attempts: number): string | null {
    const next = attempts + 1
    if (next >= this.maxAttempts) return null
    const at = Date.parse(this.now()) + this.backoffMs(next)
    return new Date(at).toISOString()
  }
}
