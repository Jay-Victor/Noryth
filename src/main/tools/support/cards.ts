/** 角色卡读取与公开投影：公开档案不得含欲望、恐惧、禁忌、私有记忆。 */

export type CharacterCard = Record<string, unknown>

export function parseCard(json: string): CharacterCard {
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as CharacterCard
    return {}
  } catch {
    return {}
  }
}

const PUBLIC_KEYS = ['role', 'age', 'appearance', 'public_identity', 'public_voice', 'voice', 'title', 'occupation']

export interface PublicProfile {
  id: string
  name: string
  role: string | null
  age: number | null
  appearance: string | null
  public_identity: string | null
  public_voice: string | null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** 只保留公开字段（白名单），其余一律不下发。 */
export function publicProfile(id: string, name: string, card: CharacterCard): PublicProfile {
  const age = typeof card.age === 'number' && Number.isFinite(card.age) ? card.age : null
  return {
    id,
    name,
    role: stringOrNull(card.role),
    age,
    appearance: stringOrNull(card.appearance),
    public_identity: stringOrNull(card.public_identity),
    public_voice: stringOrNull(card.public_voice ?? card.voice)
  }
}

/** 供校验与测试确认公开投影没有泄漏私有键。 */
export const PRIVATE_CARD_KEYS = [
  'want',
  'desire',
  'fear',
  'flaw',
  'secret',
  'taboo',
  'private',
  'memory',
  'knowledge',
  'known',
  'unknown',
  'arc'
] as const

export function assertNoPrivateKeys(profile: Record<string, unknown>): boolean {
  return !PRIVATE_CARD_KEYS.some((key) => key in profile)
}

export { PUBLIC_KEYS }
