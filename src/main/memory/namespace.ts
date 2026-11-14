import { AppError } from '../../shared/domain/app-error'
import type { Repos } from '../db/repos'

/**
 * 记忆命名空间与隔离自检（PHASE-06 §5.3 / PRD §4.10 T38）。
 *
 * M0 的「库」是命名空间登记 + 记忆条目的 character_id 约束；向量索引在阶段 09
 * 接入后，同一套命名空间名会作为检索过滤键。这里先保证：
 * - 每个角色一个私有命名空间，项目一个公共设定库；
 * - 幂等：重复调用返回原命名空间，不重复插入；
 * - 隔离自检：私有库里的条目必须全部属于本人，跨角色探针命中数必须为 0。
 */

export interface NamespaceView {
  characterId: string | null
  kind: 'private' | 'public'
  name: string
  entries: number
}

export interface NamespaceResult {
  namespaces: NamespaceView[]
  isolationVerified: boolean
  created: number
}

export interface EnsureNamespaceOptions {
  /** 测试注入：创建 N 个命名空间后抛错，用来验证半失败可重试。 */
  failAfter?: number
  /** 调用方注入的一次性失败钩子（E2E 用标记文件实现）。 */
  failHook?: () => boolean
}

export function namespaceName(projectId: string, characterId: string | null): string {
  return characterId === null ? `${projectId}:canon` : `${projectId}:mem:${characterId}`
}

export function ensureNamespaces(
  repos: Repos,
  projectId: string,
  options: EnsureNamespaceOptions = {}
): NamespaceResult {
  const project = repos.project.getById(projectId)
  if (!project) throw new AppError('project_not_found', 'project row missing')

  const characters = repos.character.list(projectId, { status: 'active' })
  if (characters.length === 0) {
    throw new AppError('setup_incomplete', '没有可建库的角色')
  }

  let created = 0
  const maybeFail = (): void => {
    if (options.failHook?.()) {
      throw new AppError('setup_incomplete', '命名空间创建失败（模拟一次）')
    }
    if (options.failAfter !== undefined && created >= options.failAfter) {
      throw new AppError('setup_incomplete', `命名空间创建在第 ${created + 1} 个失败（模拟）`)
    }
  }

  maybeFail()
  const beforePublic = repos.namespace.publicNamespace(projectId)
  if (!beforePublic) {
    repos.namespace.ensurePublic(projectId, namespaceName(projectId, null))
    created += 1
  }

  for (const character of characters) {
    maybeFail()
    const existing = repos.namespace.byCharacter(projectId, character.id)
    if (!existing) {
      repos.namespace.ensurePrivate(projectId, character.id, namespaceName(projectId, character.id))
      created += 1
    }
  }

  const namespaces = repos.namespace.listByProject(projectId)
  const privateNamespaces = namespaces.filter((item) => item.kind === 'private')
  const publicNamespace = namespaces.find((item) => item.kind === 'public') ?? null

  const isolation = checkIsolation(repos, projectId, characters.map((character) => character.id))
  const verified =
    isolation.crossCharacterHits === 0 &&
    isolation.orphanEntries === 0 &&
    publicNamespace !== null &&
    privateNamespaces.length === characters.length

  repos.namespace.setIsolationVerified(projectId, verified)

  return {
    namespaces: namespaces.map((item) => ({
      characterId: item.characterId,
      kind: item.kind,
      name: item.name,
      entries: item.characterId ? repos.memory.listByCharacter(item.characterId).length : 0
    })),
    isolationVerified: verified,
    created
  }
}

export interface IsolationReport {
  crossCharacterHits: number
  orphanEntries: number
  verified: boolean
}

/**
 * 隔离探针：用每个角色自己的检索入口取一遍，确认返回条目的 character_id
 * 全部等于本人；再确认项目内没有指向不存在角色的记忆条目。
 *
 * 阶段 09 接入向量检索后，这里会换成「用同一 query 对每个命名空间做 top_k」
 * 的探针，命中集合仍需为 0。
 */
export function checkIsolation(repos: Repos, projectId: string, characterIds: readonly string[]): IsolationReport {
  const known = new Set(characterIds)
  let crossCharacterHits = 0
  for (const characterId of characterIds) {
    const entries = repos.memory.listByCharacter(characterId)
    for (const entry of entries) {
      if (entry.characterId !== characterId || !known.has(entry.characterId)) crossCharacterHits += 1
    }
  }
  const orphanEntries = repos.memory
    .listByProject(projectId)
    .filter((entry) => !known.has(entry.characterId)).length
  return {
    crossCharacterHits,
    orphanEntries,
    verified: crossCharacterHits === 0 && orphanEntries === 0
  }
}
