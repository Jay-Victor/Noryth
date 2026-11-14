import initSql from './0001_init.sql?raw'
import outboxMetaSql from './0002_outbox_meta.sql?raw'
import type { Migration } from '../migrator'

/**
 * 迁移清单：SQL 以 ?raw 内联，打包进 main bundle，避免 asar 里找不到 .sql。
 * 每个文件首行 `-- name:` 与本表 name 保持一致。
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: initSql },
  { version: 2, name: 'outbox_meta', sql: outboxMetaSql }
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
