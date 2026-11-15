import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ALL_MANIFESTS } from '../../src/main/tools/manifests'
import { buildRegistry } from '../../src/main/tools/registry'
import { WriteService } from '../../src/main/scheduler/service'
import { AGENT_KEY_FALLBACKS } from '../../src/main/model/keys'
import { SecretStore, testCipher } from '../../src/main/settings/secrets'
import { SettingsService } from '../../src/main/settings/service'
import { SettingsStore } from '../../src/main/settings/store'
import { openWriteWorld, type WriteTestWorld } from '../support/write-world'
import { tempDir } from '../unit/helpers'
import { startFakeLlm, type FakeLlmServer, type FakeReply, type ChatRequestBody } from './support/fake-llm'

/**
 * I1 + I2 + I3 的集成证据（E2E-M0-PROVIDER 的服务层对照）：
 * - Key 经 safeStorage（测试用带认证标签的弱加密）保管，适配器用它发请求；
 * - 测试连接把能力快照写进 settings，绑定校验以它为准；
 * - 改绑定只影响下一拍：第一拍用 deepseek，改绑后第二拍用通义，跑的是同一个 job 之外的两次独立作业；
 * - turn_metric 记录实际使用的 provider/model，可供成本归因。
 *
 * 这里不调真实 API：两家预设都指向本地 OpenAI-compatible 假服务器。
 */

const registry = buildRegistry(ALL_MANIFESTS, { at: '2026-01-01T00:00:00.000Z' })
const cleanups: Array<() => void> = []
const servers: FakeLlmServer[] = []
const worlds: WriteTestWorld[] = []

afterEach(async () => {
  while (worlds.length > 0) worlds.pop()!.cleanup()
  while (servers.length > 0) await servers.pop()!.close()
  while (cleanups.length > 0) cleanups.pop()!()
})

/** 按请求内容分派：探测的三种请求 + 正文一拍，全部确定性。 */
function smartReply(request: ChatRequestBody): FakeReply {
  const hasProbeTool = (request.tools ?? []).some((tool) => tool.function.name === 'probe_echo')
  if (hasProbeTool) {
    return { toolCalls: [{ id: 'call_probe', name: 'probe_echo', args: { text: 'ok' } }], usage: { in: 10, out: 4 } }
  }
  if (request.response_format) return { text: '{"ok":true}', usage: { in: 8, out: 4 } }
  const first = request.messages[0]?.content ?? ''
  // 探测的流式请求只有一句话；正文回合的 system 提示词很长，不要误判。
  if (first.trim() === '只回复 ok') return { text: 'ok', usage: { in: 6, out: 2 } }
  return {
    text: JSON.stringify({ body: '雨声压下来，她把账本推过桌面，纸角在灯下泛黄。', grounding: [] }),
    usage: { in: 900, out: 60 }
  }
}

function setup() {
  const dir = tempDir('noryth-provider-')
  cleanups.push(dir.cleanup)
  const world = openWriteWorld({ sceneCount: 1, beatsPerScene: 2 })
  worlds.push(world)
  const store = new SettingsStore(join(dir.path, 'settings.json'))
  const secrets = new SecretStore(join(dir.path, 'secrets.bin'), testCipher())
  const center = new SettingsService({
    store,
    secrets,
    host: () => ({ db: world.handle.db, repos: world.repos })
  })
  return { dir, world, store, secrets, center }
}

