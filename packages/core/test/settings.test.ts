import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  ModelRefSchema,
  SettingsSchema,
  coerceConfigValue,
  getSetting,
  resolveSettings,
  setSetting,
  settingsKeys,
} from '@noryth/core';

describe('设置 schema', () => {
  it('默认值自身通过校验', () => {
    expect(() => SettingsSchema.parse(DEFAULT_SETTINGS)).not.toThrow();
  });

  it('项目级只写差异，读取时与全局 deep-merge', () => {
    const merged = resolveSettings(
      { theme: 'light', editor: { fontSize: 17 } },
      { models: { character: { model: 'x' } } },
    );
    expect(merged.theme).toBe('light');
    expect(merged.editor.fontSize).toBe(17);
    expect(merged.editor.lineWidth).toBe(DEFAULT_SETTINGS.editor.lineWidth);
    expect(merged.models.character.model).toBe('x');
    expect(merged.models.director).toEqual(DEFAULT_SETTINGS.models.director);
  });

  it('未知键被拒绝（strictObject）', () => {
    expect(() => resolveSettings({ theme: 'light', nope: 1 })).toThrow();
    expect(() => resolveSettings(undefined, { generation: { retries: 1, extra: true } })).toThrow();
  });

  it('密钥只能是 os: 引用，不能是明文', () => {
    expect(() =>
      ModelRefSchema.parse({ provider: 'openai', model: 'm', keyRef: 'sk-123456' }),
    ).toThrow();
    expect(() =>
      ModelRefSchema.parse({ provider: 'openai', model: 'm', keyRef: 'os:openai' }),
    ).not.toThrow();
  });

  it('getSetting / setSetting 走到嵌套路径', () => {
    expect(getSetting(DEFAULT_SETTINGS, 'theme')).toBe('dark');
    expect(getSetting(DEFAULT_SETTINGS, 'agents.critic.enabled')).toBe(true);
    const next = setSetting(DEFAULT_SETTINGS, 'editor.fontSize', 18);
    expect(next.editor.fontSize).toBe(18);
    expect(DEFAULT_SETTINGS.editor.fontSize).toBe(15);
  });

  it('setSetting 拒绝不存在的键', () => {
    expect(() => setSetting(DEFAULT_SETTINGS, 'nope.deep', 1)).toThrow(/未知设置项/);
    expect(() => setSetting(DEFAULT_SETTINGS, 'theme.nope', 1)).toThrow(/未知设置项/);
  });

  it('命令行值按当前类型 coercion', () => {
    expect(coerceConfigValue('false', true)).toBe(false);
    expect(coerceConfigValue('0', true)).toBe(false);
    expect(coerceConfigValue('dark', 'light')).toBe('dark');
    expect(coerceConfigValue('2.5', 1)).toBe(2.5);
    expect(coerceConfigValue('["a","b"]', [])).toEqual(['a', 'b']);
    expect(() => coerceConfigValue('maybe', true)).toThrow();
    expect(() => coerceConfigValue('abc', 1)).toThrow();
  });

  it('可配置键列表包含项目/全局语义键', () => {
    const keys = settingsKeys(DEFAULT_SETTINGS);
    expect(keys).toContain('theme');
    expect(keys).toContain('models.director.keyRef');
    expect(keys).toContain('agents.critic.enabled');
  });
});
