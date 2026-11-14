import { createHash } from 'node:crypto'

export interface Migration {
  version: number
  name: string
  sql: string
}

export interface MigrationResult {
  from: number
  to: number
  applied: number[]
}

interface MigrationRow {
  version: number
  name: string
  checksum: string
  applied_at: string
}

/** 规范化：统一 LF、去掉末尾空白行，保证跨平台 checksum 稳定。 */
export function normalizeMigrationSql(sql: string): string {
  return sql.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd()
}

export function checksumOf(sql: string): string {
  return createHash('sha256').update(normalizeMigrationSql(sql), 'utf8').digest('hex')
}

export function ensureMigrationTable(db: BetterSqliteDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migration (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
}

export function currentVersion(db: BetterSqliteDb): number {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migration'")
    .get() as { name?: string } | undefined
  if (!table) return 0
  const row = db.prepare('SELECT MAX(version) AS version FROM _migration').get() as
    | { version: number | null }
    | undefined
  return row?.version ?? 0
}

/**
 * 只前进的迁移器（DEV-PLAN §5.10）：
 * - 已应用迁移的 checksum 必须一致，否则抛 migration_checksum_mismatch
 * - 每个迁移在单独事务内执行；失败整体回滚
 * - schema_version 与 PRAGMA user_version 同步
 */
export function migrate(
  db: BetterSqliteDb,
  migrations: readonly Migration[],
  options: { now?: () => string } = {}
): MigrationResult {
  const now = options.now ?? (() => new Date().toISOString())
  ensureMigrationTable(db)

  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  const from = currentVersion(db)
  const appliedRows = db.prepare('SELECT * FROM _migration').all() as MigrationRow[]
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row]))

  const applied: number[] = []
  let to = from

  for (const migration of ordered) {
    const checksum = checksumOf(migration.sql)
    const existing = appliedByVersion.get(migration.version)
    if (existing) {
      if (existing.checksum !== checksum) {
        const error = new Error(
          `migration ${migration.version} checksum mismatch: applied=${existing.checksum} current=${checksum}`
        )
        error.name = 'MigrationChecksumMismatch'
        throw error
      }
      continue
    }
    if (migration.version <= to) {
      throw new Error(`migration ordering broken at version ${migration.version}`)
    }

    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO _migration (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)').run(
        migration.version,
        migration.name,
        checksum,
        now()
      )
      db.pragma(`user_version = ${migration.version}`)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 回滚失败：保留原始错误
      }
      throw error
    }
    applied.push(migration.version)
    to = migration.version
  }

  return { from, to, applied }
}

/**
 * 打开更高版本项目时只读；本函数只用于读取，不做迁移。
 */
export function assertSupportedVersion(projectVersion: number, latest: number): 'ok' | 'needs_app_update' {
  return projectVersion > latest ? 'needs_app_update' : 'ok'
}

// better-sqlite3 的最小结构类型：避免在纯逻辑模块里 import 原生模块。
export interface BetterSqliteDb {
  exec(sql: string): unknown
  prepare(sql: string): {
    get(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    run(...params: unknown[]): unknown
  }
  pragma(text: string): unknown
}