describe('设置页接管的模型接入（I1 / I2 / I3）', () => {
  it('测试连接写能力快照；绑定前必须已测试', async () => {
    const { center, store } = setup()
    const server = await startFakeLlm(smartReply)
    servers.push(server)

    expect(() =>
      center.setBindings({
        projectId: 'prj_missing',
        changes: [{ agentKey: 'reviewer', provider: 'deepseek', model: 'deepseek-chat' }]
      })
    ).toThrow()

    center.setKey({ preset: 'deepseek', apiKey: 'sk-from-settings' })
    const result = await center.test({ preset: 'deepseek', baseUrl: server.baseUrl, model: 'deepseek-flash' })
    expect(result.ok, JSON.stringify(result.error)).toBe(true)
    expect(result.model).toBe('deepseek-flash')
    expect(result.capabilities?.tools).toBe(true)
    expect(store.read().providers.deepseek?.capabilities).toEqual(result.capabilities)
    expect(server.authorizations[0]).toBe('Bearer sk-from-settings')
    // 落盘只有末 4 位，没有明文
    expect(JSON.stringify(store.read())).not.toContain('sk-from-settings')
  })

  it('失败连接给错误码与建议，不写能力快照', async () => {
    const { center, store } = setup()
    const server = await startFakeLlm(() => ({ httpStatus: 401, httpBody: JSON.stringify({ error: { message: 'bad key' } }) }))
    servers.push(server)

    center.setKey({ preset: 'deepseek', apiKey: 'sk-wrong' })
    const result = await center.test({ preset: 'deepseek', baseUrl: server.baseUrl })
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('model_auth')
    expect(result.error?.advice).toContain('Key')
    expect(store.read().providers.deepseek?.capabilities ?? null).toBeNull()
  })

  it('绑定生效：第一拍走 deepseek，改绑后第二拍走通义，turn_metric 可归因', async () => {
    const { center, world, store } = setup()
    const server = await startFakeLlm(smartReply)
    servers.push(server)

    center.setKey({ preset: 'deepseek', apiKey: 'sk-deepseek' })
    center.setKey({ preset: 'tongyi', apiKey: 'sk-tongyi' })
    expect((await center.test({ preset: 'deepseek', baseUrl: server.baseUrl, model: 'deepseek-flash' })).ok).toBe(true)
    expect((await center.test({ preset: 'tongyi', baseUrl: server.baseUrl, model: 'qwen-plus' })).ok).toBe(true)

    const service = new WriteService({
      host: () => ({ dir: world.dir, db: world.handle.db, repos: world.repos, readOnly: false }),
      registry,
      settings: () => store.read(),
      allowFakeModel: true,
      gateSecret: 'integration-gate',
      send: () => undefined,
      fakeChunkDelayMs: 0,
      // 没有 NORYTH_WRITE_FAKE：走真实 OpenAI-compatible 适配器
      env: {} as NodeJS.ProcessEnv,
      apiKeyFor: center.apiKeyLookup(AGENT_KEY_FALLBACKS.narrator)
    })

    const beats = world.repos.beat.listLiveByChapter(world.chapterId)
    const first = await service.generate(beats[0]!.id)
    expect(first.state.currentBeatId).not.toBeNull()
    const firstRequests = server.requests.length
    expect(firstRequests).toBeGreaterThan(0)
    expect(server.authorizations.at(-1)).toBe('Bearer sk-deepseek')

    const before = world.handle.db
      .prepare('SELECT COUNT(*) AS count FROM turn_metric WHERE provider = ? AND model = ?')
      .get('deepseek', 'deepseek-flash') as { count: number }
    expect(before.count).toBeGreaterThan(0)

    // 改绑定只影响下一拍：narrator 换成通义
    center.setBindings({
      projectId: world.projectId,
      changes: [{ agentKey: 'narrator', provider: 'tongyi', model: 'qwen-plus' }]
    })
    const second = await service.generate(beats[1]!.id)
    expect(second.state.currentBeatId).not.toBeNull()
    expect(server.requests.length).toBeGreaterThan(firstRequests)
    expect(server.authorizations.at(-1)).toBe('Bearer sk-tongyi')

    const after = world.handle.db
      .prepare('SELECT COUNT(*) AS count FROM turn_metric WHERE provider = ? AND model = ?')
      .get('tongyi', 'qwen-plus') as { count: number }
    expect(after.count).toBeGreaterThan(0)

    const matrix = center.bindings(world.projectId)
    expect(matrix.rows.find((row) => row.agentKey === 'narrator')).toMatchObject({
      provider: 'tongyi',
      model: 'qwen-plus',
      source: 'agent'
    })
  }, 60_000)
})
