/**
 * 确定性哈希与规范化 JSON。
 *
 * 抖动禁止用 Math.random：回退后必须能复演同一场（P1 门禁 9）。
 * Python 探针用 hashlib.blake2b(..., digest_size=8) → 这里实现同一参数化的
 * BLAKE2b-64，保证跨语言取到同一个值（test/parity 逐例比对）。
 */
import { createHash } from 'node:crypto';

const MASK64 = (1n << 64n) - 1n;

// BLAKE2b IV（RFC 7693 §2.6）
const IV: readonly bigint[] = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

const SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

function rotr(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

function g(
  v: bigint[],
  a: number,
  b: number,
  c: number,
  d: number,
  x: bigint,
  y: bigint,
): void {
  v[a] = (v[a]! + v[b]! + x) & MASK64;
  v[d] = rotr(v[d]! ^ v[a]!, 32n);
  v[c] = (v[c]! + v[d]!) & MASK64;
  v[b] = rotr(v[b]! ^ v[c]!, 24n);
  v[a] = (v[a]! + v[b]! + y) & MASK64;
  v[d] = rotr(v[d]! ^ v[a]!, 16n);
  v[c] = (v[c]! + v[d]!) & MASK64;
  v[b] = rotr(v[b]! ^ v[c]!, 63n);
}

function compress(
  h: bigint[],
  block: Buffer,
  byteOffset: number,
  counter: bigint,
  last: boolean,
): void {
  const m: bigint[] = new Array<bigint>(16);
  for (let i = 0; i < 16; i += 1) {
    m[i] = block.readBigUInt64LE(byteOffset + i * 8);
  }
  const v: bigint[] = [...h, ...IV];
  v[12] = (v[12]! ^ (counter & MASK64)) & MASK64;
  v[13] = (v[13]! ^ ((counter >> 64n) & MASK64)) & MASK64;
  if (last) {
    v[14] = (v[14]! ^ MASK64) & MASK64;
  }
  for (let round = 0; round < 12; round += 1) {
    const s = SIGMA[round % 10]!;
    g(v, 0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
    g(v, 1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
    g(v, 2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
    g(v, 3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
    g(v, 0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
    g(v, 1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
    g(v, 2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
    g(v, 3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
  }
  for (let i = 0; i < 8; i += 1) {
    h[i] = (h[i]! ^ v[i]! ^ v[i + 8]!) & MASK64;
  }
}

/** BLAKE2b（无密钥，fanout=1, depth=1），digestLength 逐字节对齐 Python 的 digest_size。 */
export function blake2b(data: Uint8Array, digestLength = 8): Buffer {
  if (!Number.isInteger(digestLength) || digestLength < 1 || digestLength > 64) {
    throw new RangeError(`BLAKE2b digestLength 必须在 1–64：${digestLength}`);
  }
  const h = [...IV];
  h[0] = (h[0]! ^ 0x01010000n ^ BigInt(digestLength)) & MASK64;
  const input = Buffer.from(data);
  let offset = 0;
  let counter = 0n;

  while (input.length - offset > 128) {
    counter += 128n;
    compress(h, input, offset, counter, false);
    offset += 128;
  }
  const remaining = input.length - offset;
  const lastBlock = Buffer.alloc(128);
  input.copy(lastBlock, 0, offset);
  counter += BigInt(remaining);
  compress(h, lastBlock, 0, counter, true);

  const out = Buffer.alloc(64);
  for (let i = 0; i < 8; i += 1) {
    out.writeBigUInt64LE(h[i]!, i * 8);
  }
  return out.subarray(0, digestLength);
}

/**
 * 确定性哈希 → [0,1)。调用方传 (seed, seq, id) 之类可复演的量。
 * 与 Python：int.from_bytes(blake2b(raw, digest_size=8).digest(), 'big') / 2**64
 */
export function h01(...parts: ReadonlyArray<string | number | bigint>): number {
  for (const part of parts) {
    // Python str(1.0) = "1.0"，JS String(1) = "1"；只接受整数避免静默分叉。
    if (typeof part === 'number' && !Number.isSafeInteger(part)) {
      throw new TypeError(`h01 的 number 参数必须是安全整数：${part}`);
    }
  }
  const raw = Buffer.from(parts.map((p) => String(p)).join('|'), 'utf8');
  const digest = blake2b(raw, 8);
  let value = 0n;
  for (const byte of digest) {
    value = (value << 8n) | BigInt(byte);
  }
  return Number(value) / 2 ** 64;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 规范化 JSON：对象键排序、无空白。用于请求哈希与内容哈希——
 * 同一个对象换一个键序不该产生新的幂等键。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: 非有限数 ${value}`);
      return value;
    case 'object': {
      if (Array.isArray(value)) return value.map((v) => canonicalize(v));
      const source = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(source).sort()) {
        const item = source[key];
        if (item === undefined) continue;
        out[key] = canonicalize(item);
      }
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: 不支持的类型 ${typeof value}`);
  }
}
