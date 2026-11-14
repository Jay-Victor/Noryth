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
import { createRepos, type Repos } from '../db/repos'
import { vacuumInto } from '../db/backup'
import { withTransaction } from '../db/tx'
import { verifyDatabase, writeVerifyReport, type VerifyReport } from '../db/verify'
import { isLockStale, readLock, startLock, type LockHandle, type LockInfo } from '../lock'
import { recoverInterrupted } from '../doc/recovery'
import { publishPendingMirrors } from '../doc/publish'
import { projectDbFile, PROJECT_SUBDIRS, resolveProjectDir, validateNewProjectPath } from './paths'
import type { ProjectRegistry, RegistryEntry } from './registry'

interface CurrentProject {
  dir: string
  db: Db
  repos: Repos
  summary: ProjectSummary
  readOnly: boolean
  readOnlyReason: 'locked' | 'schema_newer' | 'requested' | null
  lock: LockHandle | null
  holder: LockInfo | null
  verify: VerifyReport | null
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

      const repos = createRepos(db)
      const now = new Date().toISOString()
      const project = withTransaction(db, () => {
        const created = repos.project.create({
          title: input.title,
          genre: input.genre,
          pov: input.pov,
          targetWords: input.targetWords,
          setupState: 'pending',
          embeddingModel: 'bge-small-zh-v1.5',
          embeddingDim: 512,
          defaultPreset: 'deepseek',
          schemaVersion: LATEST_SCHEMA_VERSION,
          createdAt: now,
          updatedAt: now
        })
        repos.gate.insert({
          projectId: created.id,
          gateId: 'G0',
          entityType: 'project',
          entityId: created.id,
          decision: 'approve',
          actor: 'author',
          payloadJson: JSON.stringify({
            title: input.title,
            genre: input.genre,
            pov: input.pov,
            targetWords: input.targetWords,
            boundaries: input.boundaries,
            path: dir
          }),
          createdAt: now
        })
        return created
      })
      db.close()
      db = null
      created = true

