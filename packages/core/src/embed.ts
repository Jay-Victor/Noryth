/**
 * P2 · 嵌入管线（可插拔）。
 *
 * core 只定义端口与向量运算，不碰网络：
 * - `HashEmbeddingProvider`：本地占位嵌入，确定性、零依赖。它把词面二元组
 *   投影到固定维度，能支撑"词面可解集"的检索门禁，但**不能**做跨措辞召回。
 *   这不是缺陷掩盖：05-roadmap.md §P2 已把跨措辞召回单列为已知缺口、不进门禁。
 * - 远程 provider（OpenAI 兼容 /embeddings）在 CLI 层实现，core 只认端口。
 *
 * 向量一律 L2 归一化后存储；余弦相似度因此退化为点积。
 */
import { PARAMS } from './params.js';
import { tokenize } from './text.js';

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

/** FNV-1a 32 位：比 BLAKE2b 快两个数量级，嵌入不需要密码学强度。 */
function fnv1a(text: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 本地占位嵌入：每个 token 投到两个桶（带符号），再做 L2 归一化。
 * 同一个 token 在任何文本里落点相同；共享词越多，余弦越高。
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'hash';
  readonly dim: number;

  constructor(dim: number = PARAMS['memory.vector_dim']) {
    if (!Number.isInteger(dim) || dim < 8 || dim > 4096) {
      throw new RangeError(`嵌入维度必须是 8–4096 的整数：${dim}`);
    }
    this.dim = dim;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((text) => hashEmbed(text, this.dim));
  }
}

/** 同步版本：内存检索与测试不需要 await。 */
export function hashEmbed(text: string, dim: number = PARAMS['memory.vector_dim']): Float32Array {
  const vector = new Float32Array(dim);
  for (const token of tokenize(text)) {
    const index = fnv1a(token, 0) % dim;
    const sign = (fnv1a(token, 0x9e3779b9) & 1) === 0 ? 1 : -1;
    vector[index] = vector[index]! + sign;
  }
  return l2Normalize(vector);
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i]! * vector[i]!;
  if (sum === 0) return vector;
  const norm = Math.sqrt(sum);
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) out[i] = vector[i]! / norm;
  return out;
}

/** 余弦；输入应已归一化，这里仍按完整公式算，防止调用方漏归一化。 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new RangeError(`向量维度不一致：${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** SQLite BLOB：Float32 小端，与 `CHECK(embedding_dim = length(embedding)/4)` 一致。 */
export function encodeVector(vector: Float32Array): Uint8Array {
  const buffer = new Uint8Array(vector.length * 4);
  const view = new DataView(buffer.buffer);
  for (let i = 0; i < vector.length; i += 1) view.setFloat32(i * 4, vector[i]!, true);
  return buffer;
}

export function decodeVector(buffer: Uint8Array, dim?: number): Float32Array {
  if (buffer.length % 4 !== 0) {
    throw new RangeError(`向量字节数必须是 4 的倍数：${buffer.length}`);
  }
  const length = buffer.length / 4;
  if (dim !== undefined && length !== dim) {
    throw new RangeError(`向量维度 ${length} 与期望 ${dim} 不一致`);
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** 校验向量可用于落库：维度、有限数、非零。返回归一化后的副本。 */
export function prepareVector(values: readonly number[], dim: number): Float32Array {
  if (values.length !== dim) {
    throw new RangeError(`向量维度 ${values.length} 与 memory.vector_dim=${dim} 不一致`);
  }
  const vector = new Float32Array(dim);
  let nonZero = false;
  for (let i = 0; i < dim; i += 1) {
    const value = values[i]!;
    if (!Number.isFinite(value)) throw new RangeError(`向量第 ${i} 维不是有限数`);
    vector[i] = value;
    if (value !== 0) nonZero = true;
  }
  if (!nonZero) throw new RangeError('向量全零：无法归一化');
  return l2Normalize(vector);
}
