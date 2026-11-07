import { describe, expect, it } from 'vitest';
import { INIT_ENTRIES, INIT_ENTRY_SPECS, PROJECT_LAYOUT } from '@noryth/core';

/**
 * 「init 建出 7 个文件/目录」的唯一权威枚举（P0 门禁 3）。
 * 04-ui.md §2 第 5 步与 §10.2 的 init 行都指向这张表。
 */
describe('项目骨架 7 项枚举', () => {
  it('恰好 7 项，路径唯一，且与 PROJECT_LAYOUT 一一对应', () => {
    expect(INIT_ENTRY_SPECS).toHaveLength(7);
    expect(INIT_ENTRIES).toHaveLength(7);
    expect(new Set(INIT_ENTRIES).size).toBe(7);
    expect(INIT_ENTRIES).toEqual(Object.values(PROJECT_LAYOUT));
  });

  it('每一项都有 kind 与用途说明', () => {
    for (const spec of INIT_ENTRY_SPECS) {
      expect(spec.path.length).toBeGreaterThan(0);
      expect(['file', 'dir']).toContain(spec.kind);
      expect(spec.purpose.length).toBeGreaterThan(0);
    }
  });

  it('包含 04-ui.md §2 第 5 步点名的 4 项', () => {
    for (const path of ['noryth.json', '.noryth', 'chapters', '.gitignore']) {
      expect(INIT_ENTRIES).toContain(path);
    }
  });

  it('kind 与磁盘实际形态一致（文件 / 目录）', () => {
    const byPath = new Map(INIT_ENTRY_SPECS.map((s) => [s.path, s.kind]));
    expect(byPath.get('noryth.json')).toBe('file');
    expect(byPath.get('.noryth')).toBe('dir');
    expect(byPath.get('.noryth/project.db')).toBe('file');
    expect(byPath.get('chapters')).toBe('dir');
    expect(byPath.get('skills')).toBe('dir');
    expect(byPath.get('.gitignore')).toBe('file');
    expect(byPath.get('.git')).toBe('dir');
  });
});
