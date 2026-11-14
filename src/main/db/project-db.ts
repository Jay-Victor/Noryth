import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { AppError } from '../../shared/domain/app-error'
import { currentVersion, migrate, type Migration } from './migrator'

export type Db = Database.Database

export interface OpenDbOptions {
  readonly?: boolean
  /** sqlite-vec 的 vec0.dll 路径；为空时明确报 vector_unavailable。 */
  vecExtension?: string | null
}

export function openDatabase(file: string, options: OpenDbOptions = {}): Db {
  const readonly = options.readonly === true
  const db = new Database(file, { readonly, fileMustExist: readonly })
  if (!readonly) {
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 1000')
  }
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('temp_store = MEMORY')

  if (options.vecExtension !== null && options.vecExtension !== undefined) {
    if (!existsSync(options.vecExtension)) {
      db.close()
      throw new AppError('vector_unavailable', `vec0 extension missing at ${options.vecExtension}`)
    }
    db.loadExtension(options.vecExtension)
  }
  return db
}

/** 建库必须加载 sqlite-vec：0001 迁移里包含 vec0 虚拟表。 */
export function openDatabaseForMigrate(file: string, vecExtension: string | null): Db {
  if (!vecExtension) {
    throw new AppError('vector_unavailable', 'vec0 extension not resolved')
  }
  return openDatabase(file, { vecExtension })
}

export function applyMigrations(db: Db, migrations: readonly Migration[]): number {
  const result = migrate(db, migrations)
  return result.to
}

export function schemaVersionOf(db: Db): number {
  return currentVersion(db)
}
