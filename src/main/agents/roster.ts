import { parseCharacterCard, withPublicFields } from '../../shared/schema/plan'
import type { Repos } from '../db/repos'

/**
 * 注册清单落库（PHASE-06 E4）。
 *
 * 规划 Agent 只提交 `roster.propose` 提案；作者应用后得到 `plan_character` 草案；
 * G1 通过后由这里把草案注册成正式 `character`，ID 保持稳定（card_version 继承）。
 *
 * 不建库、不写世界状态：命名空间在 memory/namespace，初值在 memory/setup。
 */
export function registerRoster(repos: Repos, projectId: string): number {
  let registered = 0
  for (const planCharacter of repos.planCharacter.listByProject(projectId)) {
    if (planCharacter.status === 'registered' && planCharacter.registeredCharacterId) continue
    const card = withPublicFields(parseCharacterCard(planCharacter.cardJson))
    const existing =
      repos.character.get(planCharacter.id) ?? repos.character.byName(projectId, planCharacter.name)
    const character =
      existing ??
      repos.character.insert({
        id: planCharacter.id,
        projectId,
        name: planCharacter.name,
        cardJson: JSON.stringify(card),
        cardVersion: planCharacter.cardVersion
      })
    if (existing) repos.character.updateCard(existing.id, JSON.stringify(card))
    repos.planCharacter.markRegistered(planCharacter.id, character.id)
    registered += 1
  }
  return registered
}
