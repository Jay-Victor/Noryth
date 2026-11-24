import { app, protocol, session, type BrowserWindow } from 'electron'
import { join, resolve } from 'node:path'
import { LATEST_SCHEMA_VERSION } from './db/migrations'
import { resolveVecExtension } from './db/vec-extension'
import { registerIpc, unregisterIpc } from './ipc/router'
import { WorldService } from './world/service'
import { VoiceService } from './voice/service'
import { createLogger, logFilePath, type Logger } from './observability/logger'
import { ProjectRegistry } from './project/registry'
import { ProjectService } from './project/service'
import { PlanService } from './plan/service'
import { registerAppProtocol } from './protocol'
import { devCsp, PROD_CSP } from './security'
import { SettingsStore } from './settings/store'
import { SettingsService } from './settings/service'
import { SecretStore } from './settings/secrets'
import { safeStorageCipher } from './settings/safe-storage'
import { AGENT_KEY_FALLBACKS } from './model/keys'
import { createRoutingRuntime } from './model/router'
import { capabilitiesFor } from './model/presets'
import { DevSliceService } from './slice/service'
import { WriteService } from './scheduler/service'
import { MemoryService } from './memory/service'
import { createEmbedder } from './memory/embed/model'
import { ReviewService, type ReviewServiceDeps } from './review/service'
import { sha256Hex } from './crypto'
import { ALL_MANIFESTS } from './tools/manifests'
import { buildRegistry } from './tools/registry'
import { createMainWindow, preloadPathFor } from './window'
import { resolveAppIcon } from './brand'
import { startBackgroundUpdateCheck, runUpdateCheck, currentUpdateState, channelOf } from './update'
import { IPC_EVENTS } from '../shared/schema/ipc'
import type { AppInfo, ProjectStateEvent } from '../shared/schema/project'

const singleInstance = process.env.NORYTH_SINGLE_INSTANCE !== '0'
const userDataOverride = process.env.NORYTH_USER_DATA

if (userDataOverride) {
  app.setPath('userData', resolve(userDataOverride))
}
app.setName('Noryth')

// 必须在 ready 之前注册：app:// 是标准、安全、可 fetch 的 scheme
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
  }
])

let mainWindow: BrowserWindow | null = null
let logger: Logger | null = null
let projectService: ProjectService | null = null
let cleanup: Array<() => void> = []

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

if (singleInstance) {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
  } else {
    app.on('second-instance', focusMainWindow)
  }
}

function buildAppInfo(): AppInfo {
  return {
    name: 'Noryth',
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    schemaVersion: LATEST_SCHEMA_VERSION,
    packaged: app.isPackaged,
    update: currentUpdateState()
  }
}

/** 启动检查与设置页手动检查共用同一个入口（PHASE-18 M1-7）。 */
function checkUpdates(): ReturnType<typeof runUpdateCheck> {
  return runUpdateCheck({
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    channel: channelOf(process.env.NORYTH_UPDATE_CHANNEL),
    ...(process.env.NORYTH_UPDATE_FEED ? { feedUrl: process.env.NORYTH_UPDATE_FEED } : {}),
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })
}

