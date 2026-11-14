import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * 正文清单的规范形式（DEV-PLAN §5.4，PHASE-02 §5.2 固定下来）：
 *
 *   for each scene in chapter_scene.ord order:
 *     "## scene:<scene_id>\n"
 *     for each beat in beat.ord order:
 *       "<speaker_type>:<speaker_id>\n<body>\n\n"
 *
 * 说明：
 * - 行尾统一 LF；正文里的 CRLF 先归一化，避免 Windows/macOS 双跑 hash 漂移。
 * - scene 头按 DEV-PLAN §5.4 保留 scene_id：两个场景文本完全相同时，交换场景仍会改变 hash；
 *   PHASE-02 §5.2 的拼接顺序与这里一致，只是没写出 scene 头。
 * - 函数**不排序**：调用方必须按 (sceneOrd, beatOrd) 传入；换顺序 hash 必须变化。
 */
export interface ManifestRow {
  sceneId: string
  sceneOrd: number
  beatOrd: number
  speakerType: 'character' | 'narrator'
  speakerId: string
  body: string
}

export function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n')
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hashText(text: string): string {
  return sha256Hex(text)
}

/** 磁盘文件按原始字节计算；镜像发布与外部改动检测都用它。 */
export function hashFile(file: string): string {
  return sha256Hex(readFileSync(file))
}

export function hashManifestRows(rows: readonly ManifestRow[]): string {
  let payload = ''
  let currentScene: string | null = null
  for (const row of rows) {
    if (row.sceneId !== currentScene) {
      payload += `## scene:${row.sceneId}\n`
      currentScene = row.sceneId
    }
    payload += `${row.speakerType}:${row.speakerId}\n${normalizeBody(row.body)}\n\n`
  }
  return sha256Hex(payload)
}
