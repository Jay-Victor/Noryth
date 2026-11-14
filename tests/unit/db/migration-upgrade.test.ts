import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { migrate, currentVersion } from '../../../src/main/db/migrator'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../../../src/main/db/migrations'
import { openDatabase, openDatabaseForMigrate } from '../../../src/main/db/project-db'
import { createRepos } from '../../../src/main/db/repos'
import { makeService, tempDir, vecExtensionPath } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

/** 阶段 01 项目只有 0001 与 schema_version=1；打开时必须先备份再升级到 0002。 */
describe('0001 → 0002 升级', () => {
  it('打开旧项目：先写 pre-migrate 备份，迁移后 outbox 有新列且 schema_version=2', () => {
    const userData = tempDir('noryth-upgrade-user-')
    const projectDir = tempDir('noryth-upgrade-proj-')
    cleanups.push(userData.cleanup, projectDir.cleanup)

    for (const sub of ['manuscript', 'assets', 'exports', 'backups', 'logs']) {
      mkdirSync(join(projectDir.path, sub), { recursive: true })
    }

    const db = openDatabaseForMigrate(join(projectDir.path, 'noryth.db'), vecExtensionPath())
    try {
      migrate(db, [MIGRATIONS[0]!])
      expect(currentVersion(db)).toBe(1)
      createRepos(db).project.create({
        title: '阶段一项目',
        pov: 'third_limited',
        embeddingModel: 'bge-small-zh-v1.5',
        embeddingDim: 512,
        defaultPreset: 'deepseek',
        schemaVersion: 1
      })
    } finally {
      db.close()
    }

    const { service } = makeService(userData.path)
    try {
      const opened = service.open({ path: projectDir.path })
      expect(opened.project.schemaVersion).toBe(LATEST_SCHEMA_VERSION)

      const backups = readdirSync(join(projectDir.path, 'backups'))
      expect(backups.some((name) => name.startsWith('pre-migrate-v1-'))).toBe(true)

      const inspect = openDatabase(join(projectDir.path, 'noryth.db'), { readonly: true })
      try {
        expect(currentVersion(inspect)).toBe(LATEST_SCHEMA_VERSION)
        const columns = inspect.prepare('PRAGMA table_info(outbox)').all() as Array<{ name: string }>
        expect(columns.map((column) => column.name)).toEqual(
          expect.arrayContaining(['chapter_id', 'revision_id', 'next_attempt_at'])
        )
      } finally {
        inspect.close()
      }
      expect(existsSync(join(projectDir.path, 'noryth.db'))).toBe(true)
    } finally {
      service.dispose()
    }
  })
})
