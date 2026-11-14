import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDatabaseForMigrate, type Db } from '../../../../src/main/db/project-db'
import { migrate } from '../../../../src/main/db/migrator'
import { MIGRATIONS } from '../../../../src/main/db/migrations'
import { createRepos, type Repos } from '../../../../src/main/db/repos'
import { vecExtensionPath } from '../../helpers'

export interface TestDb {
  db: Db
  repos: Repos
  file: string
}

/** 打开一个已迁移的真实 SQLite 项目库（含 sqlite-vec）。 */
export function openTestDb(dir: string): TestDb {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'noryth.db')
  const db = openDatabaseForMigrate(file, vecExtensionPath())
  migrate(db, MIGRATIONS)
  return { db, repos: createRepos(db), file }
}

export function closeTestDb(handle: TestDb): void {
  handle.db.close()
}
