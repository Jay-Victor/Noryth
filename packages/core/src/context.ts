/**
 * A2 · 上下文装配：配额 + 降级阶梯。
 *
 * 不变式：tokens ≤ budget 恒成立；宁可整条丢弃，也不截断半句——
 * 截断会让模型看到半句话然后自己补全。
 *
 * 七段配额（RATIOS）的生效时机（01-architecture.md §6 A2）：
 * - 常态：按 full → summary → triple → id 整体降级，某一级总量 ≤ budget 即停；
 *   文档里的实测数字（40 拍 / 200 事实 → 4352 tok / full）走的就是这条路径。
 * - 极端：id 级仍超预算时，才按 budget × ratio 逐段裁剪——已知段保留到配额，
 *   未知段只受全局预算约束；若仍超，再全局按 keepRank 整条丢弃。
 * 配额是"超预算时的公平上限"，不是常态硬切；否则 `recent` 一段小、别的段
 * 有空间时也会被浪费，与 A2 的实测表对不上。
 */
import { estTokens } from './tokens.js';
import { LEVELS, RATIOS, type PackLevel } from './params.js';

export interface PackItem {
  full: string;
  summary: string;
  triple: string;
  id: string;
  /** 越小越先保留；缺省 9（与探针一致）。 */
  keepRank?: number;
}

export interface PackSection {
  name: string;
  items: readonly PackItem[];
}

export interface KeptItem {
  section: string;
  item: PackItem;
}

export type PackResultLevel = PackLevel | 'id+drop';

export interface PackResult {
  kept: KeptItem[];
  level: PackResultLevel;
  tokens: number;
  dropped: number;
}

const SECTION_RATIO: Readonly<Record<string, number>> = RATIOS;

function keepRank(item: PackItem): number {
  return item.keepRank ?? 9;
}

function quotaOf(section: string, budget: number): number | null {
  const ratio = SECTION_RATIO[section];
  return ratio === undefined ? null : Math.floor(budget * ratio);
}

/** 已知段各自保留到 quota；未知段不参与配额，只受全局预算约束。 */
function trimByQuota(flat: readonly KeptItem[], budget: number): KeptItem[] {
  const groups = new Map<string, KeptItem[]>();
  for (const entry of flat) {
    const list = groups.get(entry.section);
    if (list) list.push(entry);
    else groups.set(entry.section, [entry]);
  }

  const keep = new Set<KeptItem>();
  for (const [section, items] of groups) {
    const quota = quotaOf(section, budget);
    if (quota === null) {
      for (const entry of items) keep.add(entry);
      continue;
    }
    const ordered = [...items].sort((a, b) => keepRank(a.item) - keepRank(b.item));
    let used = 0;
    for (const entry of ordered) {
      const tokens = estTokens(entry.item.id);
      if (used + tokens > quota) continue;
      keep.add(entry);
      used += tokens;
    }
  }
  return flat.filter((entry) => keep.has(entry));
}

function trimToBudget(kept: readonly KeptItem[], budget: number): KeptItem[] {
  const out: KeptItem[] = [];
  let total = 0;
  for (const entry of [...kept].sort((a, b) => keepRank(a.item) - keepRank(b.item))) {
    const tokens = estTokens(entry.item.id);
    if (total + tokens > budget) continue;
    out.push(entry);
    total += tokens;
  }
  return out;
}

export function packContext(
  sections: readonly PackSection[],
  budget: number = 6000,
): PackResult {
  const flat: KeptItem[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      flat.push({ section: section.name, item });
    }
  }

  for (const level of LEVELS) {
    const total = flat.reduce((sum, entry) => sum + estTokens(entry.item[level]), 0);
    if (total <= budget) {
      return { kept: flat, level, tokens: total, dropped: 0 };
    }
  }

  // id 级仍超预算：先按段配额裁剪，仍超再全局按 keepRank 整条丢弃。
  const quotaTrimmed = trimByQuota(flat, budget);
  const quotaTokens = quotaTrimmed.reduce((sum, entry) => sum + estTokens(entry.item.id), 0);
  const kept = quotaTokens > budget ? trimToBudget(quotaTrimmed, budget) : quotaTrimmed;
  const tokens = kept.reduce((sum, entry) => sum + estTokens(entry.item.id), 0);
  return { kept, level: 'id+drop', tokens, dropped: flat.length - kept.length };
}
