import { AppError } from '../../shared/domain/app-error'
import type {
  WorldFactActionResult,
  WorldFactAddInput,
  WorldFactCloseInput,
  WorldProjectionInput,
  WorldProjectionState
} from '../../shared/schema/memory'
import type { Db } from '../db/project-db'
import type { Repos } from '../db/repos'
import { applyAuthorFact, closeAuthorFact } from '../memory/apply'
import { buildAuthorFactCloseInput, buildAuthorFactInput } from './author-facts'
import { projectWorld } from './projection'

/**
 * 世界状态服务（PHASE-13 M1-3 / M1-18）。
 *
 * 读：把 `world_fact` / `character_belief` / `relationship_edge` 投影到某个 as_of。
 * 写：只调用 `memory/apply.ts` 的 `applyAuthorFact` / `closeAuthorFact`——
 *     「世界状态只有一个写入者」在依赖方向上就是这一行 import（R2）。
 *
 * 作者视图是全量（含秘密）；限制只针对 Agent / 审批 / 检索上下文，
 * 日志里用 `world_projection_author` 区分来源（PHASE-13 §5.3）。
 */

export interface WorldHost {
  db: Db
  repos: Repos
  readOnly: boolean
}

export interface WorldServiceDeps {
  host: () => WorldHost | null
  log?: (message: string, details?: Record<string, unknown>) => void
}

function clampAsOf(value: number | undefined, ceiling: number): number {
  if (value === undefined || !Number.isFinite(value)) return ceiling
  return Math.max(0, Math.min(Math.trunc(value), Math.max(0, ceiling)))
}

export class WorldService {
  constructor(private readonly deps: WorldServiceDeps) {}

  private requireHost(): WorldHost {
    const host = this.deps.host()
    if (!host) throw new AppError('project_not_found', '没有打开的项目')
    return host
  }

  private requireWritable(): WorldHost {
    const host = this.requireHost()
    if (host.readOnly) throw new AppError('project_locked', '项目以只读方式打开')
    return host
  }

  /**
   * as-of 投影。`asOf` 省略时取本章 `covered_until_seq`（作者默认看「当前章结束」）。
   * 只能读 `[0, seq_head]`：作者可以回放，但不能越过项目水位。
   */
  projection(input: WorldProjectionInput = {}): WorldProjectionState {
    const host = this.requireHost()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')

    const chapter =
      input.chapterId === undefined ? null : host.repos.chapter.get(input.chapterId)
    if (input.chapterId !== undefined && (!chapter || chapter.projectId !== project.id)) {
      throw new AppError('invalid_args', '本章不存在', { chapterId: input.chapterId })
    }

    const asOf = clampAsOf(
      input.asOf ?? (chapter ? chapter.coveredUntilSeq : project.seqHead),
      project.seqHead
    )
    const projected = projectWorld({
      asOf,
      facts: host.repos.world.listByProject(project.id),
      beliefs: host.repos.belief.listByProject(project.id),
      edges: host.repos.relationship.listActiveAll()
    })

    return {
      projectId: project.id,
      seqHead: project.seqHead,
      chapterId: chapter?.id ?? null,
      chapterOrd: chapter?.ord ?? null,
      /** 本章认知快照水位；null = 没有选章（项目水位视图）。 */
      coverage: chapter ? chapter.coveredUntilSeq : null,
      readOnly: host.readOnly,
      characters: host.repos.character.list(project.id).map((character) => ({
        id: character.id,
        name: character.name
      })),
      ...projected
    }
  }

  addFact(input: WorldFactAddInput): WorldFactActionResult {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')

    const characterIds = new Set(host.repos.character.list(project.id).map((character) => character.id))
    const built = buildAuthorFactInput(
      {
        subject: input.subject,
        predicate: input.predicate,
        object: input.object,
        truth: input.truth,
        visibility: input.visibility,
        knownBy: input.knownBy ?? [],
        revealSeq: input.revealSeq ?? null,
        ...(input.validFromSeq === undefined ? {} : { validFromSeq: input.validFromSeq })
      },
      { projectId: project.id, seqHead: project.seqHead, characterIds }
    )

    const applied = applyAuthorFact(host.db, host.repos, built)
    this.deps.log?.('world_fact_added', {
      factId: applied.factId,
      projectId: project.id,
      truth: built.truth,
      singleValue: built.singleValue,
      validFromSeq: built.validFromSeq,
      superseded: applied.superseded,
      duplicate: applied.duplicate
    })

    const detail = applied.duplicate
      ? '已存在同一事实，没有重复写入'
      : built.singleValue === 1 && applied.superseded.length > 0
        ? '已新增事实；单值槽的旧值已关闭'
        : '已新增事实'

    return {
      projection: this.projection(this.projectionInputOf(input)),
      factId: applied.factId,
      detail
    }
  }

  closeFact(input: WorldFactCloseInput): WorldFactActionResult {
    const host = this.requireWritable()
    const project = host.repos.project.get()
    if (!project) throw new AppError('project_not_found', 'project row missing')

    const built = buildAuthorFactCloseInput(
      { factId: input.factId, reason: input.reason ?? null },
      {
        projectId: project.id,
        seqHead: project.seqHead,
        fact: host.repos.world.get(input.factId)
      }
    )
    const closed = closeAuthorFact(host.repos, built.input)
    this.deps.log?.('world_fact_closed', {
      factId: closed.factId,
      projectId: project.id,
      seq: built.input.seq,
      duplicate: closed.duplicate
    })

    return {
      projection: this.projection(this.projectionInputOf(input)),
      factId: closed.factId,
      detail: closed.duplicate ? '这条事实已经是关闭状态' : '已关闭事实（不删除，仍可回放）'
    }
  }

  private projectionInputOf(input: { chapterId?: string; asOf?: number }): WorldProjectionInput {
    return {
      ...(input.chapterId === undefined ? {} : { chapterId: input.chapterId }),
      ...(input.asOf === undefined ? {} : { asOf: input.asOf })
    }
  }
}
