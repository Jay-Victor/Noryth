import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AppError } from '../../shared/domain/app-error'
import { openDatabase, type Db } from './project-db'
import { currentVersion, migrate } from './migrator'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations'
import { sqlString, systemClock, type Clock } from './repos/common'
import { ProjectRepo } from './repos/project'
import { verifyDatabase, type VerifyReport } from './verify'
import { PROJECT_SUBDIRS } from '../project/paths'

/** 一致性快照：不用文件复制（WAL 未 checkpoint 时会拿到半状态）。 */
export function vacuumInto(db: Db, targetFile: string): void {
  mkdirSync(dirname(targetFile), { recursive: true })
  db.exec(`VACUUM INTO ${sqlString(targetFile)}`)
}

export function localDateStamp(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface CheckpointResult {
  path: string
  bytes: number
  createdAt: string
}

export interface CheckpointOptions {
  /** 默认 true：备份前跑 db.verify()，error 时拒绝备份。 */
  verify?: boolean
  now?: Clock
}

/** 每章定稿后：backups/checkpoint-<seq>.db（DEV-PLAN §5.9）。 */
export function createCheckpoint(
  db: Db,
  projectDir: string,
  seq: number,
  options: CheckpointOptions = {}
): CheckpointResult {
  if (options.verify !== false) {
    const report = verifyDatabase(db, { projectDir })
    if (!report.ok) {
      throw new AppError('internal_error', 'db.verify() failed before checkpoint', report)
    }
  }
  const dir = join(projectDir, 'backups')
  mkdirSync(dir, { recursive: true })
  const target = join(dir, `checkpoint-${seq}.db`)
  if (existsSync(target)) rmSync(target, { force: true })
  vacuumInto(db, target)
  return {
    path: target,
    bytes: statSync(target).size,
    createdAt: (options.now ?? systemClock)()
  }
}

export interface DailyBackupResult {
  created: boolean
  path: string
}

const COPY_EXCLUDES = new Set([
  'noryth.db',
  'noryth.db-wal',
  'noryth.db-shm',
  '.noryth.lock',
  'backups'
])

/**
 * 逐项复制项目内容，跳过 backups/ 自身与 DB/WAL/lock。
 * 不能直接 cpSync(projectDir, target)：目标在 backups/ 里，Node 会拒绝复制到自身子目录。
 */
function copyProjectContents(projectDir: string, targetDir: string): void {
  for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
    if (COPY_EXCLUDES.has(entry.name)) continue
    cpSync(join(projectDir, entry.name), join(targetDir, entry.name), { recursive: true })
  }
}

/**
 * 每日首次打开：复制项目文件夹到 backups/daily-<yyyy-mm-dd>/，排除 backups/ 自身。
 * DB 用 VACUUM INTO 生成一致快照，其余文件直接复制。
 */
export function createDailyBackup(
  db: Db,
  projectDir: string,
  options: { date?: string } = {}
): DailyBackupResult {
  const stamp = options.date ?? localDateStamp()
  const dir = join(projectDir, 'backups')
  const target = join(dir, `daily-${stamp}`)
  if (existsSync(join(target, 'noryth.db'))) {
    return { created: false, path: target }
  }
  if (existsSync(target)) {
    // 上次中断留下的半成品（没有 noryth.db）：整体重来。
    rmSync(target, { recursive: true, force: true })
  }
  mkdirSync(dir, { recursive: true })
  mkdirSync(target, { recursive: true })
  copyProjectContents(projectDir, target)
  vacuumInto(db, join(target, 'noryth.db'))
  return { created: true, path: target }
}

export interface BackupListing {
  checkpoints: Array<{ path: string; seq: number }>
  dailies: Array<{ path: string; date: string }>
}

export function listBackups(projectDir: string): BackupListing {
  const dir = join(projectDir, 'backups')
  const listing: BackupListing = { checkpoints: [], dailies: [] }
  if (!existsSync(dir)) return listing
  for (const entry of readdirSync(dir)) {
    const checkpoint = /^checkpoint-(\d+)\.db$/.exec(entry)
    if (checkpoint) {
      listing.checkpoints.push({ path: join(dir, entry), seq: Number(checkpoint[1]) })
      continue
    }
    const daily = /^daily-(\d{4}-\d{2}-\d{2})$/.exec(entry)
    if (daily) listing.dailies.push({ path: join(dir, entry), date: daily[1]! })
  }
  listing.checkpoints.sort((a, b) => a.seq - b.seq)
  listing.dailies.sort((a, b) => a.date.localeCompare(b.date))
  return listing
}

