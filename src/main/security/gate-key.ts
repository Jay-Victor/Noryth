import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomHex } from '../crypto'

/**
 * 闸门密钥：每安装一个，`safeStorage` 加密后存 `%APPDATA%/noryth/gate.key`。
 * 换机或密钥文件损坏 → 重新生成（旧令牌全部失效，PRD 明确可接受）。
 *
 * Electron 的 safeStorage 不能在纯 Node 测试里用，所以这里只依赖一个
 * 可注入的 cipher；阶段 05 在 main 里用 safeStorage 实现它。
 */

export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const KEY_PATTERN = /^[0-9a-f]{64}$/

export function loadOrCreateGateKey(file: string, cipher: SecretCipher): string {
  if (!cipher.isEncryptionAvailable()) {
    throw new Error('gate key: safeStorage 不可用，拒绝以明文落盘')
  }

  if (existsSync(file)) {
    try {
      const encrypted = readFileSync(file)
      const decoded = cipher.decryptString(encrypted)
      if (KEY_PATTERN.test(decoded)) return decoded
    } catch {
      // 解密失败（换机/损坏）→ 落到重新生成
    }
  }

  const key = randomHex(32)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, cipher.encryptString(key), { mode: 0o600 })
  return key
}
