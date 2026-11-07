/**
 * 导演的机械动作：抽事件卡、冲突升级、关系突变检测。
 * 导演是代码，不是"更聪明的 Agent"。
 */
import { PARAMS } from './params.js';

const {
  'scene.max_level': MAX_LEVEL,
  'scene.event_card_interval': CARD_INTERVAL,
  'consistency.relation_jump_threshold': RELATION_JUMP,
  'scheduler.stake_base': STAKE_BASE,
  'scheduler.stake_conflict': STAKE_CONFLICT,
  'scheduler.stake_secret': STAKE_SECRET,
  'scheduler.stake_ownership': STAKE_OWNERSHIP,
} = PARAMS;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export interface DeckCard {
  id: string;
  minLevel: number;
  consumed: boolean;
  oneShot: boolean;
  /** 本次抽牌标记；普通卡回到牌堆时会重置（只有 oneShot 会写 consumed）。 */
  used?: boolean;
}

export interface DrawResult {
  card: DeckCard | null;
  deck: DeckCard[];
}

/**
 * 抽牌时机：固定间隔 或 冲突平坦。
 * 触发谓词不满足的牌留在牌堆不消耗——否则一场戏抽空牌堆却什么都没发生。
 */
export function drawEventCard(
  deck: readonly DeckCard[],
  level: number,
  turn: number,
  flat: boolean,
  interval: number = CARD_INTERVAL,
): DrawResult {
  if (!(turn % interval === 0 || flat)) {
    return { card: null, deck: [...deck] };
  }
  for (let i = 0; i < deck.length; i += 1) {
    const candidate = deck[i]!;
    if (candidate.consumed) continue;
    if (candidate.minLevel > level) continue;
    if (candidate.oneShot && candidate.used) continue;
    const rest = [...deck.slice(0, i), ...deck.slice(i + 1)];
    const card: DeckCard = { ...candidate, used: true };
    if (card.oneShot) card.consumed = true;
    return { card, deck: rest };
  }
  return { card: null, deck: [...deck] };
}

export interface RelationJump {
  delta: number;
  verdict: 'ok' | 'needs_justification';
}

/** 单拍关系突变检测：Δ 超阈值 → 要求理由或钳制，不允许静默通过。 */
export function relationJump(
  oldValue: number,
  newValue: number,
  threshold: number = RELATION_JUMP,
): RelationJump {
  const delta = Math.abs(newValue - oldValue);
  return {
    delta: Number(delta.toFixed(3)),
    verdict: delta <= threshold ? 'ok' : 'needs_justification',
  };
}

/**
 * stake ∈ [0,1]。conflict 先归一到 0–1 再乘系数——不归一的话高冲突段会
 * 饱和到 1.0，所有在场角色的 stake 变成同一个数，评分里 0.16 这一项
 * 就失去区分度。满配 0.15+0.22+0.30+0.20 = 0.87 < 1，永远不会触顶。
 */
export function stakeOf(
  conflictLevel: number,
  secretThreat: boolean,
  ownership = 0,
): number {
  const conflict = clamp(conflictLevel / MAX_LEVEL, 0, 1);
  return clamp(
    STAKE_BASE +
      STAKE_CONFLICT * conflict +
      (secretThreat ? STAKE_SECRET : 0) +
      STAKE_OWNERSHIP * clamp(ownership, 0, 1),
    0,
    1,
  );
}