async function bootstrap(): Promise<void> {
  const userDataDir = app.getPath('userData')
  const logDir = join(userDataDir, 'logs')
  logger = createLogger(logDir)
  logger.info({ event: 'app_start', version: app.getVersion(), packaged: app.isPackaged }, 'noryth starting')

  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  const isDev = Boolean(rendererUrl)
  const csp = isDev && rendererUrl ? devCsp(rendererUrl) : PROD_CSP

  if (!isDev) {
    registerAppProtocol(join(__dirname, '../renderer'), csp)
  }

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      const allowed =
        url.startsWith('app://noryth/') || (rendererUrl !== undefined && url.startsWith(rendererUrl))
      if (!allowed) event.preventDefault()
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })

  const vecExtension = resolveVecExtension()
  if (!vecExtension) {
    logger.warn({ event: 'vector_unavailable' }, 'sqlite-vec extension not found; project creation will fail')
  }

  mainWindow = createMainWindow({
    preloadPath: preloadPathFor(__dirname),
    icon: resolveAppIcon(),
    ...(rendererUrl ? { devUrl: rendererUrl } : {})
  })

  const window = mainWindow
  const settings = new SettingsStore(join(userDataDir, 'settings.json'))
  const secrets = new SecretStore(join(userDataDir, 'secrets.bin'), safeStorageCipher())
  if (!secrets.available()) {
    logger.warn(
      { event: 'secret_store_unavailable' },
      'safeStorage 不可用：API Key 只在本次运行有效，不会写盘'
    )
  }
  const registry = new ProjectRegistry(join(userDataDir, 'projects.json'))

  const emit = (event: ProjectStateEvent): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_EVENTS.projectState, event)
    }
  }

  const projectServiceInstance = new ProjectService({
    registry,
    appVersion: app.getVersion(),
    windowId: `win_${window.id}`,
    logger,
    vecExtension,
    emit,
    appInfo: buildAppInfo,
    readSettings: () => settings.read()
  })
  projectService = projectServiceInstance

  const settingsCenter = new SettingsService({
    store: settings,
    secrets,
    host: () => projectServiceInstance.currentHandle(),
    paths: { settings: join(userDataDir, 'settings.json'), secrets: join(userDataDir, 'secrets.bin') },
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })
  const plannerKey = settingsCenter.apiKeyLookup(AGENT_KEY_FALLBACKS.planner)
  const writeKey = settingsCenter.apiKeyLookup(AGENT_KEY_FALLBACKS.narrator)
  const reviewKey = settingsCenter.apiKeyLookup(AGENT_KEY_FALLBACKS.reviewer)
  const memoryKey = settingsCenter.apiKeyLookup(AGENT_KEY_FALLBACKS.memory)

  // 路由健康状态在内存（PHASE-21 §5.2）：创作台、审批台与状态栏共用同一个实例。
  // 假模型模式下「有 Key」视为可用，与各 ModelFactory 的判定一致。
  const fakeModelsEnabled =
    !app.isPackaged &&
    ['NORYTH_WRITE_FAKE', 'NORYTH_REVIEW_FAKE', 'NORYTH_PLAN_FAKE', 'NORYTH_MEMORY_FAKE'].some(
      (name) => process.env[name] === '1'
    )
  const anyKey = settingsCenter.apiKeyLookup()
  const routing = createRoutingRuntime({
    getSettings: () => settings.read(),
    providerReady: (provider) => fakeModelsEnabled || anyKey(provider) !== null,
    capabilitiesLookup: (provider, model) =>
      settings.read().providers[provider]?.capabilities ?? capabilitiesFor(provider, model),
    log: (message, details) => logger?.info({ event: message, ...details }, message),
    onEvent: (event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.routingEvent, event)
    }
  })

  const toolRegistry = buildRegistry(ALL_MANIFESTS, { at: new Date().toISOString() })

  const planService = new PlanService({
    host: () => projectServiceInstance.currentHandle(),
    registry: toolRegistry,
    settings: () => settings.read(),
    allowFakeModel: !app.isPackaged,
    apiKeyFor: plannerKey,
    routing,
    emit: (event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.planMessage, event)
    },
    emitChoice: (event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.planChoice, event)
    },
    onStateChange: () => {
      projectServiceInstance.refreshState()
    },
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })

  const sliceEnabled = !app.isPackaged && process.env.NORYTH_SLICE !== '0'
  const slice = sliceEnabled
    ? new DevSliceService({
        host: () => projectServiceInstance.currentHandle(),
        registry: toolRegistry,
        fixturePath: join(app.getAppPath(), 'tests', 'fixtures', 'slice', 'project.json'),
        send: (event) => {
          if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.sliceBeat, event)
        },
        log: (message, details) => logger?.info({ event: message, ...details }, message),
        chunkDelayMs: Number(process.env.NORYTH_SLICE_STREAM_DELAY_MS ?? '8')
      })
    : null

  // 嵌入器：有 bge 模型就用真模型（utilityProcess），否则确定性哈希降级（记录在数据里）。
  const embedder = createEmbedder({ repoRoot: app.getAppPath() })
  logger.info(
    { event: 'embedder_ready', model: embedder.model, source: embedder.source, dim: embedder.dim },
    'embedder resolved'
  )

  const writeService = new WriteService({
    host: () => projectServiceInstance.currentHandle(),
    registry: toolRegistry,
    settings: () => settings.read(),
    allowFakeModel: !app.isPackaged,
    apiKeyFor: writeKey,
    routing,
    gateSecret: sha256Hex(`write-gate-${Date.now()}-${Math.random()}`),
    embedder,
    send: (event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.writeEvent, event)
    },
    fakeChunkDelayMs: Number(process.env.NORYTH_WRITE_STREAM_DELAY_MS ?? '4'),
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })

  const reviewDeps: ReviewServiceDeps = {
    host: () => projectServiceInstance.currentHandle(),
    registry: toolRegistry,
    settings: () => settings.read(),
    allowFakeModel: !app.isPackaged,
    apiKeyFor: reviewKey,
    routing,
    gateSecret: sha256Hex(`review-gate-${Date.now()}-${Math.random()}`),
    send: (event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.reviewEvent, event)
    },
    fakeChunkDelayMs: Number(process.env.NORYTH_REVIEW_STREAM_DELAY_MS ?? '2'),
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  }
  const reviewService = new ReviewService(reviewDeps)

  const memoryService = new MemoryService({
    host: () => projectServiceInstance.currentHandle(),
    registry: toolRegistry,
    settings: () => settings.read(),
    allowFakeModel: !app.isPackaged,
    apiKeyFor: memoryKey,
    routing,
    gateSecret: sha256Hex(`memory-gate-${Date.now()}-${Math.random()}`),
    send: (event) => {
      if (!window.isDestroyed()) window.webContents.send(IPC_EVENTS.memoryEvent, event)
    },
    embedder,
    fakeChunkDelayMs: Number(process.env.NORYTH_MEMORY_STREAM_DELAY_MS ?? '2'),
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })

  // PHASE-16 §5.1：重开再定稿自动入队的 memory.rebuild 由记忆服务执行。
  // 失败只记录，不影响已提交的定稿；记忆台仍可手动按章重建。
  reviewDeps.autoRebuild = (input) => memoryService.runQueuedRebuild(input.jobId)

  const worldService = new WorldService({
    host: () => projectServiceInstance.currentHandle(),
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })

  const voiceService = new VoiceService({
    host: () => projectServiceInstance.currentHandle(),
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })

  registerIpc({
    project: projectServiceInstance,
    plan: planService,
    write: writeService,
    review: reviewService,
    memory: memoryService,
    world: worldService,
    voice: voiceService,
    routing,
    settings,
    settingsCenter,
    logger,
    logPath: logFilePath(logDir),
    userDataDir,
    appInfo: buildAppInfo,
    checkUpdates,
    ...(slice ? { slice } : {}),
    devTools: !app.isPackaged
  })

  cleanup.push(() => {
    void embedder.dispose()
  })

  window.on('closed', () => {
    projectService?.dispose()
    mainWindow = null
  })

  cleanup.push(() => unregisterIpc())

  if (process.env.NORYTH_OPEN_DEVTOOLS === '1') {
    window.webContents.openDevTools({ mode: 'detach' })
  }

  logger.info({ event: 'app_ready', windowId: window.id, schemaVersion: LATEST_SCHEMA_VERSION }, 'noryth ready')

  // 更新检查是后台事：不 await、失败只记日志（PRD §9.1）。
  void startBackgroundUpdateCheck({
    packaged: app.isPackaged,
    currentVersion: app.getVersion(),
    channel: channelOf(process.env.NORYTH_UPDATE_CHANNEL),
    ...(process.env.NORYTH_UPDATE_FEED ? { feedUrl: process.env.NORYTH_UPDATE_FEED } : {}),
    log: (message, details) => logger?.info({ event: message, ...details }, message)
  })
}

app.whenReady().then(bootstrap).catch((error: unknown) => {
  logger?.error({ event: 'bootstrap_failed', error: error instanceof Error ? error.message : String(error) })
  app.quit()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  projectService?.dispose()
  for (const fn of cleanup) {
    try {
      fn()
    } catch {
      // 退出阶段不抛错
    }
  }
  cleanup = []
})
