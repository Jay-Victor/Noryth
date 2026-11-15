import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SecretStore, memoryCipher, testCipher } from '../../../src/main/settings/secrets'
import { tempDir } from '../helpers'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

function setup(cipher = testCipher()) {
  const dir = tempDir('noryth-secrets-')
  cleanups.push(dir.cleanup)
  const file = join(dir.path, 'secrets.bin')
  return { file, store: new SecretStore(file, cipher) }
}

describe('safeStorage Key 保管（I1）', () => {
  it('写入后只回末 4 位，文件里没有明文', () => {
    const { file, store } = setup()
    const status = store.set('deepseek', '  sk-test-1234567890  ')
    expect(status).toMatchObject({ preset: 'deepseek', configured: true, last4: '7890' })
    expect(typeof status.updatedAt).toBe('string')
    expect(store.get('deepseek')).toBe('sk-test-1234567890')

    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain('sk-test-1234567890')
    expect(raw).not.toContain('1234567890')
    expect(JSON.parse(raw)).toMatchObject({ version: 1, scheme: 'safeStorage' })
  })

  it('越权/损坏的密文当作未配置，不抛错', () => {
    const dir = tempDir('noryth-secrets-')
    cleanups.push(dir.cleanup)
    const file = join(dir.path, 'secrets.bin')
    const plain = new SecretStore(file, testCipher('a'))
    plain.set('deepseek', 'sk-aaaaaaaa')
    const other = new SecretStore(file, testCipher('b'))
    expect(other.get('deepseek')).toBeNull()
    expect(other.status('deepseek').configured).toBe(true)
  })

  it('删除后状态回到未配置，文件里不再有该条', () => {
    const { file, store } = setup()
    store.set('deepseek', 'sk-aaaaaaaa')
    expect(store.remove('deepseek').configured).toBe(false)
    expect(store.get('deepseek')).toBeNull()
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { keys: Record<string, unknown> }
    expect(parsed.keys.deepseek).toBeUndefined()
  })

  it('没有 safeStorage 时只在内存有效，不写明文也不写文件', () => {
    const { file, store } = setup(memoryCipher())
    expect(store.available()).toBe(false)
    const status = store.set('openai', 'sk-memory-only')
    expect(status.configured).toBe(true)
    expect(store.get('openai')).toBe('sk-memory-only')
    expect(existsSync(file)).toBe(false)

    const reopened = new SecretStore(file, memoryCipher())
    expect(reopened.get('openai')).toBeNull()
  })

  it('summary 只给是否配置与末 4 位', () => {
    const { store } = setup()
    store.set('deepseek', 'sk-1111')
    store.set('tongyi', 'sk-2222')
    expect(store.summary()).toEqual([
      { preset: 'deepseek', configured: true, last4: '1111' },
      { preset: 'tongyi', configured: true, last4: '2222' }
    ])
  })
})
