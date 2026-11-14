import type { Db } from '../project-db'
import { createQueryRunner } from '../kysely'
import { BeatRepo } from './beat'
import { ChapterRepo } from './chapter'
import { CharacterRepo } from './character'
import { systemClock, type Clock } from './common'
import { JobRepo } from './job'
import { MemoryRepo } from './memory'
import { MemoryProposalRepo } from './memory-proposal'
import { OutlineRepo } from './outline'
import { OutboxRepo } from './outbox'
import { PatchRepo } from './patch'
import { ProjectRepo } from './project'
import { ReviewRepo, GateRepo } from './review'
import { RevisionRepo } from './revision'
import { SceneRepo } from './scene'
import { ToolCallRepo } from './tool-call'
import { CharacterBeliefRepo, RelationshipRepo, WorldFactRepo } from './world'

export interface RepoOptions {
  now?: Clock
}

/**
 * 存储层入口：所有 repo 共享同一连接与同一时钟。
 * repo 只做事务内的读写原语，不判断「能不能写」（PHASE-02 §5.5）。
 */
export function createRepos(db: Db, options: RepoOptions = {}) {
  const now = options.now ?? systemClock
  const runner = createQueryRunner(db)
  return {
    project: new ProjectRepo(runner, now),
    outline: new OutlineRepo(runner, now),
    character: new CharacterRepo(runner, now),
    chapter: new ChapterRepo(runner, now),
    scene: new SceneRepo(runner, now),
    beat: new BeatRepo(runner, now),
    revision: new RevisionRepo(runner, now),
    patch: new PatchRepo(runner, now),
    memory: new MemoryRepo(runner, now),
    memoryProposal: new MemoryProposalRepo(runner, now),
    world: new WorldFactRepo(runner, now),
    belief: new CharacterBeliefRepo(runner, now),
    relationship: new RelationshipRepo(runner),
    review: new ReviewRepo(runner, now),
    gate: new GateRepo(runner, now),
    job: new JobRepo(runner, now),
    toolCall: new ToolCallRepo(runner, now),
    outbox: new OutboxRepo(runner, now)
  }
}

export type Repos = ReturnType<typeof createRepos>

export * from './beat'
export * from './chapter'
export * from './character'
export * from './common'
export * from './job'
export * from './memory'
export * from './memory-proposal'
export * from './outline'
export * from './outbox'
export * from './patch'
export * from './project'
export * from './review'
export * from './revision'
export * from './scene'
export * from './tool-call'
export * from './world'
