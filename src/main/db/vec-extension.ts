import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * sqlite-vec 的 loadable extension 路径：
 * - 开发：<repo>/resources/native/vec0.dll（scripts/prepare-native.mjs 复制）
 * - 打包：<resources>/native/vec0.dll（electron-builder extraResources）
 */
export function resolveVecExtension(repoRoot?: string): string | null {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, 'native', 'vec0.dll'))
  }
  candidates.push(join(repoRoot ?? app.getAppPath(), 'resources', 'native', 'vec0.dll'))
  candidates.push(join(process.cwd(), 'resources', 'native', 'vec0.dll'))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}
