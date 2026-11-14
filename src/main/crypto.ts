import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * 主进程共用的哈希原语。
 *
 * 单独成文件的原因：`src/main/tools/**` 由 dependency-cruiser 禁止直接 import Node core
 * （工具只能调 repos 与 services），但闸门令牌与幂等键必须做 HMAC/SHA-256。
 * 工具层从这里取，依赖边界仍然成立。
 */

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

export function hmacSha256Base64Url(secret: string | Buffer, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url')
}

export function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url')
}

export function base64UrlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf8')
}

/** 常量时间比较，长度不同直接返回 false（不泄漏前缀匹配长度）。 */
export function safeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 随机 nonce / 密钥材料（十六进制）。 */
export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex')
}
