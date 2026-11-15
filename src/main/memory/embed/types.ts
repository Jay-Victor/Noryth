/**
 * 嵌入器接口（PHASE-09 H3 / ADR-0004）。
 *
 * 两个实现：
 *   - `UtilityProcessEmbedder`：bge-small-zh-v1.5 q8 / 512 维，跑在 utilityProcess；
 *     只有模型文件随包存在时才启用。
 *   - `HashEmbedder`：确定性 bigram 哈希 / 512 维，无模型、无网络；
 *     用于模型缺失、CI 与 E2E，**写进 `memory_entry.embedding_model`**，
 *     不与 bge 向量混用（检索按模型名过滤）。
 *
 * 两者维度相同，因此同一张 `memory_vec` 表可以并存不同模型的行；
 * 换模型时旧行仍可按关键词召回，向量通道只匹配当前模型。
 */

export type EmbedKind = 'query' | 'doc'

export interface Embedder {
  readonly model: string
  readonly dim: number
  readonly source: 'model' | 'hash'
  embed(texts: readonly string[], kind: EmbedKind): Promise<Float32Array[]>
  dispose(): Promise<void>
}

export const EMBEDDING_DIM = 512
export const BGE_MODEL = 'bge-small-zh-v1.5'
export const HASH_MODEL = 'hash-bigram-v1'

export function normalizeVector(vector: Float32Array): Float32Array {
  let norm = 0
  for (const value of vector) norm += value * value
  if (norm <= 0) return vector
  const scale = 1 / Math.sqrt(norm)
  const out = new Float32Array(vector.length)
  for (let index = 0; index < vector.length; index += 1) out[index] = vector[index]! * scale
  return out
}

/** 单位向量的 L2 距离 ↔ cosine：cos = 1 - d²/2。 */
export function cosineFromDistance(distance: number): number {
  return 1 - (distance * distance) / 2
}

export function vectorToArray(vector: Float32Array): number[] {
  return Array.from(vector)
}

/** 进程边界上的向量校验：维度不符拒绝写入，避免 memory_vec 里混维度。 */
export class EmbeddingDimensionError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`embedding dim ${actual} != expected ${expected}`)
    this.name = 'EmbeddingDimensionError'
  }
}
