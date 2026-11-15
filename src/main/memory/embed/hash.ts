import { bigrams } from '../../tools/support/text'
import { EMBEDDING_DIM, HASH_MODEL, normalizeVector, type EmbedKind, type Embedder } from './types'

/**
 * 确定性哈希嵌入（无模型 / 离线 / CI）。
 *
 * 中文 bigram + 单字 + 拉丁词 → FNV-1a 双哈希（位置 + 符号）累加后 L2 归一化。
 * 它不是语义模型：同义改写召回不了，但共享字面的记忆能命中；
 * 这正是降级路径该有的行为——宁可弱，也不要假装有语义能力。
 *
 * 明确记录 `embedding_model='hash-bigram-v1'`，不与 bge 向量混用。
 */

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/

function fnv1a(text: string, seed: number): number {
  let hash = 0x811c9dc5 ^ seed
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function tokensOf(text: string): Array<{ token: string; weight: number }> {
  const tokens: Array<{ token: string; weight: number }> = []
  for (const token of bigrams(text)) tokens.push({ token, weight: 1 })
  for (const char of text.normalize('NFKC')) {
    if (CJK.test(char)) tokens.push({ token: `c:${char}`, weight: 0.35 })
  }
  return tokens
}

export function hashEmbedding(text: string, dim = EMBEDDING_DIM): Float32Array {
  const vector = new Float32Array(dim)
  for (const { token, weight } of tokensOf(text)) {
    const position = fnv1a(token, 0) % dim
    const sign = (fnv1a(token, 0x9e3779b9) & 1) === 0 ? 1 : -1
    vector[position] = (vector[position] ?? 0) + sign * weight
  }
  return normalizeVector(vector)
}

export class HashEmbedder implements Embedder {
  readonly model = HASH_MODEL
  readonly dim = EMBEDDING_DIM
  readonly source = 'hash' as const

  async embed(texts: readonly string[], _kind: EmbedKind = 'doc'): Promise<Float32Array[]> {
    return texts.map((text) => hashEmbedding(text))
  }

  async dispose(): Promise<void> {
    // 无外部资源
  }
}

export function createHashEmbedder(): HashEmbedder {
  return new HashEmbedder()
}
