import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppInfo, ProjectSummary } from '../../shared/schema/project'
import { buildZip, type ZipEntry } from './zip'

export interface DiagnosticsInput {
  userDataDir: string
  appInfo: AppInfo
  settings: unknown
  projects: ProjectSummary[]
  logPath: string | null
}

/** 诊断包里的任务摘要：只有状态与错误码，不含 payload / 正文。 */
export interface DiagnosticsJobSummary {
  id: string
  type: string
  status: string
  errorCode: string | null
  createdAt: string
  updatedAt: string
}

export interface DiagnosticsExtras {
  /** 当前打开项目：标题、verify 报告（结构问题清单，不含正文）。 */
  projectTitle?: string | null
  schemaVersion?: number
  jobs?: DiagnosticsJobSummary[]
  verify?: unknown
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9_-]{10,}/g, '[redacted-key]'],
  [/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]'],
  [/(authorization["']?\s*[:=]\s*["']?)[^"',\n]+/gi, '$1[redacted]'],
  [/(api[_-]?key["']?\s*[:=]\s*["']?)[^"',\n]+/gi, '$1[redacted]']
]

export function scrubSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)
}

function readLogTail(file: string | null, maxBytes = 200_000): string[] {
  if (!file || !existsSync(file)) return []
  try {
    const size = statSync(file).size
    const raw = readFileSync(file, 'utf8')
    const slice = size > maxBytes ? raw.slice(-maxBytes) : raw
    return slice.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-400)
  } catch {
    return []
  }
}

/**
 * 诊断包内容（PHASE-11 M1-24）：
 * - 应用版本 / schema 版本 / 平台；
 * - 项目摘要（只有 id、标题、路径、章数、字数）；
 * - 当前项目最近任务摘要（状态与错误码，不含 payload）；
 * - verify 报告（结构问题清单，不含正文）；
 * - 日志尾部。
 *
 * 明确排除：正文、`secrets.bin`、任何 Key、`exports/`、`backups/`。
 * 所有文本导出前统一过一遍 scrubSecrets，作为第二道闸。
 */
export function buildDiagnosticsBundle(
  input: DiagnosticsInput,
  extras: DiagnosticsExtras = {}
): { json: string; logTail: string; readme: string } {
  const logs = readLogTail(input.logPath)
  const bundle = {
    generatedAt: new Date().toISOString(),
    app: input.appInfo,
    schemaVersion: extras.schemaVersion ?? input.appInfo.schemaVersion,
    project: extras.projectTitle
      ? {
          title: extras.projectTitle,
          jobs: extras.jobs ?? [],
          verify: extras.verify ?? null
        }
      : null,
    settings: input.settings,
    projects: input.projects.map((project) => ({
      id: project.id,
      title: project.title,
      path: project.path,
      schemaVersion: project.schemaVersion,
      setupState: project.setupState,
      available: project.available,
      chapterCount: project.chapterCount,
      wordCount: project.wordCount
    })),
    // 日志同时进 JSON 与 logs/app.log：单独把 diagnostics.json 发给别人也能排查。
    logs,
    logLines: logs.length
  }

  const readme = [
    'Noryth 诊断包',
    '',
    'diagnostics.json  应用、项目与任务摘要（无正文、无 API Key）',
    'logs/app.log      应用日志尾部（已脱敏）',
    '',
    '不包含：正文、secrets.bin、API Key、exports/、backups/。',
    '排查问题只需要这个 zip；不要手工加入项目数据库或正文文件。'
  ].join('\n')

  return {
    json: scrubSecrets(JSON.stringify(bundle, null, 2)),
    logTail: scrubSecrets(logs.join('\n')),
    readme
  }
}

/** 兼容旧调用（单元测试与诊断预览）：写一个 JSON 到 userData/diagnostics。 */
export function exportDiagnostics(input: DiagnosticsInput, extras: DiagnosticsExtras = {}): string {
  const dir = join(input.userDataDir, 'diagnostics')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `noryth-diagnostics-${stamp}.json`)
  writeFileSync(target, buildDiagnosticsBundle(input, extras).json, 'utf8')
  return target
}

export interface DiagnosticsZipResult {
  path: string
  bytes: number
  entries: string[]
}

/**
 * 导出 zip。`targetPath` 由调用方决定（保存对话框或 E2E 显式路径）；
 * 目录不存在就建，同名文件覆盖（作者已在对话框里确认过路径）。
 */
export function exportDiagnosticsZip(
  input: DiagnosticsInput,
  targetPath: string,
  extras: DiagnosticsExtras = {}
): DiagnosticsZipResult {
  const bundle = buildDiagnosticsBundle(input, extras)
  const entries: ZipEntry[] = [
    { name: 'README.txt', data: Buffer.from(bundle.readme, 'utf8') },
    { name: 'diagnostics.json', data: Buffer.from(bundle.json, 'utf8') }
  ]
  if (bundle.logTail.length > 0) {
    entries.push({ name: 'logs/app.log', data: Buffer.from(bundle.logTail, 'utf8') })
  }
  const zip = buildZip(entries)
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, zip)
  return { path: targetPath, bytes: zip.length, entries: entries.map((entry) => entry.name) }
}

/** 默认文件名：noryth-diagnostics-<YYYY-MM-DD>.zip。 */
export function defaultDiagnosticsName(date: Date = new Date()): string {
  return `noryth-diagnostics-${date.toISOString().slice(0, 10)}.zip`
}
