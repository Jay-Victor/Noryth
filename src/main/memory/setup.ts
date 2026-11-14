import type { Repos } from '../db/repos'

/**
 * 规划 → 世界状态的初始化（PHASE-06 G1）。
 *
 * 世界状态/记忆域的写入归 memory 子系统：G1 只调用这里，不直接写 world_fact。
 * 阶段 09 引入完整的 MemoryExecutor 后，这个函数成为它的 setup 入口；
 * 规划台与 Agent 都不直接写世界状态。
 */

export interface InitialFactResult {
  applied: number
  skipped: number
}

export function applyInitialFacts(repos: Repos, projectId: string): InitialFactResult {
  let applied = 0
  let skipped = 0
  for (const fact of repos.planFact.listByProject(projectId)) {
    if (fact.status === 'applied') {
      skipped += 1
      continue
    }
    const current = repos.world.current(fact.subject, fact.predicate)
    if (current && current.object === fact.object) {
      repos.planFact.markApplied(fact.id)
      skipped += 1
      continue
    }
    repos.world.insert({
      projectId,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      singleValue: 1,
      truth: 'objective',
      visibility: fact.visibility,
      knownByJson: '[]',
      validFromSeq: 0,
      sourceType: 'author'
    })
    repos.planFact.markApplied(fact.id)
    applied += 1
  }
  return { applied, skipped }
}
