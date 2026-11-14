import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AppError } from '../../shared/domain/app-error'
import type {
  AppInfo,
  CreateProjectInput,
  CreateProjectResult,
  OpenProjectInput,
  OpenProjectResult,
  ProjectStateEvent,
  ProjectSummary,
  RelocateProjectInput,
  UpdateProjectMetaInput
} from '../../shared/schema/project'
import type { Logger } from '../observability/logger'
import { openDatabase, openDatabaseForMigrate, type Db } from '../db/project-db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../db/migrations'
import { currentVersion, migrate } from '../db/migrator'
import { isLockStale, readLock, startLock, type LockHandle, type LockInfo } from '../lock'
import { projectDbFile, PROJECT_SUBDIRS, resolveProjectDir, validateNewProjectPath } from './paths'
import type { ProjectRegistry, RegistryEntry } from './registry'

interface ProjectRow {
  id: string
  title: string
  genre: string
  pov: 'first' | 'third_limited' | 'third_omniscient'
  target_words: number | null
  setup_state: 'pending' | 'complete' | 'failed'
  schema_version: number
  created_at: string
  updated_at: string
}

interface CurrentProject {
  dir: string
  db: Db
  summary: ProjectSummary
  readOnly: boolean
  readOnlyReason: 'locked' | 'schema_newer' | 'requested' | null
  lock: LockHandle | null
  holder: LockInfo | null
}

export interface ProjectServiceDeps {
  registry: ProjectRegistry
  appVersion: string
  windowId: string
  logger: Logger
  vecExtension: string | null
  emit: (event: ProjectStateEvent) => void
  appInfo: () => AppInfo
}

export class ProjectService {
  private current: CurrentProject | null = null
  private eventSeq = 0

  constructor(private readonly deps: ProjectServiceDeps) {}

  list(): ProjectSummary[] {
    const entries = this.deps.registry.list()
    const seen = new Set<string>()
    const summaries: ProjectSummary[] = []
    for (const entry of entries) {
      if (seen.has(entry.path.toLowerCase())) continue
      seen.add(entry.path.toLowerCase())
      summaries.push(this.summaryFor(entry))
    }
    return summaries
  }

  currentResult(): OpenProjectResult | null {
    const current = this.current
    if (!current) return null
    return {
      project: current.summary,
      readOnly: current.readOnly,
      readOnlyReason: current.readOnlyReason,
      lockHolder: current.holder
        ? {
            pid: current.holder.pid,
            host: current.holder.host,
            appVersion: current.holder.appVersion,
            heartbeatAt: current.holder.heartbeatAt
          }
        : null
    }
  }

  isReadOnly(): boolean {
    return this.current?.readOnly === true
  }

  validatePath(input: { parentDir: string; folderName: string }) {
    return validateNewProjectPath(input)
  }

