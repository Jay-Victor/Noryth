import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { checksumOf, currentVersion, migrate, normalizeMigrationSql } from '../../src/main/db/migrator'
import { openDatabase, openDatabaseForMigrate } from '../../src/main/db/project-db'
import { verifyDatabase } from '../../src/main/db/verify'
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
        expect(first.applied).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
        expect(first.to).toBe(LATEST_SCHEMA_VERSION)
        expect(currentVersion(db)).toBe(LATEST_SCHEMA_VERSION)
        expect(db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION)

        const second = migrate(db, MIGRATIONS)
        expect(second.applied).toEqual([])
        expect(second.to).toBe(LATEST_SCHEMA_VERSION)

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
      expect(currentVersion(db)).toBe(LATEST_SCHEMA_VERSION)
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

  it('0008 迁移旧项目：scene 回填 timeline=main，两轴为 NULL', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const db = newDb(dir.path)
    try {
      // 先迁到 7（0007 = 阶段 11 的库），写一行旧 scene，再迁 0008。
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 7)
      )
      db.prepare(
        `INSERT INTO project (id, title, pov, embedding_model, embedding_dim, default_preset, schema_version, created_at, updated_at)
         VALUES ('prj_old', '旧项目', 'third_limited', 'bge', 512, 'deepseek', 7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO scene (id, project_id, ord, location, participants_json, goal, exit_json, status, created_at, updated_at)
         VALUES ('scn_old', 'prj_old', 1, '祠堂', '[]', '旧场景', '{}', 'planned', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()

      const result = migrate(db, MIGRATIONS)
      expect(result.applied).toEqual([8, 9, 10, 11, 12, 13])
      const row = db.prepare('SELECT timeline, story_start, story_end FROM scene WHERE id = ?').get('scn_old') as {
        timeline: string
        story_start: string | null
        story_end: string | null
      }
      expect(row).toEqual({ timeline: 'main', story_start: null, story_end: null })
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'scene_timeline'")
        .get() as { name?: string } | undefined
      expect(index?.name).toBe('scene_timeline')
      expect(() => db.prepare("UPDATE scene SET timeline = 'nope' WHERE id = 'scn_old'").run()).toThrow()
    } finally {
      db.close()
    }
  })

  it('0009 迁移旧项目：meta_json 默认 {}、invalidated 两列 NULL、新表与索引存在', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const db = newDb(dir.path)
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 8)
      )
      db.prepare(
        `INSERT INTO project (id, title, pov, embedding_model, embedding_dim, default_preset, schema_version, created_at, updated_at)
         VALUES ('prj_old', '旧项目', 'third_limited', 'bge', 512, 'deepseek', 8, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO outline_node (id, project_id, parent_id, kind, ord, title, content, status, created_at, updated_at)
         VALUES ('out_old', 'prj_old', NULL, 'main', 0, '旧主线', '', 'locked', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO outline_node (id, project_id, parent_id, kind, ord, title, content, status, created_at, updated_at)
         VALUES ('out_ch', 'prj_old', 'out_old', 'chapter', 0, '旧章', '', 'locked', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO chapter (id, project_id, outline_node_id, ord, status)
         VALUES ('ch_old', 'prj_old', 'out_ch', 1, 'planned')`
      ).run()

      const result = migrate(db, MIGRATIONS)
      expect(result.applied).toEqual([9, 10, 11, 12, 13])

      const node = db.prepare('SELECT meta_json FROM outline_node WHERE id = ?').get('out_old') as {
        meta_json: string
      }
      expect(node.meta_json).toBe('{}')
      const chapter = db
        .prepare('SELECT invalidated_at, invalidated_reason FROM chapter WHERE id = ?')
        .get('ch_old') as { invalidated_at: string | null; invalidated_reason: string | null }
      expect(chapter).toEqual({ invalidated_at: null, invalidated_reason: null })

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('foreshadow','blueprint_change') ORDER BY name")
        .all() as Array<{ name: string }>
      expect(tables.map((row) => row.name)).toEqual(['blueprint_change', 'foreshadow'])
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('foreshadow_by_status','blueprint_change_by_project') ORDER BY name"
        )
        .all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toEqual(['blueprint_change_by_project', 'foreshadow_by_status'])

      // 旧行 meta 为空 → 覆盖检查只给「未标注」建议，不阻断 G1（PHASE-15 §5.1）
      expect(() =>
        db
          .prepare(
            `INSERT INTO foreshadow (id, project_id, text, planted_chapter_id, status, created_at, updated_at)
             VALUES ('fs_1', 'prj_old', '旧伏笔', 'ch_old', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
          )
          .run()
      ).not.toThrow()
      expect(() =>
        db
          .prepare("UPDATE foreshadow SET status = 'nope' WHERE id = 'fs_1'")
          .run()
      ).toThrow()

      // 旧项目升级后 db.verify() 全绿（PHASE-15 §6）
      const report = verifyDatabase(db, { checkMirror: false })
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(report.ok).toBe(true)
    } finally {
      db.close()
    }
  })

  it('0010 迁移旧项目：revision.branch_id=NULL、摘要表为空、approval_report 增 provider', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const db = newDb(dir.path)
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 9)
      )
      db.prepare(
        `INSERT INTO project (id, title, pov, embedding_model, embedding_dim, default_preset, schema_version, created_at, updated_at)
         VALUES ('prj_old', '旧项目', 'third_limited', 'bge', 512, 'deepseek', 9, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO outline_node (id, project_id, parent_id, kind, ord, title, content, status, created_at, updated_at)
         VALUES ('out_ch', 'prj_old', NULL, 'chapter', 1, '旧章', '', 'locked', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO chapter (id, project_id, outline_node_id, ord, status)
         VALUES ('ch_old', 'prj_old', 'out_ch', 1, 'planned')`
      ).run()
      db.prepare(
        `INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at)
         VALUES ('rev_old', 'ch_old', NULL, 'draft', '${'0'.repeat(64)}', 'author', NULL, '2026-01-01T00:00:00.000Z')`
      ).run()

      const result = migrate(db, MIGRATIONS)
      expect(result.applied).toEqual([10, 11, 12, 13])

      const revision = db.prepare('SELECT branch_id FROM revision WHERE id = ?').get('rev_old') as {
        branch_id: string | null
      }
      expect(revision.branch_id).toBeNull()

      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('revision_branch','chapter_summary') ORDER BY name"
        )
        .all() as Array<{ name: string }>
      expect(tables.map((row) => row.name)).toEqual(['chapter_summary', 'revision_branch'])
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('revision_branch_by_chapter','revision_by_branch','chapter_summary_by_chapter') ORDER BY name"
        )
        .all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toEqual([
        'chapter_summary_by_chapter',
        'revision_branch_by_chapter',
        'revision_by_branch'
      ])

      const summaryCount = db.prepare('SELECT COUNT(*) AS count FROM chapter_summary').get() as { count: number }
      expect(summaryCount.count).toBe(0)

      const reportColumns = (db.prepare('PRAGMA table_info(approval_report)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(reportColumns).toContain('provider')

      const report = verifyDatabase(db, { checkMirror: false })
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(report.ok).toBe(true)
    } finally {
      db.close()
    }
  })

  it('0011 迁移旧项目：tool_call 增 chapter_id，按拍与 job 两条来源回填', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const db = newDb(dir.path)
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 10)
      )
      db.prepare(
        `INSERT INTO project (id, title, pov, embedding_model, embedding_dim, default_preset, schema_version, created_at, updated_at)
         VALUES ('prj_old', '旧项目', 'third_limited', 'bge', 512, 'deepseek', 10, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO outline_node (id, project_id, parent_id, kind, ord, title, content, status, created_at, updated_at)
         VALUES ('out_ch', 'prj_old', NULL, 'chapter', 1, '旧章', '', 'locked', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO chapter (id, project_id, outline_node_id, ord, status)
         VALUES ('ch_old', 'prj_old', 'out_ch', 1, 'drafting')`
      ).run()
      db.prepare(
        `INSERT INTO scene (id, project_id, ord, location, participants_json, goal, exit_json, status, created_at, updated_at)
         VALUES ('scn_old', 'prj_old', 1, '祠堂', '[]', '旧场景', '{}', 'open', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO chapter_scene (chapter_id, scene_id, ord) VALUES ('ch_old', 'scn_old', 1)`
      ).run()
      db.prepare(
        `INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at)
         VALUES ('rev_old', 'ch_old', NULL, 'draft', '${'0'.repeat(64)}', 'doc_controller', NULL, '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO beat (id, chapter_id, scene_id, ord, speaker_type, speaker_id, status, created_revision_id, created_at, updated_at)
         VALUES ('beat_old', 'ch_old', 'scn_old', 1, 'narrator', 'narrator', 'draft', 'rev_old', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      for (const [id, payload] of [
        ['job_beat', '{}'],
        ['job_chapter', JSON.stringify({ chapterId: 'ch_old' })],
        ['job_plan', JSON.stringify({ sessionId: 'sess_1' })]
      ] as const) {
        db.prepare(
          `INSERT INTO job (id, project_id, type, status, epoch, idempotency_key, payload_json, created_at, updated_at)
           VALUES (?, 'prj_old', 'beat.generate', 'succeeded', 0, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
        ).run(id, `key_${id}`, payload)
      }
      db.prepare(
        `INSERT INTO turn_metric (turn_id, project_id, job_id, beat_id, agent_key, provider, model, binding_version, context_json, created_at)
         VALUES ('turn_old', 'prj_old', 'job_beat', 'beat_old', 'narrator', 'deepseek', 'deepseek-flash', 1, '{}', '2026-01-01T00:00:00.000Z')`
      ).run()
      const insertToolCall = db.prepare(
        `INSERT INTO tool_call (id, project_id, job_id, turn_id, tool, tool_version, actor_id, scope_json, args_hash,
                                status, latency_ms, created_at)
         VALUES (?, 'prj_old', ?, ?, 'memory.search_own', '1.0.0', 'narrator', '{}', ?, 'ok', 5, '2026-01-01T00:00:00.000Z')`
      )
      insertToolCall.run('tc_beat', 'job_beat', 'turn_old', 'a'.repeat(64))
      insertToolCall.run('tc_chapter', 'job_chapter', 'turn_chapter', 'b'.repeat(64))
      insertToolCall.run('tc_plan', 'job_plan', 'turn_plan', 'c'.repeat(64))

      const result = migrate(db, MIGRATIONS)
      expect(result.applied).toEqual([11, 12, 13])

      const columns = (db.prepare('PRAGMA table_info(tool_call)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(columns).toContain('chapter_id')

      const rows = db
        .prepare('SELECT id, chapter_id FROM tool_call ORDER BY id')
        .all() as Array<{ id: string; chapter_id: string | null }>
      expect(rows).toEqual([
        { id: 'tc_beat', chapter_id: 'ch_old' },
        { id: 'tc_chapter', chapter_id: 'ch_old' },
        { id: 'tc_plan', chapter_id: null }
      ])

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('tool_by_project','tool_by_chapter') ORDER BY name"
        )
        .all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toEqual(['tool_by_chapter', 'tool_by_project'])

      const report = verifyDatabase(db, { checkMirror: false })
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(report.ok).toBe(true)
    } finally {
      db.close()
    }
  })

  it('0012 迁移旧项目：voice_metric 表与索引存在，唯一键按 scene+revision，删场景级联', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const db = newDb(dir.path)
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 11)
      )
      db.prepare(
        `INSERT INTO project (id, title, pov, embedding_model, embedding_dim, default_preset, schema_version, created_at, updated_at)
         VALUES ('prj_old', '旧项目', 'third_limited', 'bge', 512, 'deepseek', 11, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO outline_node (id, project_id, parent_id, kind, ord, title, content, status, created_at, updated_at)
         VALUES ('out_ch', 'prj_old', NULL, 'chapter', 1, '旧章', '', 'locked', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO chapter (id, project_id, outline_node_id, ord, status)
         VALUES ('ch_old', 'prj_old', 'out_ch', 1, 'drafting')`
      ).run()
      db.prepare(
        `INSERT INTO scene (id, project_id, ord, location, participants_json, goal, exit_json, status, created_at, updated_at)
         VALUES ('scn_old', 'prj_old', 1, '祠堂', '[]', '旧场景', '{}', 'closed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at)
         VALUES ('rev_old', 'ch_old', NULL, 'draft', '${'0'.repeat(64)}', 'doc_controller', NULL, '2026-01-01T00:00:00.000Z')`
      ).run()

      const result = migrate(db, MIGRATIONS)
      expect(result.applied).toEqual([12, 13])

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('voice_metric')")
        .all() as Array<{ name: string }>
      expect(tables.map((row) => row.name)).toEqual(['voice_metric'])
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'voice_metric_by_chapter'")
        .all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toEqual(['voice_metric_by_chapter'])

      const insert = db.prepare(
        `INSERT INTO voice_metric (id, project_id, chapter_id, scene_id, revision_id, metrics_json, threshold_version, created_at)
         VALUES (?, 'prj_old', 'ch_old', 'scn_old', 'rev_old', '{}', 'zh-v1', '2026-01-01T00:00:00.000Z')`
      )
      insert.run('vm_1')
      expect(() => insert.run('vm_2')).toThrow() // UNIQUE(scene_id, revision_id)
      expect(() =>
        db
          .prepare(
            `INSERT INTO voice_metric (id, project_id, chapter_id, scene_id, revision_id, metrics_json, threshold_version, created_at)
             VALUES ('vm_3', 'prj_old', 'ch_old', 'scn_missing', 'rev_old', '{}', 'zh-v1', '2026-01-01T00:00:00.000Z')`
          )
          .run()
      ).toThrow() // 外键：场景必须存在

      db.pragma('foreign_keys = ON')
      db.prepare("DELETE FROM scene WHERE id = 'scn_old'").run()
      const remaining = db.prepare("SELECT COUNT(*) AS count FROM voice_metric").get() as { count: number }
      expect(remaining.count).toBe(0)

      const report = verifyDatabase(db, { checkMirror: false })
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(report.ok).toBe(true)
    } finally {
      db.close()
    }
  })

  it('0013 迁移旧项目：章预算列 + 费用归属列 + 两个索引，beat 指标回填 chapter_id', () => {
    const dir = tempDir()
    cleanups.push(dir.cleanup)
    const db = newDb(dir.path)
    try {
      migrate(
        db,
        MIGRATIONS.filter((migration) => migration.version <= 12)
      )
      db.prepare(
        `INSERT INTO project (id, title, pov, embedding_model, embedding_dim, default_preset, schema_version, created_at, updated_at)
         VALUES ('prj_cost', '旧项目', 'third_limited', 'bge', 512, 'deepseek', 12, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare("UPDATE project SET seq_head = 1 WHERE id = 'prj_cost'").run()
      db.prepare(
        `INSERT INTO outline_node (id, project_id, parent_id, kind, ord, title, content, status, created_at, updated_at)
         VALUES ('out_cost', 'prj_cost', NULL, 'chapter', 1, '旧章', '', 'locked', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO chapter (id, project_id, outline_node_id, ord, status)
         VALUES ('ch_cost', 'prj_cost', 'out_cost', 1, 'drafting')`
      ).run()
      db.prepare(
        `INSERT INTO scene (id, project_id, ord, location, participants_json, goal, exit_json, status, created_at, updated_at)
         VALUES ('scn_cost', 'prj_cost', 1, '祠堂', '[]', '旧场景', '{}', 'closed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO chapter_scene (chapter_id, scene_id, ord) VALUES ('ch_cost', 'scn_cost', 1)`
      ).run()
      db.prepare(
        `INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at)
         VALUES ('rev_cost', 'ch_cost', NULL, 'draft', '${'f'.repeat(64)}', 'doc_controller', NULL, '2026-01-01T00:00:00.000Z')`
      ).run()
      db.prepare(
        `INSERT INTO beat (id, chapter_id, scene_id, ord, seq, speaker_type, speaker_id, intent, body, status,
                           created_revision_id, word_count, created_at, updated_at)
         VALUES ('bt_cost', 'ch_cost', 'scn_cost', 1, 1, 'narrator', 'narrator', '旧拍', '旧正文', 'confirmed',
                 'rev_cost', 5, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
      ).run()
      const insertMetric = db.prepare(
        `INSERT INTO turn_metric (turn_id, project_id, job_id, beat_id, agent_key, provider, model, binding_version,
                                  tokens_in, tokens_out, cost_cny, latency_ms, first_token_ms, context_json, created_at)
         VALUES (?, 'prj_cost', 'job_old', ?, ?, 'deepseek', 'deepseek-flash', 1, 10, 5, 0.001, 10, 5, '{}', '2026-01-01T00:00:00.000Z')`
      )
      insertMetric.run('turn_beat', 'bt_cost', 'narrator')
      insertMetric.run('turn_plan', null, 'planner')

      const result = migrate(db, MIGRATIONS)
      expect(result.applied).toEqual([13])

      const columns = (db.prepare('PRAGMA table_info(chapter)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(columns).toContain('budget_cny')
      const metricColumns = (db.prepare('PRAGMA table_info(turn_metric)').all() as Array<{ name: string }>).map(
        (column) => column.name
      )
      expect(metricColumns).toContain('chapter_id')

      const rows = db
        .prepare('SELECT turn_id, beat_id, chapter_id FROM turn_metric ORDER BY turn_id')
        .all() as Array<{ turn_id: string; beat_id: string | null; chapter_id: string | null }>
      expect(rows).toEqual([
        { turn_id: 'turn_beat', beat_id: 'bt_cost', chapter_id: 'ch_cost' },
        { turn_id: 'turn_plan', beat_id: null, chapter_id: null }
      ])

      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('turn_metric_by_chapter','turn_metric_by_agent') ORDER BY name"
        )
        .all() as Array<{ name: string }>
      expect(indexes.map((row) => row.name)).toEqual(['turn_metric_by_agent', 'turn_metric_by_chapter'])

      // 旧项目预算为 NULL = 默认 ¥5.00；负数被 CHECK 拒绝。
      expect(
        (db.prepare("SELECT budget_cny FROM chapter WHERE id = 'ch_cost'").get() as { budget_cny: number | null })
          .budget_cny
      ).toBeNull()
      db.prepare("UPDATE chapter SET budget_cny = 2.5 WHERE id = 'ch_cost'").run()
      expect(() => db.prepare("UPDATE chapter SET budget_cny = -1 WHERE id = 'ch_cost'").run()).toThrow()

      const report = verifyDatabase(db, { checkMirror: false })
      expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([])
      expect(report.ok).toBe(true)
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
