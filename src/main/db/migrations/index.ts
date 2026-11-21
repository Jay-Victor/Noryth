import initSql from './0001_init.sql?raw'
import outboxMetaSql from './0002_outbox_meta.sql?raw'
import planningSql from './0003_planning.sql?raw'
import writingSql from './0004_writing.sql?raw'
import reviewSql from './0005_review.sql?raw'
import memorySql from './0006_memory.sql?raw'
import settingsSql from './0007_settings.sql?raw'
import storyTimeSql from './0008_story_time.sql?raw'
import blueprintOpsSql from './0009_blueprint_ops.sql?raw'
import branchSummarySql from './0010_branch_summary.sql?raw'
import toolCallChapterSql from './0011_tool_call_chapter.sql?raw'
import voiceSql from './0012_voice.sql?raw'
import type { Migration } from '../migrator'

/**
 * 迁移清单：SQL 以 ?raw 内联，打包进 main bundle，避免 asar 里找不到 .sql。
 * 每个文件首行 `-- name:` 与本表 name 保持一致。
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: initSql },
  { version: 2, name: 'outbox_meta', sql: outboxMetaSql },
  { version: 3, name: 'planning', sql: planningSql },
  { version: 4, name: 'writing', sql: writingSql },
  { version: 5, name: 'review', sql: reviewSql },
  { version: 6, name: 'memory', sql: memorySql },
  { version: 7, name: 'settings', sql: settingsSql },
  { version: 8, name: 'story_time', sql: storyTimeSql },
  { version: 9, name: 'blueprint_ops', sql: blueprintOpsSql },
  { version: 10, name: 'branch_summary', sql: branchSummarySql },
  { version: 11, name: 'tool_call_chapter', sql: toolCallChapterSql },
  { version: 12, name: 'voice', sql: voiceSql }
]

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)
