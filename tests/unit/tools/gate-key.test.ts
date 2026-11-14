import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOrCreateGateKey, type SecretCipher } from '../../../src/main/security/gate-key'

function fakeCipher(available = true): SecretCipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return text.slice(4)
    }
  }
}

describe('gate key store', () => {
  it('首次生成 64 位 hex，二次读取同一密钥', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noryth-key-'))
    try {
      const file = join(dir, 'gate.key')
      const key = loadOrCreateGateKey(file, fakeCipher())
      expect(key).toMatch(/^[0-9a-f]{64}$/)
      expect(readFileSync(file, 'utf8')).toBe(`enc:${key}`)
      expect(loadOrCreateGateKey(file, fakeCipher())).toBe(key)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件损坏或换机无法解密时重新生成', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noryth-key-'))
    try {
      const file = join(dir, 'gate.key')
      const first = loadOrCreateGateKey(file, fakeCipher())
      writeFileSync(file, 'garbage', 'utf8')
      const second = loadOrCreateGateKey(file, fakeCipher())
      expect(second).toMatch(/^[0-9a-f]{64}$/)
      expect(second).not.toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('safeStorage 不可用时拒绝明文落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noryth-key-'))
    try {
      expect(() => loadOrCreateGateKey(join(dir, 'gate.key'), fakeCipher(false))).toThrow(/safeStorage/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
