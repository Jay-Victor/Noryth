import { describe, expect, it } from 'vitest';
import {
  RESTORE_DOMAINS,
  domainImpact,
  emptyDomainCounts,
  uniqueBranchName,
  validateRestoreTarget,
} from '@noryth/core';

describe('P1 · 回退领域契约', () => {
  it('8 个域，顺序固定', () => {
    expect(RESTORE_DOMAINS.map((d) => d.key)).toEqual([
      'messages',
      'facts',
      'cognition',
      'relations',
      'chapters',
      'cards',
      'summaries',
      'vectors',
    ]);
  });

  it('影响只统计会失去的部分', () => {
    const current = emptyDomainCounts();
    current.messages = 34;
    current.cognition = 11;
    const target = emptyDomainCounts();
    target.messages = 10;
    target.cognition = 11;
    const impact = domainImpact(current, target);
    expect(impact.find((row) => row.key === 'messages')?.lost).toBe(24);
    expect(impact.find((row) => row.key === 'cognition')?.lost).toBe(0);
  });

  it('新分支名不覆盖已有分支', () => {
    expect(uniqueBranchName(['main'])).toBe('main~r1');
    expect(uniqueBranchName(['main', 'main~r1'])).toBe('main~r2');
    expect(uniqueBranchName(['main', 'main~r1', 'main~r2'], 'exp')).toBe('exp~r1');
  });

  it('回退目标必须早于 head', () => {
    expect(() => validateRestoreTarget(10, 10)).toThrow(/没有意义/);
    expect(() => validateRestoreTarget(11, 10)).toThrow(/不早于/);
    expect(() => validateRestoreTarget(-1, 10)).toThrow(/非负/);
    expect(() => validateRestoreTarget(9, 10)).not.toThrow();
  });
});