export interface PruneOptions {
  keepCheckpoints?: number
  keepDailies?: number
}

/** 默认保留 10 个检查点 + 7 个日备份（DEV-PLAN §5.9）。 */
export function pruneBackups(projectDir: string, options: PruneOptions = {}): string[] {
  const keepCheckpoints = options.keepCheckpoints ?? 10
  const keepDailies = options.keepDailies ?? 7
  const listing = listBackups(projectDir)
  const removed: string[] = []
  for (const item of listing.checkpoints.slice(0, Math.max(0, listing.checkpoints.length - keepCheckpoints))) {
    rmSync(item.path, { force: true })
    removed.push(item.path)
  }
  for (const item of listing.dailies.slice(0, Math.max(0, listing.dailies.length - keepDailies))) {
    rmSync(item.path, { recursive: true, force: true })
    removed.push(item.path)
  }
  return removed
}

export interface RestoreOptions {
  /** checkpoint 的 .db 文件，或 daily-日期 备份目录。 */
  source: string
  targetDir: string
  vecExtension?: string | null
  now?: Clock
}

export interface RestoreResult {
  path: string
  report: VerifyReport
}

function assertTargetEmpty(targetDir: string): void {
  if (!existsSync(targetDir)) return
  if (!statSync(targetDir).isDirectory() || readdirSync(targetDir).length > 0) {
    throw new AppError('invalid_args', `restore target is not empty: ${targetDir}`)
  }
}

/**
 * 恢复到新目录（DEV-PLAN §5.9）：
 * 1. 打开备份 → integrity_check + schema_version 校验；
 * 2. daily 目录先复制非 DB 文件（manuscript 等）；
 * 3. VACUUM INTO 复制成新的 noryth.db；
 * 4. 打开新库跑 db.verify()，返回报告。
 * 不覆盖任何现有项目目录。
 */
export function restoreBackupToDirectory(options: RestoreOptions): RestoreResult {
  const sourceIsDirectory = statSync(options.source).isDirectory()
  const sourceDb = sourceIsDirectory ? join(options.source, 'noryth.db') : options.source
  if (!existsSync(sourceDb)) {
    throw new AppError('invalid_args', `backup database not found: ${sourceDb}`)
  }
  assertTargetEmpty(options.targetDir)

  const source = openDatabase(sourceDb, { readonly: true, vecExtension: options.vecExtension ?? null })
  try {
    const integrity = source.pragma('integrity_check', { simple: true }) as string
    if (integrity !== 'ok') {
      throw new AppError('invalid_args', `backup integrity_check failed: ${integrity}`, { source: sourceDb })
    }
    const version = currentVersion(source)
    if (version > LATEST_SCHEMA_VERSION) {
      throw new AppError('invalid_args', `backup schema ${version} is newer than app ${LATEST_SCHEMA_VERSION}`, {
        source: sourceDb
      })
    }

    mkdirSync(options.targetDir, { recursive: true })
    for (const sub of PROJECT_SUBDIRS) mkdirSync(join(options.targetDir, sub), { recursive: true })
    if (sourceIsDirectory) {
      copyProjectContents(options.source, options.targetDir)
    }
    vacuumInto(source, join(options.targetDir, 'noryth.db'))
  } finally {
    source.close()
  }

  const targetFile = join(options.targetDir, 'noryth.db')
  const target = openDatabase(targetFile, { vecExtension: options.vecExtension ?? null })
  try {
    if (currentVersion(target) < LATEST_SCHEMA_VERSION) {
      // 旧备份（例如阶段 01 的 schema 1）恢复到新目录后先升级，再校验。
      migrate(target, MIGRATIONS)
      const projectRepo = new ProjectRepo(target)
      const project = projectRepo.get()
      if (project) projectRepo.setSchemaVersion(project.id, LATEST_SCHEMA_VERSION)
    }
    const report = verifyDatabase(target, { projectDir: options.targetDir, now: options.now })
    return { path: targetFile, report }
  } finally {
    target.close()
  }
}
