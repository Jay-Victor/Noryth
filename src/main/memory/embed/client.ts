import { utilityProcess, type UtilityProcess } from 'electron'
import { AppError } from '../../../shared/domain/app-error'
import type { EmbedWorkerRequest, EmbedWorkerResponse } from './protocol'
import { EMBEDDING_DIM, type EmbedKind, type Embedder } from './types'

/**
 * 模型嵌入器（bge-small-zh-v1.5，utilityProcess；ADR-0004 / DEV-PLAN §10.5）。
 *
 * - 懒启动：第一次 embed 才 fork worker；
 * - 空闲 5 分钟退出；
 * - 批量 32 条/批；
 * - 单批超时 20s；失败抛 `vector_unavailable`，apply 整体失败可重试，
 *   不会留下「有文本无向量」的半状态。
 *
 * worker 是第二个 main 入口（`out/main/memory-embed-worker.js`）。
 */

const BATCH = 32
const IDLE_MS = 5 * 60 * 1000

interface Pending {
  resolve: (value: EmbedWorkerResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface ModelEmbedderOptions {
  workerPath: string
  modelDir: string
  timeoutMs?: number
  idleMs?: number
}

export class ModelEmbedder implements Embedder {
  readonly model: string
  readonly dim = EMBEDDING_DIM
  readonly source = 'model' as const

  private child: UtilityProcess | null = null
  private readonly pending = new Map<string, Pending>()
  private sequence = 0
  private idleTimer: NodeJS.Timeout | null = null
  private modelName = 'bge-small-zh-v1.5'

  constructor(private readonly options: ModelEmbedderOptions) {
    this.model = this.modelName
  }

  private touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      void this.dispose()
    }, this.options.idleMs ?? IDLE_MS)
    this.idleTimer.unref?.()
  }

  private ensureChild(): UtilityProcess {
    if (this.child !== null) return this.child
    const child = utilityProcess.fork(this.options.workerPath, [], {
      env: { ...process.env, NORYTH_EMBED_MODEL_DIR: this.options.modelDir },
      stdio: 'ignore'
    })
    child.on('message', (message: unknown) => {
      const response = message as EmbedWorkerResponse
      const pending = this.pending.get(response.id)
      if (!pending) return
      this.pending.delete(response.id)
      clearTimeout(pending.timer)
      pending.resolve(response)
    })
    child.on('exit', (code) => {
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer)
        pending.reject(new AppError('vector_unavailable', `嵌入 worker 退出（code ${code}）`, { id }))
      }
      this.pending.clear()
      this.child = null
    })
    this.child = child
    return child
  }

  private call(request: EmbedWorkerRequest): Promise<EmbedWorkerResponse> {
    const child = this.ensureChild()
    return new Promise<EmbedWorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id)
        reject(new AppError('vector_unavailable', '嵌入超时'))
      }, this.options.timeoutMs ?? 20_000)
      this.pending.set(request.id, { resolve, reject, timer })
      child.postMessage(request)
    })
  }

  async embed(texts: readonly string[], kind: EmbedKind = 'doc'): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const out: Float32Array[] = []
    this.touch()
    for (let offset = 0; offset < texts.length; offset += BATCH) {
      const batch = texts.slice(offset, offset + BATCH).map((text) => text.slice(0, 2_000))
      this.sequence += 1
      const response = await this.call({
        id: `embed_${this.sequence}`,
        method: 'embed',
        texts: batch,
        kind
      })
      if (!response.ok) {
        throw new AppError('vector_unavailable', `嵌入失败：${response.code}`, {
          code: response.code,
          ...(response.message === undefined ? {} : { message: response.message })
        })
      }
      if (response.dim !== EMBEDDING_DIM) {
        throw new AppError('vector_unavailable', `嵌入维度 ${response.dim} 与项目 ${EMBEDDING_DIM} 不一致`)
      }
      this.modelName = response.model
      for (const vector of response.vectors) out.push(Float32Array.from(vector))
    }
    this.touch()
    return out
  }

  async dispose(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const child = this.child
    this.child = null
    if (child !== null) {
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }
  }
}

export function createModelEmbedder(options: ModelEmbedderOptions): ModelEmbedder {
  return new ModelEmbedder(options)
}
