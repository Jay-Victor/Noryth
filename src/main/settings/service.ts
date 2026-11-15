import { AppError } from '../../shared/domain/app-error'
import { messageFor, type ErrorCode } from '../../shared/domain/errors'
import type { Preset, ProviderProbeResult } from '../../shared/schema/model'
import { ProviderProbeInputSchema } from '../../shared/schema/model'
import type { Settings } from '../../shared/schema/project'
import {
  AGENT_KEYS,
  PRESET_LABELS,
  agentLabelFor,
  type AppearancePatch,
  type BindingAuditEntry,
  type BindingChange,
  type BindingMatrix,
  type BindingRow,
  type BindingSetInput,
  type CharacterBindingRow,
  type ProviderCard,
  type ProviderClearInput,
  type ProviderKeySetInput,
  type ProviderKeyStatus,
  type ProviderTestInput,
  type ProviderTestResult,
  type SettingsView
} from '../../shared/schema/settings'
import type { Repos } from '../db/repos'
import type { AgentInstanceKey } from '../tools/types'
import type { Db } from '../db/project-db'
import { withTransaction } from '../db/tx'
import { resolveBinding, type CapabilitiesLookup, type ResolvedBinding } from '../model/bindings'
import { settingsFirstLookup, type ApiKeyLookup } from '../model/keys'
import { PROVIDER_PRESETS, baseUrlFor, capabilitiesFor, defaultModelFor, findPreset } from '../model/presets'
import { probeProvider, type ProbeDeps } from '../model/probe'
import type { SettingsStore } from './store'
import type { SecretStore } from './secrets'

/**
 * 设置中心服务（PHASE-10 I1–I4 / PRD §5.6 / UI-DESIGN §8）。
 *
 * 三件事在这里收口：
 * - Key：写入 safeStorage，只回末 4 位；测试连接失败给错误码 + 建议。
 * - 绑定：继承链 + 批次审计 + 「回滚上一套」；写入即冻结在下一个 job。
 * - 外观：token 级偏好，写 settings.json，renderer 只读不推断。
 */

export interface SettingsHost {
  db: Db
  repos: Repos
}

export interface SettingsServiceDeps {
  store: SettingsStore
  secrets: SecretStore
  host: () => SettingsHost | null
  env?: NodeJS.ProcessEnv
  now?: () => string
  actor?: string
  /** 测试注入：替换真实探测。 */
  probe?: ProbeDeps['createAdapter']
  /** 设置页「高级」展示的数据目录；缺省时只给文件名。 */
  paths?: { settings: string; secrets: string }
  log?: (message: string, details?: Record<string, unknown>) => void
}

const ADVICE: Partial<Record<ErrorCode, string>> = {
  model_auth: '检查 Key 是否正确、是否过期',
  rate_limit: '稍后再试，或切换到另一家预设',
  model_error: '检查网络、代理与 base URL',
  timeout: '检查网络或代理',
  content_filter: '换一个模型再试',
  tool_protocol_error: '该模型可能不支持工具调用，换一个模型'
}

function asPreset(value: string, fallback: Preset): Preset {
  return (['openai', 'deepseek', 'tongyi'] as const).find((preset) => preset === value) ?? fallback
}

