import type { EmbedFailureCode, EmbedWorkerRequest, EmbedWorkerResponse } from './protocol'
import { BGE_MODEL, EMBEDDING_DIM, normalizeVector } from './types'

/**
 * 嵌入 worker（utilityProcess 入口，ADR-0004）。
 *
 * 只在 `resources/models/bge-small-zh-v1.5` 存在时由 main 启动；
 * 模型缺失时 client 直接降级为 HashEmbedder，不会走到这里。
 *
 * 约束：
 *   - `allowRemoteModels = false`：离线加载，生产不联网；
 *   - 单条截断 512 token（tokenizer 负责），批量 ≤32 条由 client 切片；
 *   - 输出 L2 归一化，检索用 L2 距离换算 cosine。
 */

interface ParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(value: unknown): void
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort

type Extractor = (
  texts: string[],
  options: { pooling: 'cls'; normalize: boolean }
) => Promise<{ data: Float32Array | number[]; dims: number[] }>

let extractor: Promise<Extractor> | null = null

async function loadExtractor(modelDir: string): Promise<Extractor> {
  const module = (await import('@huggingface/transformers')) as unknown as {
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<Extractor>
    env: { allowRemoteModels: boolean; localModelPath: string }
  }
  module.env.allowRemoteModels = false
  module.env.localModelPath = modelDir
  return module.pipeline('feature-extraction', modelDir, { dtype: 'q8' })
}

function failure(id: string, code: EmbedFailureCode, message?: string): EmbedWorkerResponse {
  return { id, ok: false, code, ...(message === undefined ? {} : { message }) }
}

async function handle(request: EmbedWorkerRequest): Promise<EmbedWorkerResponse> {
  const modelDir = process.env.NORYTH_EMBED_MODEL_DIR ?? ''
  if (modelDir.length === 0) return failure(request.id, 'model_missing', 'NORYTH_EMBED_MODEL_DIR 未设置')
  try {
    if (extractor === null) extractor = loadExtractor(modelDir)
    const run = await extractor
    if (request.method === 'warmup') {
      await run(request.texts.length > 0 ? request.texts : ['预热', '账本'], { pooling: 'cls', normalize: true })
      return { id: request.id, ok: true, vectors: [], dim: EMBEDDING_DIM, model: BGE_MODEL }
    }
    if (request.texts.length === 0) {
      return { id: request.id, ok: true, vectors: [], dim: EMBEDDING_DIM, model: BGE_MODEL }
    }
    const output = await run(request.texts, { pooling: 'cls', normalize: true })
    const dim = output.dims[output.dims.length - 1] ?? EMBEDDING_DIM
    if (dim !== EMBEDDING_DIM) {
      return failure(request.id, 'internal', `模型维度 ${dim} 与项目 ${EMBEDDING_DIM} 不一致`)
    }
    const flat = output.data instanceof Float32Array ? output.data : Float32Array.from(output.data)
    const vectors: number[][] = []
    for (let index = 0; index < request.texts.length; index += 1) {
      const slice = flat.slice(index * dim, (index + 1) * dim)
      vectors.push(Array.from(normalizeVector(slice)))
    }
    return { id: request.id, ok: true, vectors, dim, model: BGE_MODEL }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/ENOENT|not found|missing|no such file/i.test(message)) {
      return failure(request.id, 'model_missing', message)
    }
    if (/out of memory|oom/i.test(message)) return failure(request.id, 'oom', message)
    return failure(request.id, 'internal', message)
  }
}

if (parentPort) {
  parentPort.on('message', (event) => {
    const request = event.data as EmbedWorkerRequest
    if (!request || typeof request.id !== 'string') return
    void handle(request).then((response) => parentPort.postMessage(response))
  })
}
