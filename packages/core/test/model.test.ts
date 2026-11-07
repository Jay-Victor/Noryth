import { describe, expect, it } from 'vitest';
import {
  assertKey,
  knowledgeViolations,
  parseCharacterOutput,
  parseNarratorOutput,
  stripFence,
  type CharacterOutput,
} from '@noryth/core';

const VALID = {
  line: '账本在我这儿。',
  action: '他把账本压在肘下。',
  thought: '他来得太快。',
  intent: '拖住对方',
  addressed_to: [],
  asserts: [],
  reveals: [],
  emotion: 'tense',
};

describe('P1 · 模型输出契约', () => {
  it('解析合法角色 JSON 并补默认值', () => {
    const parsed = parseCharacterOutput(JSON.stringify({ line: '嗯。' }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.line).toBe('嗯。');
      expect(parsed.value.emotion).toBe('calm');
      expect(parsed.value.addressed_to).toEqual([]);
    }
  });

  it('剥掉 ```json 围栏', () => {
    expect(stripFence('```json\n{"line":"嗯"}\n```')).toBe('{"line":"嗯"}');
    expect(stripFence('{"line":"嗯"}')).toBe('{"line":"嗯"}');
  });

  it('未知字段被拒绝（strictObject）', () => {
    const parsed = parseCharacterOutput(JSON.stringify({ line: '嗯', extra: 1 }));
    expect(parsed.ok).toBe(false);
  });

  it('非法 JSON 返回错误而不是抛错', () => {
    const parsed = parseCharacterOutput('不是 JSON');
    expect(parsed.ok).toBe(false);
  });

  it('旁白输出至少一段', () => {
    expect(parseNarratorOutput(JSON.stringify({ paragraphs: [] })).ok).toBe(false);
    const ok = parseNarratorOutput(JSON.stringify({ paragraphs: ['雨更大了。'] }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.focus).toBe('环境');
  });
});

describe('P1 · 知识边界校验', () => {
  const output: CharacterOutput = {
    ...VALID,
    asserts: [
      { subject: 'e_lin', predicate: '住在', object: '客栈', claims_true: true },
      { subject: 'e_lin', predicate: '知道', object: { id: 'e_unknown' }, claims_true: true },
    ],
    reveals: ['f-unknown'],
  };

  const claims = new Map([
    [assertKey('e_lin', '住在', '客栈'), { factId: 'f-home', truth: 1 }],
  ]);

  it('reveals 不知道的事实 → 越权', () => {
    const violations = knowledgeViolations(output, new Set(['f-home']), claims);
    expect(violations.some((v) => v.kind === 'reveal' && v.factId === 'f-unknown')).toBe(true);
  });

  it('assert 匹配到不知道的事实 → 越权', () => {
    const violations = knowledgeViolations(output, new Set<string>(), claims);
    expect(violations.some((v) => v.kind === 'assert' && v.factId === 'f-home')).toBe(true);
  });

  it('assert 不匹配任何事实 → 新 claim，放行', () => {
    const onlyKnown = {
      ...output,
      asserts: [
        { subject: 'e_lin', predicate: '不知道的谓词', object: true, claims_true: true },
      ],
      reveals: [],
    };
    expect(knowledgeViolations(onlyKnown, new Set<string>(), claims)).toEqual([]);
  });
});