function numberParam(params: Record<string, unknown>, key: string): number | null {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export class SettingsService {
  private readonly now: () => string

  constructor(private readonly deps: SettingsServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  // ── Key 与提供方 ─────────────────────────────────────────────────────────

  read(): Settings {
    return this.deps.store.read()
  }

  apiKeyLookup(fallbacks: readonly string[] = []): ApiKeyLookup {
    return settingsFirstLookup(this.deps.secrets, fallbacks, this.deps.env ?? process.env)
  }

  secureStorageAvailable(): boolean {
    return this.deps.secrets.available()
  }

  view(): SettingsView {
    const settings = this.read()
    const providers = PROVIDER_PRESETS.map((preset) => this.providerCard(settings, preset.preset))
    return {
      appearance: settings.appearance,
      providers,
      secureStorage: this.deps.secrets.available(),
      settingsPath: this.deps.paths?.settings ?? 'settings.json',
      secretsPath: this.deps.paths?.secrets ?? 'secrets.bin',
      lastOpenedProjectId: settings.lastOpenedProjectId,
      openLastProject: settings.openLastProject
    }
  }

  setKey(input: ProviderKeySetInput): ProviderKeyStatus {
    const status = this.deps.secrets.set(input.preset, input.apiKey)
    this.deps.log?.('settings_key_set', { preset: input.preset, configured: status.configured })
    return status
  }

  clearKey(input: ProviderClearInput): ProviderKeyStatus {
    const status = this.deps.secrets.remove(input.preset)
    this.deps.log?.('settings_key_clear', { preset: input.preset })
    return status
  }

  keyStatus(preset: Preset): ProviderKeyStatus {
    return this.deps.secrets.status(preset)
  }

  /** 测试连接：Key 优先用本次输入，其次 safeStorage，最后环境变量。 */
  async test(input: ProviderTestInput): Promise<ProviderTestResult> {
    const settings = this.read()
    const snapshot = settings.providers[input.preset]
    const model = input.model ?? snapshot?.model ?? defaultModelFor(input.preset)
    const baseUrl = baseUrlFor(input.preset, input.baseUrl ?? snapshot?.baseUrl ?? null)
    const key =
      input.apiKey?.trim() ??
      this.deps.secrets.get(input.preset)?.trim() ??
      this.apiKeyLookup()(input.preset)?.key ??
      null

    if (key === null || key.length === 0) {
      return {
        preset: input.preset,
        ok: false,
        model: null,
        baseUrl,
        latencyMs: 0,
        capabilities: null,
        checkedAt: this.now(),
        error: { code: 'model_auth', message: messageFor('model_auth'), advice: '填写 API Key 后再测试' }
      }
    }

    const probeInput = ProviderProbeInputSchema.parse({
      preset: input.preset,
      model,
      baseUrl,
      apiKey: key
    })
    const result: ProviderProbeResult = await probeProvider(probeInput, {
      now: () => Date.parse(this.now()),
      save: (preset, next) => {
        const current = this.deps.store.read()
        this.deps.store.write({
          providers: {
            ...current.providers,
            [preset]: next
          }
        })
      },
      ...(this.deps.probe === undefined ? {} : { createAdapter: this.deps.probe })
    })

    if (!result.ok || result.error !== null) {
      const code = (result.error?.code ?? 'model_error') as ErrorCode
      return {
        preset: input.preset,
        ok: false,
        model: null,
        baseUrl: result.baseUrl,
        latencyMs: result.latencyMs,
        capabilities: null,
        checkedAt: result.checkedAt,
        error: { code, message: messageFor(code), advice: ADVICE[code] ?? null }
      }
    }

    this.deps.log?.('settings_probe_ok', { preset: input.preset, model, latencyMs: result.latencyMs })
    return {
      preset: input.preset,
      ok: true,
      model,
      baseUrl: result.baseUrl,
      latencyMs: result.latencyMs,
      capabilities: result.capabilities,
      checkedAt: result.checkedAt,
      error: null
    }
  }

    setProviderEnabled(preset: Preset, enabled: boolean): SettingsView {
      const current = this.read()
      this.deps.store.write({ providersEnabled: { ...current.providersEnabled, [preset]: enabled } })
      return this.view()
    }

  appearance(patch: AppearancePatch): SettingsView {
    this.deps.store.write({ appearance: patch })
    return this.view()
  }

  // ── 绑定 ─────────────────────────────────────────────────────────────────

  bindings(projectId: string): BindingMatrix {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project || project.id !== projectId) throw new AppError('project_not_found', 'project mismatch')
    const settings = this.read()
    const lookup = this.capabilitiesLookup(settings)
    const recent = host.repos.turnMetric.lastUsedByAgent(projectId)

    const rows: BindingRow[] = [this.projectRow(host.repos, project.id, project.defaultPreset, recent)]
    for (const agentKey of AGENT_KEYS) {
      const binding = resolveBinding(host.repos, project, agentKey, lookup)
      rows.push(this.agentRow(agentKey, agentKey, 'agent', binding, recent[agentKey] ?? null))
    }

    const characters: CharacterBindingRow[] = host.repos.character.list(projectId).map((character) => {
      const instanceKey: AgentInstanceKey = `character:${character.id}`
      const overrideRecord = host.repos.modelBinding.get(projectId, instanceKey)
      const effective = resolveBinding(host.repos, project, instanceKey, lookup)
      return {
        characterId: character.id,
        name: character.name,
        override: overrideRecord
          ? this.agentRow('character', instanceKey, 'character', { ...effective, source: 'instance' }, recent[instanceKey] ?? null)
          : null,
        effective: this.agentRow('character', instanceKey, 'character', effective, recent[instanceKey] ?? null)
      }
    })

    const batches = host.repos.modelBinding.listBatches(projectId)
    const rolledBack = new Set(host.repos.modelBinding.rolledBackBatches(projectId))
    const rollbackAudits = new Set(host.repos.modelBinding.rollbackAuditBatches(projectId))
    const rollbackable = batches.find(
      (batch) => !rolledBack.has(batch.batchId) && !rollbackAudits.has(batch.batchId)
    )

    return {
      projectId,
      defaultPreset: asPreset(project.defaultPreset, 'deepseek'),
      providers: PROVIDER_PRESETS.map((preset) => {
        const snapshot = settings.providers[preset.preset]
        const models = preset.models.map((model) => model.id)
        if (snapshot?.model && !models.includes(snapshot.model)) models.push(snapshot.model)
        return {
          preset: preset.preset,
          label: preset.label,
          enabled: settings.providersEnabled[preset.preset] ?? true,
          keyConfigured: this.deps.secrets.status(preset.preset).configured,
          connected: Boolean(snapshot?.capabilities && snapshot.checkedAt),
          models
        }
      }),
      rows,
      characters,
      canRollback: rollbackable !== undefined,
      auditCount: host.repos.modelBinding.listAudit(projectId).length
    }
  }

  setBindings(input: BindingSetInput): BindingMatrix {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project || project.id !== input.projectId) throw new AppError('project_not_found', 'project mismatch')
    const settings = this.read()

    for (const change of input.changes) {
      this.assertBindable(host.repos, settings, project.id, change)
    }

    const batchId = `bnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const actor = this.deps.actor ?? 'author'
    withTransaction(host.db, () => {
      for (const change of input.changes) {
        const params: Record<string, unknown> = {}
        if (change.temperature !== undefined && change.temperature !== null) params.temperature = change.temperature
        if (change.maxTokens !== undefined && change.maxTokens !== null) params.maxTokens = change.maxTokens
        host.repos.modelBinding.upsert(
          {
            projectId: project.id,
            agentKey: change.agentKey,
            provider: change.provider,
            model: change.model,
            paramsJson: JSON.stringify(params)
          },
          actor,
          batchId
        )
      }
    })
    this.deps.log?.('settings_bindings_set', { projectId: project.id, batchId, count: input.changes.length })
    return this.bindings(project.id)
  }

  /** 回滚最近一批未被回滚过的绑定变更；回滚本身也写一批审计。 */
  rollback(projectId: string): BindingMatrix {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project || project.id !== projectId) throw new AppError('project_not_found', 'project mismatch')

    const batches = host.repos.modelBinding.listBatches(projectId)
    const rolledBack = new Set(host.repos.modelBinding.rolledBackBatches(projectId))
    const rollbackAudits = new Set(host.repos.modelBinding.rollbackAuditBatches(projectId))
    const target = batches.find(
      (batch) => !rolledBack.has(batch.batchId) && !rollbackAudits.has(batch.batchId)
    )
    if (!target) throw new AppError('invalid_args', '没有可回滚的绑定变更')

    const entries = host.repos.modelBinding.listBatchEntries(projectId, target.batchId)
    const actor = this.deps.actor ?? 'author'
    const auditBatchId = `bnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const seen = new Set<string>()

    withTransaction(host.db, () => {
      for (const entry of entries) {
        if (seen.has(entry.agentKey)) continue
        seen.add(entry.agentKey)
        const current = host.repos.modelBinding.get(projectId, entry.agentKey)
        const previous = entry.oldJson === null ? null : (JSON.parse(entry.oldJson) as { provider?: string; model?: string; paramsJson?: string })
        const at = this.now()
        if (previous === null) {
          host.repos.modelBinding.delete(projectId, entry.agentKey)
          host.repos.modelBinding.recordAudit({
            projectId,
            agentKey: entry.agentKey,
            oldJson: current ? JSON.stringify(current) : null,
            newJson: JSON.stringify({ agentKey: entry.agentKey, deleted: true }),
            actor,
            createdAt: at,
            batchId: auditBatchId
          })
          continue
        }
        host.repos.modelBinding.upsert(
          {
            projectId,
            agentKey: entry.agentKey,
            provider: previous.provider ?? project.defaultPreset,
            model: previous.model ?? defaultModelFor(project.defaultPreset),
            paramsJson: previous.paramsJson ?? '{}'
          },
          actor,
          auditBatchId
        )
      }
      host.repos.modelBinding.recordRollback({
        projectId,
        batchId: target.batchId,
        auditBatchId,
        actor,
        createdAt: this.now()
      })
    })
    this.deps.log?.('settings_bindings_rollback', { projectId, batchId: target.batchId, entries: seen.size })
    return this.bindings(projectId)
  }

  audit(projectId: string): BindingAuditEntry[] {
    const host = this.requireHost()
    return host.repos.modelBinding.listAudit(projectId).map((entry) => {
      const old = entry.oldJson === null ? null : (JSON.parse(entry.oldJson) as { provider?: string; model?: string })
      const next = JSON.parse(entry.newJson) as { provider?: string; model?: string }
      return {
        id: entry.id,
        agentKey: entry.agentKey,
        batchId: entry.batchId,
        oldProvider: old?.provider ?? null,
        oldModel: old?.model ?? null,
        newProvider: next.provider ?? '—',
        newModel: next.model ?? '—',
        actor: entry.actor,
        createdAt: entry.createdAt
      }
    })
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  private requireHost(): SettingsHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '没有打开的项目')
    return host
  }

  private capabilitiesLookup(settings: Settings): CapabilitiesLookup {
    return (provider, model) => {
      const snapshot = settings.providers[provider]
      return snapshot?.capabilities ?? capabilitiesFor(provider, model)
    }
  }

  private providerCard(settings: Settings, preset: Preset): ProviderCard {
    const meta = findPreset(preset)!
    const snapshot = settings.providers[preset]
    return {
      preset,
      label: PRESET_LABELS[preset],
      baseUrl: baseUrlFor(preset, snapshot?.baseUrl ?? null),
      enabled: settings.providersEnabled[preset] ?? true,
      key: this.deps.secrets.status(preset),
      connected: Boolean(snapshot?.capabilities && snapshot.checkedAt),
      checkedAt: snapshot?.checkedAt ?? null,
      capabilities: snapshot?.capabilities ?? null,
      models: meta.models.map((model) => ({
        id: model.id,
        capabilities: model.capabilities,
        pricingKnown: model.capabilities.pricing.in > 0 || model.capabilities.pricing.out > 0
      }))
    }
  }

  private projectRow(
    repos: Repos,
    projectId: string,
    defaultPreset: string,
    recent: Record<string, { at: string }>
  ): BindingRow {
    const preset = asPreset(defaultPreset, 'deepseek')
    const record = repos.modelBinding.get(projectId, 'project')
    const provider = record ? asPreset(record.provider, preset) : preset
    const model = record?.model ?? defaultModelFor(preset)
    const params = record ? safeParams(record.paramsJson) : {}
    return {
      agentKey: 'project',
      label: '项目默认',
      kind: 'project',
      provider,
      model,
      source: record ? 'project' : 'preset',
      version: record?.version ?? 0,
      temperature: numberParam(params, 'temperature'),
      maxTokens: numberParam(params, 'maxTokens'),
      recentlyUsedAt: recent['project']?.at ?? null,
      tested: this.testedFor(provider)
    }
  }

  private agentRow(
    labelKey: string,
    agentKey: string,
    kind: 'agent' | 'character',
    binding: ResolvedBinding,
    recent: { at: string } | null
  ): BindingRow {
    return {
      agentKey,
      label: agentKey.startsWith('character:') ? `角色实例 · ${agentKey.slice('character:'.length)}` : agentLabelFor(labelKey),
      kind,
      provider: asPreset(binding.provider, 'deepseek'),
      model: binding.model,
      source: binding.source,
      version: binding.version,
      temperature: numberParam(binding.params, 'temperature'),
      maxTokens: numberParam(binding.params, 'maxTokens'),
      recentlyUsedAt: recent?.at ?? null,
      tested: this.testedFor(asPreset(binding.provider, 'deepseek'))
    }
  }

  private testedFor(preset: Preset): boolean | null {
    const snapshot = this.read().providers[preset]
    if (!snapshot) return null
    return Boolean(snapshot.capabilities && snapshot.checkedAt)
  }

  private assertBindable(repos: Repos, settings: Settings, projectId: string, change: BindingChange): void {
    const key = change.agentKey
    if (key !== 'project' && !(AGENT_KEYS as readonly string[]).includes(key) && !key.startsWith('character:')) {
      throw new AppError('invalid_args', `未知的 Agent 绑定键：${key}`)
    }
    if (key.startsWith('character:')) {
      const characterId = key.slice('character:'.length)
      const character = repos.character.get(characterId)
      if (!character || character.projectId !== projectId) {
        throw new AppError('invalid_args', `角色实例不存在：${characterId}`)
      }
    }
    const meta = findPreset(change.provider)
    if (!meta) throw new AppError('invalid_args', `未知供应商：${change.provider}`)
    const knownModel =
      meta.models.some((model) => model.id === change.model) ||
      settings.providers[change.provider]?.model === change.model
    if (!knownModel) throw new AppError('invalid_args', `模型不在预设清单里：${change.model}`)

    const snapshot = settings.providers[change.provider]
    // PRD §5.6：不允许绑定到未通过连接测试的模型。
    if (!snapshot?.capabilities || !snapshot.checkedAt) {
      throw new AppError('model_untested', `${PRESET_LABELS[change.provider]} 还没有通过测试连接`, {
        preset: change.provider
      })
    }
  }
}

function safeParams(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
