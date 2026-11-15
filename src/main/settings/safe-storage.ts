import { safeStorage } from 'electron'
import type { SecretCipher } from './secrets'

/**
 * Windows DPAPI 加密后端（PHASE-10 I1 / PRD §9.1）。
 *
 * 只有主进程 import electron；纯逻辑模块与测试通过注入 `SecretCipher` 使用，
 * 所以这里不做任何 Key 缓存，也不读环境变量。
 */
export function safeStorageCipher(): SecretCipher {
  const available = (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }
  return {
    available,
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (payload) => safeStorage.decryptString(payload)
  }
}
