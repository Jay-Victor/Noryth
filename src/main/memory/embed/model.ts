import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createModelEmbedder } from './client'
import { createHashEmbedder } from './hash'
import type { Embedder } from './types'

/**
 * 嵌入器装配（PHASE-09 H3 / ADR-0004 / ADR-0001）。
 *
 * 选型顺序：
 *   1. `NORYTH_MEMORY_EMBED=hash`（未打包构建）→ 哈希嵌入；
 *   2. `resources/models/bge-small-zh-v1.5/` 存在 → utilityProcess + bge；
 *   3. 否则 → 哈希嵌入（离线、确定性、CI 可用），并在项目元数据里标降级。
 *
 * 模型文件随包分发属于阶段 10 的打包工作；本阶段只保证「有模型就用真模型，
 * 没模型也可跑通并有明确记录」，不假装具备语义检索能力。
 */

export const MODEL_DIR_NAME = 'bge-small-zh-v1.5'

export interface EmbedderOptions {
  repoRoot?: string
  workerPath?: string
  env?: NodeJS.ProcessEnv
  /** 测试注入：强制使用哈希嵌入。 */
  forceHash?: boolean
}

export function resolveEmbeddingModelDir(repoRoot?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.NORYTH_EMBED_MODEL_DIR && env.NORYTH_EMBED_MODEL_DIR.trim().length > 0) {
    return existsSync(env.NORYTH_EMBED_MODEL_DIR) ? env.NORYTH_EMBED_MODEL_DIR : null
  }
  const candidates: string[] = []
  if (app.isPackaged) candidates.push(join(process.resourcesPath, 'models', MODEL_DIR_NAME))
  candidates.push(join(repoRoot ?? app.getAppPath(), 'resources', 'models', MODEL_DIR_NAME))
  candidates.push(join(process.cwd(), 'resources', 'models', MODEL_DIR_NAME))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export function createEmbedder(options: EmbedderOptions = {}): Embedder {
  const env = options.env ?? process.env
  if (options.forceHash === true || env.NORYTH_MEMORY_EMBED === 'hash') return createHashEmbedder()
  const modelDir = resolveEmbeddingModelDir(options.repoRoot, env)
  if (modelDir === null) return createHashEmbedder()
  return createModelEmbedder({
    workerPath: options.workerPath ?? join(__dirname, 'memory-embed-worker.js'),
    modelDir
  })
}
