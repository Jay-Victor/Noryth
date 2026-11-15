import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProviderKeyStatus } from '../../shared/schema/settings'

/**
 * API Key 保管（PHASE-10 I1 / PRD §9.1 / UI-DESIGN §8.4）。
 *
 * 不变式：
 * - 明文只出现在 `set` 的入参与 `get` 的返回值里，绝不落盘；
 * - 落盘文件只有密文（base64）与末 4 位，供 UI 回显；
 * - 没有可用加密后端时退化为「内存保管」：本次运行能用，重启即失效，
 *   状态里 `available=false`，UI 必须提示；宁可不存也不写明文。
 *
 * 加密后端由调用方注入（主进程注入 safeStorage，测试注入内存实现），
 * 这样纯逻辑模块不 import electron，单元测试也不需要 Electron 运行时。
 */

export interface SecretCipher {
  /** safeStorage.isEncryptionAvailable()；内存后端恒为 true。 */
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (payload: Buffer) => string
}

interface SecretFileEntry {
  cipher: string
  last4: string
  updatedAt: string
}

interface SecretFile {
  version: 1
  scheme: string
  keys: Record<string, SecretFileEntry>
}

const EMPTY = (preset: string): ProviderKeyStatus => ({
  preset: preset as ProviderKeyStatus['preset'],
  configured: false,
  last4: null,
  updatedAt: null
})

function last4Of(key: string): string {
  return key.slice(-4)
}

export class SecretStore {
  private readonly memory = new Map<string, string>()
  private readonly memoryStatus = new Map<string, { last4: string; updatedAt: string }>()

  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** Key 是否写盘（有 safeStorage 才写）；false 时只在本次运行有效。 */
  available(): boolean {
    return this.cipher.available()
  }

  get(preset: string): string | null {
    const cached = this.memory.get(preset)
    if (cached !== undefined) return cached
    if (!this.cipher.available()) return null
    const entry = this.readFile()?.keys[preset]
    if (!entry) return null
    try {
      const plain = this.cipher.decrypt(Buffer.from(entry.cipher, 'base64'))
      this.memory.set(preset, plain)
      return plain
    } catch {
      // 密文损坏（换机器/换用户）时当作未配置，不抛错阻塞启动。
      return null
    }
  }

  set(preset: string, apiKey: string): ProviderKeyStatus {
    const trimmed = apiKey.trim()
    const updatedAt = this.now()
    this.memory.set(preset, trimmed)
    this.memoryStatus.set(preset, { last4: last4Of(trimmed), updatedAt })
    if (this.cipher.available()) {
      const file = this.readFile() ?? { version: 1, scheme: 'safeStorage', keys: {} }
      file.keys[preset] = {
        cipher: this.cipher.encrypt(trimmed).toString('base64'),
        last4: last4Of(trimmed),
        updatedAt
      }
      this.writeFile(file)
    }
    return this.status(preset)
  }

  remove(preset: string): ProviderKeyStatus {
    this.memory.delete(preset)
    this.memoryStatus.delete(preset)
    const file = this.readFile()
    if (file && file.keys[preset]) {
      delete file.keys[preset]
      this.writeFile(file)
    }
    return this.status(preset)
  }

  status(preset: string): ProviderKeyStatus {
    const cached = this.memoryStatus.get(preset)
    if (cached) {
      return {
        preset: preset as ProviderKeyStatus['preset'],
        configured: true,
        last4: cached.last4,
        updatedAt: cached.updatedAt
      }
    }
    if (!this.cipher.available()) return EMPTY(preset)
    const entry = this.readFile()?.keys[preset]
    if (!entry) return EMPTY(preset)
    return {
      preset: preset as ProviderKeyStatus['preset'],
      configured: true,
      last4: entry.last4,
      updatedAt: entry.updatedAt
    }
  }

  /** 诊断包与测试用：只暴露是否配置，不暴露任何密文。 */
  summary(): Array<{ preset: string; configured: boolean; last4: string | null }> {
    const keys = this.readFile()?.keys ?? {}
    const names = new Set([...Object.keys(keys), ...this.memoryStatus.keys()])
    return [...names].sort().map((preset) => {
      const status = this.status(preset)
      return { preset, configured: status.configured, last4: status.last4 }
    })
  }

  private readFile(): SecretFile | null {
    if (!existsSync(this.file)) return null
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as SecretFile
      if (raw === null || typeof raw !== 'object' || typeof raw.keys !== 'object') return null
      return raw
    } catch {
      return null
    }
  }

  private writeFile(file: SecretFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

/** 内存后端：没有 safeStorage 时用它，保证「不写明文」这条铁律。 */
export function memoryCipher(): SecretCipher {
  return {
    available: () => false,
    encrypt: () => Buffer.alloc(0),
    decrypt: () => ''
  }
}

/**
 * 测试用：可逆的弱加密，带认证标签。
 * 换 Key 后解密必须失败（和 DPAPI 换用户/换机器一样），否则「损坏密文」这条测不出来。
 */
export function testCipher(secret = 'noryth-test'): SecretCipher {
  const tag = (input: Buffer): Buffer =>
    createHmac('sha256', secret).update(input).digest().subarray(0, 8)
  const xor = (input: Buffer): Buffer =>
    Buffer.from(input.map((byte, index) => byte ^ secret.charCodeAt(index % secret.length)))
  return {
    available: () => true,
    encrypt: (plain) => {
      const plainBuf = Buffer.from(plain, 'utf8')
      return Buffer.concat([tag(plainBuf), xor(plainBuf)])
    },
    decrypt: (payload) => {
      const body = payload.subarray(8)
      const actual = payload.subarray(0, 8)
      if (!tag(body).equals(actual)) throw new Error('test cipher: bad tag')
      return xor(body).toString('utf8')
    }
  }
}
