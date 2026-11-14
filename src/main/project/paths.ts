import { accessSync, constants, existsSync, readdirSync, statSync, statfsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { PathCheck, ValidatePathInput } from '../../shared/schema/project'

export const PROJECT_SUBDIRS = ['manuscript', 'assets', 'exports', 'backups', 'logs'] as const
export const MIN_FREE_BYTES = 200 * 1024 * 1024
export const MAX_PROJECT_PATH = 180

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
// eslint-disable-next-line no-control-regex -- Windows 文件名不允许的控制字符
const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/
const SYNC_DRIVE = /(onedrive|dropbox|google drive|icloud|nutstore|坚果云|百度网盘|微云)/i

export function resolveProjectDir(input: string): string {
  const absolute = resolve(input)
  return basename(absolute).toLowerCase() === 'noryth.db' ? dirname(absolute) : absolute
}

export function projectDbFile(projectDir: string): string {
  return join(projectDir, 'noryth.db')
}

/** 新建项目的位置校验（UI-DESIGN §3.3 / PHASE-01 §5.5）。 */
export function validateNewProjectPath(input: ValidatePathInput): PathCheck {
  const errors: string[] = []
  const warnings: string[] = []
  const folderName = input.folderName.trim()
  const parentDir = resolve(input.parentDir)
  const targetPath = join(parentDir, folderName)

  if (folderName.length === 0) errors.push('文件夹名不能为空')
  if (folderName === '.' || folderName === '..') errors.push('文件夹名不合法')
  if (INVALID_NAME_CHARS.test(folderName)) errors.push('文件夹名不能包含 < > : " / \\ | ? *')
  if (/[ .]$/.test(folderName)) errors.push('文件夹名不能以空格或句点结尾')
  if (WINDOWS_RESERVED.test(folderName)) errors.push('该名称是 Windows 保留名')
  if (targetPath.length >= MAX_PROJECT_PATH) errors.push(`路径过长（${targetPath.length} ≥ ${MAX_PROJECT_PATH}）`)

  if (!existsSync(parentDir) || !statSync(parentDir).isDirectory()) {
    errors.push('父目录不存在')
  } else {
    try {
      accessSync(parentDir, constants.W_OK)
    } catch {
      errors.push('父目录不可写')
    }
  }

  if (existsSync(targetPath)) {
    if (!statSync(targetPath).isDirectory()) {
      errors.push('目标路径已存在且不是文件夹')
    } else if (readdirSync(targetPath).length > 0) {
      errors.push('目标文件夹不是空的')
    }
  }

  let freeBytes = 0
  try {
    const stats = statfsSync(parentDir)
    freeBytes = stats.bavail * stats.bsize
    if (freeBytes < MIN_FREE_BYTES) errors.push('磁盘可用空间不足 200MB')
  } catch {
    warnings.push('无法读取磁盘剩余空间')
  }

  if (SYNC_DRIVE.test(targetPath)) {
    warnings.push('检测到同步盘：SQLite WAL 与同步冲突会导致 file_conflict，建议放在本地目录')
  }

  return { ok: errors.length === 0, targetPath, errors, warnings, freeBytes }
}
