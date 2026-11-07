/**
 * P1 · 回退的领域契约。
 *
 * 回退覆盖 8 个状态域（01 §1 I3 / §6 A6）。少退一个域不会报错，
 * 只在下一轮表现为"角色说漏了"——所以这 8 个名字必须只有一份，
 * 由 store 的计数、CLI 的确认框、门禁脚本共用。
 */

export const RESTORE_DOMAINS = [
  { key: 'messages', label: '消息' },
  { key: 'facts', label: '事实' },
  { key: 'cognition', label: '认知' },
  { key: 'relations', label: '关系' },
  { key: 'chapters', label: '正文' },
  { key: 'cards', label: '卡牌' },
  { key: 'summaries', label: '摘要' },
  { key: 'vectors', label: '向量' },
] as const;

export type DomainKey = (typeof RESTORE_DOMAINS)[number]['key'];
export type DomainCounts = Record<DomainKey, number>;

export interface DomainImpact {
  key: DomainKey;
  label: string;
  current: number;
  target: number;
  lost: number;
}

export function emptyDomainCounts(): DomainCounts {
  return {
    messages: 0,
    facts: 0,
    cognition: 0,
    relations: 0,
    chapters: 0,
    cards: 0,
    summaries: 0,
    vectors: 0,
  };
}

/** 回退确认框里的"影响"：每个域会失去多少行（04 §7）。 */
export function domainImpact(current: DomainCounts, target: DomainCounts): DomainImpact[] {
  return RESTORE_DOMAINS.map(({ key, label }) => ({
    key,
    label,
    current: current[key],
    target: target[key],
    lost: Math.max(0, current[key] - target[key]),
  }));
}

/**
 * 新分支命名。回退永远开新分支，旧分支保留（I3）；
 * 同名时加 `-2`、`-3`，不覆盖已有分支记录。
 */
export function uniqueBranchName(existing: readonly string[], base = 'main'): string {
  const used = new Set(existing);
  let index = 1;
  for (;;) {
    const name = `${base}~r${index}`;
    if (!used.has(name)) return name;
    index += 1;
  }
}

/** target 必须严格早于当前 head；回退到 head 只会制造空分支（A6 边界）。 */
export function validateRestoreTarget(target: number, headSeq: number): void {
  if (!Number.isInteger(target) || target < 0) {
    throw new Error(`回退目标必须是非负整数：${target}`);
  }
  if (target >= headSeq) {
    throw new Error(`回退目标 ${target} 不早于当前 head ${headSeq}：回退到当前 head 没有意义`);
  }
}