  create(input: CreateProjectInput): CreateProjectResult {
    const check = validateNewProjectPath({ parentDir: input.parentDir, folderName: input.folderName })
    if (!check.ok) {
      throw new AppError('invalid_args', 'project path is not usable', { errors: check.errors })
    }

    const dir = check.targetPath
    let createdRoot = false
    let created = false
    let db: Db | null = null
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: false })
        createdRoot = true
      }
      for (const sub of PROJECT_SUBDIRS) {
        mkdirSync(join(dir, sub), { recursive: true })
      }

      const file = projectDbFile(dir)
      db = openDatabaseForMigrate(file, this.deps.vecExtension)
      migrate(db, MIGRATIONS)

      const now = new Date().toISOString()
      const projectId = `prj_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      db.prepare(
        `INSERT INTO project (
           id, title, genre, pov, target_words, status, setup_state,
           embedding_model, embedding_dim, default_preset, seq_head, write_epoch,
           schema_version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'active', 'pending', ?, ?, ?, 0, 0, ?, ?, ?)`
      ).run(
        projectId,
        input.title,
        input.genre,
        input.pov,
        input.targetWords,
        'bge-small-zh-v1.5',
        512,
        'deepseek',
        LATEST_SCHEMA_VERSION,
        now,
        now
      )
      db.prepare(
        `INSERT INTO gate_record (id, project_id, gate_id, entity_type, entity_id, decision, actor, payload_json, created_at)
         VALUES (?, ?, 'G0', 'project', ?, 'approve', 'author', ?, ?)`
      ).run(
        `gate_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        projectId,
        projectId,
        JSON.stringify({
          title: input.title,
          genre: input.genre,
          pov: input.pov,
          targetWords: input.targetWords,
          boundaries: input.boundaries,
          path: dir
        }),
        now
      )
      db.close()
      db = null
      created = true

      this.deps.registry.add({
        id: projectId,
        title: input.title,
        path: dir,
        createdAt: now,
        lastOpenedAt: now
      })
      this.deps.logger.info({ event: 'project_created', projectId, path: dir }, 'project created')
    } catch (error) {
      if (db) {
        try {
          db.close()
        } catch {
          // 忽略关闭失败，保留原始错误
        }
      }
      if (createdRoot && !created) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // 回滚失败：目录留给作者手工清理
        }
      }
      if (error instanceof AppError) throw error
      const cause = error instanceof Error ? error.message : String(error)
      throw new AppError('project_create_failed', `failed to create project: ${cause}`, { message: cause })
    }

    const opened = this.open({ path: dir })
    return {
      projectId: opened.project.id,
      path: opened.project.path,
      title: opened.project.title,
      schemaVersion: opened.project.schemaVersion
    }
  }

  open(input: OpenProjectInput): OpenProjectResult {
    const dir = resolveProjectDir(input.path)
    const file = projectDbFile(dir)
    if (!existsSync(file)) {
      throw new AppError('project_not_found', `noryth.db not found under ${dir}`)
    }

    this.closeCurrent()

    const requestedReadOnly = input.readOnly === true
    const holder = readLock(dir)
    const lockHolderLive = holder !== null && !isLockStale(holder)

    let lock: LockHandle | null = null
    let readOnly = requestedReadOnly || lockHolderLive
    let readOnlyReason: CurrentProject['readOnlyReason'] = requestedReadOnly
      ? 'requested'
      : lockHolderLive
        ? 'locked'
        : null

    if (!readOnly) {
      lock = startLock(dir, {
        windowId: this.deps.windowId,
        appVersion: this.deps.appVersion
      })
      if (!lock) {
        readOnly = true
        readOnlyReason = 'locked'
      } else if (holder) {
        this.deps.logger.info({ event: 'lock_recovered', path: dir }, 'stale project lock recovered')
      }
    }

    let db: Db | null = null
    try {
      if (readOnly) {
        db = openDatabase(file, { readonly: true })
      } else {
        db = openDatabaseForMigrate(file, this.deps.vecExtension)
        const version = currentVersion(db)
        if (version > LATEST_SCHEMA_VERSION) {
          db.close()
          lock?.release()
          lock = null
          db = openDatabase(file, { readonly: true })
          readOnly = true
          readOnlyReason = 'schema_newer'
        } else if (version < LATEST_SCHEMA_VERSION) {
          this.backupBeforeMigrate(db, dir, version)
          migrate(db, MIGRATIONS)
          db.prepare('UPDATE project SET schema_version = ?, updated_at = ?').run(
            LATEST_SCHEMA_VERSION,
            new Date().toISOString()
          )
        }
      }

      const row = db.prepare('SELECT * FROM project LIMIT 1').get() as ProjectRow | undefined
      if (!row) {
        throw new AppError('project_not_found', `project row missing in ${file}`)
      }

      const now = new Date().toISOString()
      const entry = this.deps.registry.find(row.id)
      if (entry) {
        this.deps.registry.update(row.id, { path: dir, title: row.title, lastOpenedAt: now })
      } else {
        this.deps.registry.add({
          id: row.id,
          title: row.title,
          path: dir,
          createdAt: row.created_at,
          lastOpenedAt: now
        })
      }

      const summary = this.summaryFromDb(db, row, {
        id: row.id,
        title: row.title,
        path: dir,
        createdAt: row.created_at,
        lastOpenedAt: now
      })

      this.current = {
        dir,
        db,
        summary,
        readOnly,
        readOnlyReason,
        lock,
        holder: readOnly && readOnlyReason === 'locked' ? holder : null
      }

      this.deps.logger.info(
        { event: 'project_opened', projectId: row.id, readOnly, readOnlyReason },
        'project opened'
      )
      this.emitState()

      return this.currentResult()!
    } catch (error) {
      if (db) {
        try {
          db.close()
        } catch {
          // 忽略关闭失败
        }
      }
      lock?.release()
      this.current = null
      if (error instanceof AppError) throw error
      throw new AppError('project_not_found', 'failed to open project', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  close(projectId: string): boolean {
    if (!this.current || this.current.summary.id !== projectId) return false
    this.closeCurrent()
    return true
  }

  removeFromList(projectId: string): boolean {
    if (this.current?.summary.id === projectId) {
      this.closeCurrent()
    }
    return this.deps.registry.remove(projectId)
  }

  relocate(input: RelocateProjectInput): { path: string } {
    const dir = resolveProjectDir(input.path)
    const file = projectDbFile(dir)
    if (!existsSync(file)) {
      throw new AppError('project_not_found', `noryth.db not found under ${dir}`)
    }
    const db = openDatabase(file, { readonly: true })
    const row = db.prepare('SELECT id FROM project LIMIT 1').get() as { id?: string } | undefined
    db.close()
    const projectId = row?.id ?? ''
    if (projectId !== input.projectId) {
      throw new AppError('invalid_args', 'relocated path points to a different project', {
        expected: input.projectId,
        actual: projectId
      })
    }
    this.deps.registry.update(input.projectId, { path: dir })
    if (this.current?.summary.id === input.projectId) {
      this.closeCurrent()
      this.open({ path: dir })
    }
    return { path: dir }
  }

  updateMeta(input: UpdateProjectMetaInput): ProjectSummary {
    const current = this.current
    if (!current || current.summary.id !== input.projectId) {
      throw new AppError('invalid_args', 'project is not open in this window')
    }
    if (current.readOnly) {
      throw new AppError('project_locked', 'project is read-only')
    }
    const fields: string[] = []
    const values: Array<string | number | null> = []
    if (input.title !== undefined) {
      fields.push('title = ?')
      values.push(input.title)
    }
    if (input.genre !== undefined) {
      fields.push('genre = ?')
      values.push(input.genre)
    }
    if (input.targetWords !== undefined) {
      fields.push('target_words = ?')
      values.push(input.targetWords)
    }
    if (fields.length === 0) return current.summary
    fields.push('updated_at = ?')
    values.push(new Date().toISOString())
    current.db.prepare(`UPDATE project SET ${fields.join(', ')}`).run(...values)

    const row = current.db.prepare('SELECT * FROM project LIMIT 1').get() as ProjectRow
    const entry = this.deps.registry.find(input.projectId)
    current.summary = this.summaryFromDb(current.db, row, entry ?? {
      id: row.id,
      title: row.title,
      path: current.dir,
      createdAt: row.created_at,
      lastOpenedAt: null
    })
    if (entry) this.deps.registry.update(input.projectId, { title: row.title })
    this.emitState()
    return current.summary
  }

  dispose(): void {
    this.closeCurrent()
  }

  private closeCurrent(): void {
    const current = this.current
    if (!current) return
    this.current = null
    try {
      current.db.close()
    } catch {
      // 关闭失败不阻塞退出
    }
    current.lock?.release()
  }

  private backupBeforeMigrate(db: Db, dir: string, fromVersion: number): void {
    const backupsDir = join(dir, 'backups')
    mkdirSync(backupsDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(backupsDir, `pre-migrate-v${fromVersion}-${stamp}.db`).replace(/'/g, "''")
    db.exec(`VACUUM INTO '${target}'`)
    this.deps.logger.info({ event: 'pre_migrate_backup', path: target, fromVersion }, 'backup created')
  }

  private summaryFor(entry: RegistryEntry): ProjectSummary {
    const dir = resolve(entry.path)
    const file = projectDbFile(dir)
    if (!existsSync(file)) {
      return {
        id: entry.id,
        title: entry.title,
        path: dir,
        genre: '',
        pov: 'third_limited',
        targetWords: null,
        setupState: 'pending',
        schemaVersion: 0,
        chapterCount: 0,
        wordCount: 0,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        lastOpenedAt: entry.lastOpenedAt,
        available: false
      }
    }
    try {
      const db = openDatabase(file, { readonly: true })
      try {
        const row = db.prepare('SELECT * FROM project LIMIT 1').get() as ProjectRow | undefined
        if (!row) throw new Error('project row missing')
        return this.summaryFromDb(db, row, entry)
      } finally {
        db.close()
      }
    } catch {
      return {
        id: entry.id,
        title: entry.title,
        path: dir,
        genre: '',
        pov: 'third_limited',
        targetWords: null,
        setupState: 'pending',
        schemaVersion: 0,
        chapterCount: 0,
        wordCount: 0,
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        lastOpenedAt: entry.lastOpenedAt,
        available: false
      }
    }
  }

  private summaryFromDb(db: Db, row: ProjectRow, entry: RegistryEntry): ProjectSummary {
    const chapterRow = db
      .prepare("SELECT COUNT(*) AS count FROM chapter WHERE status = 'finalized'")
      .get() as { count: number }
    const wordRow = db
      .prepare(
        `SELECT COALESCE(SUM(b.word_count), 0) AS words
         FROM beat b JOIN chapter c ON c.id = b.chapter_id
         WHERE c.status = 'finalized'`
      )
      .get() as { words: number }
    return {
      id: row.id,
      title: row.title,
      path: entry.path,
      genre: row.genre,
      pov: row.pov,
      targetWords: row.target_words,
      setupState: row.setup_state,
      schemaVersion: row.schema_version,
      chapterCount: chapterRow.count,
      wordCount: wordRow.words,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastOpenedAt: entry.lastOpenedAt,
      available: true
    }
  }

  private emitState(): void {
    const current = this.current
    if (!current) return
    this.eventSeq += 1
    this.deps.emit({
      projectId: current.summary.id,
      readOnly: current.readOnly,
      setupState: current.summary.setupState,
      schemaVersion: current.summary.schemaVersion,
      seq: this.eventSeq,
      jobId: ''
    })
  }
}

// 供测试与诊断使用：项目子目录清单（保持与创建流程一致）
export function projectSubdirs(): string[] {
  return [...PROJECT_SUBDIRS]
}

export function projectDirectoryLooksEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true
  return statSync(dir).isDirectory() && readdirSync(dir).length === 0
}
