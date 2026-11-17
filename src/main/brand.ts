import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 品牌资源定位（PHASE-18 M1-25）。
 *
 * 安装包/exe/任务栏图标由 electron-builder 用 `resources/icon.ico` 嵌入（M1-25）；
 * 运行时窗口图标用 PNG：
 * - 打包后：`process.resourcesPath/icons/noryth-256.png`（extraResources）
 * - 开发时：`<repo>/resources/icons/noryth-256.png`
 *
 * 只读路径解析，不创建、不下载；文件缺失时返回候选路径，Windows 会退回 exe 图标。
 */

export const APP_ICON_FILE = 'noryth-256.png'

/** 纯函数：图标优先路径（单测直接覆盖，不依赖 Electron 运行时）。 */
export function appIconCandidates(input: {
  packaged: boolean
  resourcesPath: string
  repoRoot: string
}): string[] {
  if (input.packaged) return [join(input.resourcesPath, 'icons', APP_ICON_FILE)]
  return [join(input.repoRoot, 'resources', 'icons', APP_ICON_FILE)]
}

/** 应用入口使用：按运行形态选一个存在的路径。 */
export function resolveAppIcon(repoRoot: string = process.cwd()): string {
  const candidates = appIconCandidates({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot
  })
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!
}
