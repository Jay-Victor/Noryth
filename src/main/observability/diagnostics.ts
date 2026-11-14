import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppInfo, ProjectSummary } from '../../shared/schema/project'

export interface DiagnosticsInput {
  userDataDir: string
  appInfo: AppInfo
  settings: unknown
  projects: ProjectSummary[]
  logPath: string | null
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
 * 诊断包：日志尾部 + 应用/项目元数据。
 * 不含正文、不含 API Key；导出前统一过一遍 scrubSecrets。
 */
export function exportDiagnostics(input: DiagnosticsInput): string {
  const dir = join(input.userDataDir, 'diagnostics')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `noryth-diagnostics-${stamp}.json`)

  const bundle = {
    generatedAt: new Date().toISOString(),
    app: input.appInfo,
    settings: input.settings,
    projects: input.projects.map((project) => ({
      id: project.id,
      title: project.title,
      path: project.path,
      schemaVersion: project.schemaVersion,
      setupState: project.setupState,
      available: project.available
    })),
    logs: readLogTail(input.logPath)
  }

  const text = scrubSecrets(JSON.stringify(bundle, null, 2))
  writeFileSync(target, text, 'utf8')
  return target
}
