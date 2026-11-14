import { AppError } from '../../shared/domain/app-error'
import type { Capabilities } from '../../shared/schema/model'
import type { Repos } from '../db/repos'
import type { ModelBindingRecord } from '../db/repos/model'
import type { ProjectRecord } from '../db/repos/project'
import type { AgentInstanceKey } from '../tools/types'
import { sha256Hex } from '../crypto'
import { defaultModelFor } from './presets'

/**
 * 绑定解析与冻结（PRD §9.3 / DEV-PLAN §7.7 / PHASE-04 D6）。
 *
 * 解析顺序：
 *   character:<id> → character → project（显式行或 default_preset）
 *   其他 Agent     → 该 Agent → project
 *
 * job 创建时冻结成 BindingSnapshot 写进 job.payload_json；
 * job 内所有拍复用快照，运行中改绑定只影响下一个 job。
 *
 * capabilities 也随绑定冻结：优先使用调用方传入的探测结果（settings.providers），
 * 否则回落到预设表。这样「探测不到 tool calling」的模型在 job 内走 JSON 回退，
 * 而不是运行到一半改能力。
 */

export type BindingSource = 'instance' | 'agent' | 'project' | 'preset'

export interface ResolvedBinding {
  agentKey: string
  provider: string
  model: string
  params: Record<string, unknown>
  version: number
  source: BindingSource
  capabilities?: Capabilities
}

export type CapabilitiesLookup = (provider: string, model: string) => Capabilities | null

export interface BindingSnapshot {
  version: 1
  at: string
  bindings: Record<string, ResolvedBinding>
  hash: string
}

function paramsOf(record: ModelBindingRecord | null): Record<string, unknown> {
  if (!record) return {}
  try {
    const parsed = JSON.parse(record.paramsJson) as unknown
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function fromRecord(agentKey: string, record: ModelBindingRecord, source: BindingSource): ResolvedBinding {
  return {
    agentKey,
    provider: record.provider,
    model: record.model,
    params: paramsOf(record),
    version: record.version,
    source
  }
}

function presetBinding(project: ProjectRecord, agentKey: string): ResolvedBinding {
  return {
    agentKey,
    provider: project.defaultPreset,
    model: defaultModelFor(project.defaultPreset),
    params: {},
    version: 0,
    source: 'preset'
  }
}

function projectDefault(repos: Repos, project: ProjectRecord, agentKey: string): ResolvedBinding {
  const record = repos.modelBinding.get(project.id, 'project')
  return record ? fromRecord(agentKey, record, 'project') : presetBinding(project, agentKey)
}

function attachCapabilities(
  binding: ResolvedBinding,
  lookup?: CapabilitiesLookup
): ResolvedBinding {
  // 只有调用方明确给了探测结果才冻结；否则由 runTurn 回落到 params / 预设表。
  const capabilities = lookup?.(binding.provider, binding.model)
  return capabilities ? { ...binding, capabilities } : binding
}

export function resolveBinding(
  repos: Repos,
  project: ProjectRecord,
  agentKey: AgentInstanceKey,
  lookup?: CapabilitiesLookup
): ResolvedBinding {
  if (agentKey.startsWith('character:')) {
    const instance = repos.modelBinding.get(project.id, agentKey)
    if (instance) return attachCapabilities(fromRecord(agentKey, instance, 'instance'), lookup)
    const role = repos.modelBinding.get(project.id, 'character')
    if (role) return attachCapabilities(fromRecord(agentKey, role, 'agent'), lookup)
    return attachCapabilities(projectDefault(repos, project, agentKey), lookup)
  }

  const agent = repos.modelBinding.get(project.id, agentKey)
  if (agent) return attachCapabilities(fromRecord(agentKey, agent, 'agent'), lookup)
  return attachCapabilities(projectDefault(repos, project, agentKey), lookup)
}

export function freezeBindings(
  repos: Repos,
  project: ProjectRecord,
  agentKeys: readonly AgentInstanceKey[],
  at: string,
  lookup?: CapabilitiesLookup
): BindingSnapshot {
  const bindings: Record<string, ResolvedBinding> = {}
  for (const key of [...new Set(agentKeys)].sort()) {
    bindings[key] = resolveBinding(repos, project, key, lookup)
  }
  const hash = sha256Hex(
    JSON.stringify(
      Object.keys(bindings)
        .sort()
        .map((key) => {
          const binding = bindings[key]!
          const caps = binding.capabilities
          const capsKey = caps
            ? `${caps.stream}/${caps.tools}/${caps.jsonMode}/${caps.contextWindow}`
            : 'none'
          return `${key}|${binding.provider}|${binding.model}|${binding.version}|${capsKey}`
        })
        .join('\n')
    )
  )
  return { version: 1, at, bindings, hash }
}

/** job 内取绑定：只查快照，绝不回数据库；找不到即配置错误。 */
export function bindingFor(snapshot: BindingSnapshot, agentKey: AgentInstanceKey): ResolvedBinding {
  const direct = snapshot.bindings[agentKey]
  if (direct) return direct
  if (agentKey.startsWith('character:')) {
    const role = snapshot.bindings.character
    if (role) return role
  }
  const project = snapshot.bindings.project
  if (project) return project
  throw new AppError('setup_incomplete', 'job 缺少模型绑定快照', { agentKey })
}

export function setBinding(
  repos: Repos,
  input: {
    projectId: string
    agentKey: string
    provider: string
    model: string
    params?: Record<string, unknown>
  },
  actor: string
): ResolvedBinding {
  const record = repos.modelBinding.upsert(
    {
      projectId: input.projectId,
      agentKey: input.agentKey,
      provider: input.provider,
      model: input.model,
      paramsJson: JSON.stringify(input.params ?? {})
    },
    actor
  )
  return attachCapabilities(
    fromRecord(input.agentKey, record, input.agentKey === 'project' ? 'project' : 'agent')
  )
}

/** 绑定变更只影响下一个 job；审计由 repo 在同一次写入里落库。 */
export function bindingAuditSummary(repos: Repos, projectId: string): Array<{
  agentKey: string
  oldJson: string | null
  newJson: string
  actor: string
  createdAt: string
}> {
  return repos.modelBinding.listAudit(projectId).map((entry) => ({
    agentKey: entry.agentKey,
    oldJson: entry.oldJson,
    newJson: entry.newJson,
    actor: entry.actor,
    createdAt: entry.createdAt
  }))
}