      this.deps.registry.add({
        id: project.id,
        title: project.title,
        path: dir,
        createdAt: now,
        lastOpenedAt: now
      })
      this.deps.logger.info({ event: 'project_created', projectId: project.id, path: dir }, 'project created')
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
      let migratedFrom: number | null = null
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
          migratedFrom = version
        }
      }

      const repos = createRepos(db)
      const project = repos.project.get()
      if (!project) {
        throw new AppError('project_not_found', `project row missing in ${file}`)
      }
      if (migratedFrom !== null) {
        repos.project.setSchemaVersion(project.id, LATEST_SCHEMA_VERSION)
      }

      if (!readOnly) {
        this.recoverAfterCrash(repos, db, dir, project.id)
      }

      const now = new Date().toISOString()
      const entry = this.deps.registry.find(project.id)
      if (entry) {
        this.deps.registry.update(project.id, { path: dir, title: project.title, lastOpenedAt: now })
      } else {
        this.deps.registry.add({
          id: project.id,
          title: project.title,
          path: dir,
          createdAt: project.createdAt,
          lastOpenedAt: now
        })
      }

      const summary = this.summaryFromDb(repos, {
        id: project.id,
        title: project.title,
        path: dir,
        createdAt: project.createdAt,
        lastOpenedAt: now
      })

      const verifyReport = verifyDatabase(db, { projectDir: dir })
      if (!verifyReport.ok) {
        this.deps.logger.error(
          {
            event: 'project_verify_failed',
            projectId: project.id,
            issues: verifyReport.issues.filter((issue) => issue.severity === 'error')
          },
          'project verification failed'
        )
      } else if (verifyReport.issues.length > 0) {
        this.deps.logger.warn(
          { event: 'project_verify_warnings', projectId: project.id, issues: verifyReport.issues },
          'project verification warnings'
        )
      }
      if (verifyReport.issues.length > 0) {
        try {
          writeVerifyReport(dir, verifyReport)
        } catch (error) {
          this.deps.logger.warn(
            { event: 'verify_report_write_failed', error: error instanceof Error ? error.message : String(error) },
            'failed to write verify report'
          )
        }
      }

      this.current = {
        dir,
        db,
        repos,
        summary,
        readOnly,
        readOnlyReason,
        lock,
        holder: readOnly && readOnlyReason === 'locked' ? holder : null,
        verify: verifyReport
      }

      this.deps.logger.info(
        { event: 'project_opened', projectId: project.id, readOnly, readOnlyReason },
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
    const project = createRepos(db).project.get()
    db.close()
    const projectId = project?.id ?? ''
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
    current.repos.project.updateMeta(input.projectId, {
      title: input.title,
      genre: input.genre,
      targetWords: input.targetWords
    })

    const entry = this.deps.registry.find(input.projectId)
    const project = current.repos.project.get()
    if (!project) {
      throw new AppError('project_not_found', 'project row missing after update')
    }
    current.summary = this.summaryFromDb(
      current.repos,
      entry ?? {
        id: project.id,
        title: project.title,
        path: current.dir,
        createdAt: project.createdAt,
        lastOpenedAt: null
      }
    )
    if (entry) this.deps.registry.update(input.projectId, { title: project.title })
    this.emitState()
    return current.summary
  }

  /** 只读的 DB 校验入口；打开项目时已自动跑过一次。 */
  verifyCurrent(): VerifyReport | null {
    const current = this.current
    if (!current) return null
    const report = verifyDatabase(current.db, { projectDir: current.dir })
    current.verify = report
    return report
  }

  /**
   * 规划台 G1/建库重试后调用：重读 project 摘要并广播 setupState。
   * 不重开数据库、不触碰锁；失败只记日志。
   */
  refreshState(): ProjectSummary | null {
    const current = this.current
    if (!current) return null
    try {
      const entry = this.deps.registry.find(current.summary.id)
      current.summary = this.summaryFromDb(
        current.repos,
        entry ?? {
          id: current.summary.id,
          title: current.summary.title,
          path: current.dir,
          createdAt: current.summary.createdAt,
          lastOpenedAt: current.summary.lastOpenedAt
        }
      )
      this.emitState()
      return current.summary
    } catch (error) {
      this.deps.logger.warn(
        { event: 'project_state_refresh_failed', error: error instanceof Error ? error.message : String(error) },
        'failed to refresh project state'
      )
      return null
    }
  }

  /** 切片/主进程服务读取当前连接；外部不得长期持有。 */
  currentHandle(): { dir: string; db: Db; repos: Repos; readOnly: boolean } | null {
    const current = this.current
    if (!current) return null
    return { dir: current.dir, db: current.db, repos: current.repos, readOnly: current.readOnly }
  }

  /**
   * 启动恢复（PRD §9.4 / §6.6）：
   * running job 与 generating 拍标 interrupted；outbox 未发布行按退避重试。
   * 两者都不阻塞打开——失败只记日志，项目仍可只读/编辑。
   */
  private recoverAfterCrash(repos: Repos, db: Db, dir: string, projectId: string): void {
    try {
      const recovery = recoverInterrupted(repos)
      if (recovery.jobs.length > 0 || recovery.beats.length > 0) {
        this.deps.logger.warn(
          {
            event: 'crash_recovery',
            projectId,
            jobs: recovery.jobs.length,
            beats: recovery.beats.length
          },
          'interrupted jobs/beats marked for retry'
        )
      }
    } catch (error) {
      this.deps.logger.warn(
        {
          event: 'crash_recovery_failed',
          projectId,
          error: error instanceof Error ? error.message : String(error)
        },
        'crash recovery failed'
      )
    }

    try {
      const report = publishPendingMirrors(db, dir)
      if (report.published.length > 0 || report.failed.length > 0 || report.conflicts.length > 0) {
        this.deps.logger.info(
          {
            event: 'outbox_recovery',
            projectId,
            published: report.published.length,
            skipped: report.skipped.length,
            failed: report.failed.length,
            conflicts: report.conflicts.length
          },
          'pending mirrors processed'
        )
      }
    } catch (error) {
      this.deps.logger.warn(
        {
          event: 'outbox_recovery_failed',
          projectId,
          error: error instanceof Error ? error.message : String(error)
        },
        'outbox recovery failed'
      )
    }
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
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(dir, 'backups', `pre-migrate-v${fromVersion}-${stamp}.db`)
    vacuumInto(db, target)
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
        const repos = createRepos(db)
        const project = repos.project.get()
        if (!project) throw new Error('project row missing')
        return this.summaryFromDb(repos, entry)
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

  private summaryFromDb(repos: Repos, entry: RegistryEntry): ProjectSummary {
    const project = repos.project.get()
    if (!project) {
      throw new AppError('project_not_found', 'project row missing')
    }
    return {
      id: project.id,
      title: project.title,
      path: entry.path,
      genre: project.genre,
      pov: project.pov,
      targetWords: project.targetWords,
      setupState: project.setupState,
      schemaVersion: project.schemaVersion,
      chapterCount: repos.project.finalizedChapterCount(),
      wordCount: repos.project.finalizedWordCount(),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
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
