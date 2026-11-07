import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PARAMS,
  RATIOS,
  RRF_REF,
  TUNABLE_KEYS,
  type ParamKey,
} from '@noryth/core';

function parseParamsYaml(): { values: Record<string, number | boolean>; tunable: string[] } {
  const file = path.resolve(process.cwd(), 'docs', 'params.yaml');
  const values: Record<string, number | boolean> = {};
  const tunable: string[] = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.split('#')[0]!.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) throw new Error(`params.yaml 无法解析：${raw}`);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key in values) throw new Error(`params.yaml 重复键：${key}`);
    values[key] = value === 'true' ? true : value === 'false' ? false : Number(value);
    if (raw.includes('tunable') && !raw.trim().startsWith('#')) tunable.push(key);
  }
  return { values, tunable };
}

const yaml = parseParamsYaml();

describe('参数表 ↔ 代码常量（P0 门禁 2）', () => {
  it('参数表恰好 58 个键', () => {
    expect(Object.keys(yaml.values)).toHaveLength(58);
  });

  it('每个 yaml 键都在 PARAMS 里且值相等', () => {
    const failures: string[] = [];
    for (const [key, expected] of Object.entries(yaml.values)) {
      const actual = PARAMS[key as ParamKey];
      if (actual === undefined) {
        failures.push(`缺少键 ${key}`);
        continue;
      }
      if (typeof expected === 'boolean' || typeof actual === 'boolean') {
        if (expected !== actual) failures.push(`${key}: yaml=${expected} code=${actual}`);
        continue;
      }
      const tolerance = key === 'memory.rrf_ref' ? 1e-6 : 1e-12;
      if (Math.abs(Number(expected) - actual) > tolerance) {
        failures.push(`${key}: yaml=${expected} code=${actual}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('PARAMS 没有 yaml 之外的键', () => {
    const extra = Object.keys(PARAMS).filter((key) => !(key in yaml.values));
    expect(extra).toEqual([]);
  });

  it('可调参数恰好 7 个，且与代码里的 TUNABLE_KEYS 一致', () => {
    expect(yaml.tunable).toHaveLength(7);
    expect([...yaml.tunable].sort()).toEqual([...TUNABLE_KEYS].sort());
  });

  it('调度权重和为 1', () => {
    const sum =
      PARAMS['scheduler.w_goal'] +
      PARAMS['scheduler.w_addressed'] +
      PARAMS['scheduler.w_stake'] +
      PARAMS['scheduler.w_narrator'] +
      PARAMS['scheduler.w_initiative'];
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('上下文七段配额和为 1', () => {
    const sum = Object.values(RATIOS).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  it('rrf_ref 是导出量，不是独立参数', () => {
    expect(Math.abs(RRF_REF - (PARAMS['memory.w_slot'] + PARAMS['memory.w_fts']) /
      (PARAMS['memory.rrf_k'] + 1))).toBeLessThan(1e-12);
  });

  it('阻尼系数递减且 < 1', () => {
    expect(PARAMS['scheduler.damp_first']).toBeLessThan(PARAMS['scheduler.damp_second']);
    expect(PARAMS['scheduler.damp_second']).toBeLessThan(1);
  });

  it('stake 满配不超过 1（否则钳位会抹平高冲突段的区分度）', () => {
    const max =
      PARAMS['scheduler.stake_base'] +
      PARAMS['scheduler.stake_conflict'] +
      PARAMS['scheduler.stake_secret'] +
      PARAMS['scheduler.stake_ownership'];
    expect(max).toBeLessThanOrEqual(1);
    expect(max).toBeCloseTo(0.87, 10);
  });

  it('硬上限 >= 2（否则被点名者无法连续应答）', () => {
    expect(PARAMS['scheduler.max_consecutive']).toBeGreaterThanOrEqual(2);
  });

  it('降级阈值递减且 < 1', () => {
    expect(PARAMS['context.degrade_triple']).toBeLessThan(PARAMS['context.degrade_summary']);
    expect(PARAMS['context.degrade_summary']).toBeLessThan(1);
  });
});
