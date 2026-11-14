import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { checksumOf, currentVersion, migrate, normalizeMigrationSql } from '../../src/main/db/migrator'
import { openDatabase, openDatabaseForMigrate } from '../../src/main/db/project-db'
import { tempDir, vecExtensionPath } from './helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function newDb(dir: string): ReturnType<typeof openDatabaseForMigrate> {
  return openDatabaseForMigrate(join(dir, 'noryth.db'), vecExtensionPath())
}

describe('migrator', () => {
  it('在三个空目录上重复迁移成功且版本为 1', () => {
    for (let index = 0; index < 3; index += 1) {
      const dir = tempDir()
      cleanups.push(dir.cleanup)
      const db = newDb(dir.path)
      try {
        const first = migrate(db, MIGRATIONS)
        expect(first.applied).toEqual([1])
        expect(first.to).toBe(LATEST_SCHEMA_VERSION)
        expect(currentVersion(db)).toBe(1)
        expect(db.pragma('user_version', { simple: true })).toBe(1)

        const second = migrate(db, MIGRATIONS)
        expect(second.applied).toEqual([])
        expect(second.to).toBe(1)

        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
          .all() as Array<{ name: string }>
        const names = tables.map((row) => row.name)
        for (const table of ['project', 'gate_record', 'beat', 'revision', 'memory_entry', 'memory_fts', 'memory_vec', '_migration']) {
          expect(names).toContain(table)
        }
        // 约束存在性：单值槽部分唯一索引
        const indexes = db
          .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('beat_ord_live','world_single_value','rel_one_active','job_idem')")
          .all() as Array<{ name: string }>
        expect(indexes).toHaveLength(4)
      } finally {
        db.close()
      }
    }
  })

  it('已应用迁移的 checksum 变化会失败', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const file = join(dir.path, 'noryth.db')
    const db = openDatabaseForMigrate(file, vecExtensionPath())
    try {
      migrate(db, MIGRATIONS)
      const tampered = [{ ...MIGRATIONS[0]!, sql: MIGRATIONS[0]!.sql.replace('CREATE TABLE project', 'CREATE TABLE project_x') }]
      expect(() => migrate(db, tampered)).toThrowError(/checksum mismatch/)
      expect(currentVersion(db)).toBe(1)
    } finally {
      db.close()
    }
  })

  it('迁移失败整体回滚，不留半张表', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const file = join(dir.path, 'noryth.db')
    const db = openDatabase(file, { vecExtension: vecExtensionPath() })
    try {
      const broken = [{ version: 1, name: 'broken', sql: 'CREATE TABLE ok_table (id TEXT); CREATE TABLE ok_table (id TEXT);' }]
      expect(() => migrate(db, broken)).toThrow()
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      expect(tables.map((row) => row.name)).not.toContain('ok_table')
      expect(currentVersion(db)).toBe(0)
    } finally {
      db.close()
    }
  })

  it('规范化 SQL 让 CRLF 与行尾空白不影响 checksum', () => {
    const sql = '-- name: init\nCREATE TABLE a (id TEXT);\n\n'
    const crlf = '-- name: init\r\nCREATE TABLE a (id TEXT);   \r\n\r\n'
    expect(normalizeMigrationSql(sql)).toBe(normalizeMigrationSql(crlf))
    expect(checksumOf(sql)).toBe(checksumOf(crlf))
    expect(checksumOf(sql)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('空库打开不创建任何表', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const db = openDatabase(join(dir.path, 'empty.db'), {})
    try {
      const tables = db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='table'").get() as { count: number }
      expect(tables.count).toBe(0)
      expect(existsSync(join(dir.path, 'empty.db'))).toBe(true)
    } finally {
      db.close()
    }
  })
})
