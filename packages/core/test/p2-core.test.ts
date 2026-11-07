import { describe, expect, it } from 'vitest';
import {
  HashEmbeddingProvider,
  PARAMS,
  adjustRelation,
  assembleCharacterContext,
  buildMemoryIndex,
  cosine,
  decodeVector,
  downweightedImportance,
  encodeVector,
  firstSentence,
  hashEmbed,
  jaccard,
  l2Normalize,
  objectIdOf,
  planFactAssert,
  prepareVector,
  recencyOf,
  sceneSummaryText,
  searchMemory,
  searchMemoryIndex,
  settingConflictOf,
  slotKeyOf,
  tokenize,
  truthLabel,
  type MemoryRecord,
  type SceneCardView,
} from '@noryth/core';

const NOW = '2026-03-01T00:00:00.000Z';
const DAY = 86_400_000;

function record(overrides: Partial<MemoryRecord> & { id: string; text: string }): MemoryRecord {
  return {
    kind: 'event',
    importance: 1,
    conf: 1,
    validFrom: new Date(Date.parse(NOW) - DAY).toISOString(),
    pinned: false,
    hard: false,
    resolvedSeq: null,
    sensitivity: 0,
    slotKey: null,
    ownerId: null,
    embedding: null,
    ...overrides,
  };
}

describe('facts · 三态与槽位', () => {
  const base = {
    subjectId: 'e_lin',
    predicate: '住在',
    cardinality: 'single' as const,
    truth: 1 as const,
    secrecy: 1,
    validFrom: '第02天',
    locked: false,
  };

  it('slot_key 与 schema 生成列一致；多值只接受字符串 id', () => {
    expect(slotKeyOf('e_lin', '住在', '客栈', 'single')).toBe('e_lin|住在|');
    expect(slotKeyOf('e_lin', '知道', { id: 'o1' }, 'multi')).toBe('e_lin|知道|o1');
    expect(slotKeyOf('e_lin', '知道', { id: 1 }, 'multi')).toBe('e_lin|知道|');
    expect(objectIdOf({ id: 'o1' })).toBe('o1');
    expect(objectIdOf({ id: 1 })).toBeNull();
    expect(objectIdOf('o1')).toBeNull();
    expect(objectIdOf(null)).toBeNull();
    expect(objectIdOf([{ id: 'o1' }])).toBeNull();
  });

  it('首次断言 = insert', () => {
    const plan = planFactAssert({ ...base, object: '客栈', existing: [] });
    expect(plan).toEqual({ ok: true, action: 'insert', slotKey: 'e_lin|住在|' });
  });

  it('同值同元数据 = same（幂等，不写新行）', () => {
    const plan = planFactAssert({
      ...base,
      object: '客栈',
      existing: [
        {
          id: 'f1',
          slotKey: 'e_lin|住在|',
          objectJson: '"客栈"',
          truth: 1,
          secrecy: 1,
          validFrom: '第01天',
        },
      ],
    });
    expect(plan).toEqual({ ok: true, action: 'same', slotKey: 'e_lin|住在|', factId: 'f1' });
  });

  it('单值槽位换值 = supersede，旧值不覆盖', () => {
    const plan = planFactAssert({
      ...base,
      object: '船屋',
      existing: [
        {
          id: 'f1',
          slotKey: 'e_lin|住在|',
          objectJson: '"客栈"',
          truth: 1,
          secrecy: 1,
          validFrom: '第01天',
        },
      ],
    });
    expect(plan).toEqual({
      ok: true,
      action: 'supersede',
      slotKey: 'e_lin|住在|',
      supersededId: 'f1',
      supersededValidTo: '第02天',
    });
  });

  it('同值不同 truth = 纠正，走 supersede', () => {
    const plan = planFactAssert({
      ...base,
      object: '客栈',
      truth: -1,
      existing: [
        {
          id: 'f1',
          slotKey: 'e_lin|住在|',
          objectJson: '"客栈"',
          truth: 1,
          secrecy: 1,
          validFrom: '第01天',
        },
      ],
    });
    expect(plan.ok && plan.action).toBe('supersede');
  });

  it('锁住的槽位拒绝写入，即使换新 id 也不行', () => {
    const plan = planFactAssert({ ...base, object: '船屋', existing: [], locked: true });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('fact_locked');
  });

  it('同值重放仍允许（锁不阻止无写入的幂等断言）', () => {
    const plan = planFactAssert({
      ...base,
      object: '客栈',
      locked: true,
      existing: [
        {
          id: 'f1',
          slotKey: 'e_lin|住在|',
          objectJson: '"客栈"',
          truth: 1,
          secrecy: 1,
          validFrom: '第01天',
        },
      ],
    });
    expect(plan.ok && plan.action).toBe('same');
  });

  it('valid_from 倒退被拒绝', () => {
    const plan = planFactAssert({
      ...base,
      validFrom: '第01天',
      object: '船屋',
      existing: [
        {
          id: 'f1',
          slotKey: 'e_lin|住在|',
          objectJson: '"客栈"',
          truth: 1,
          secrecy: 1,
          validFrom: '第01天',
        },
      ],
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('time_conflict');
  });

  it('多值谓词缺 id 直接拒绝', () => {
    const plan = planFactAssert({
      ...base,
      predicate: '知道',
      cardinality: 'multi',
      object: '秘密',
      existing: [],
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.code).toBe('invalid_object');
  });

  it('多值谓词：不同宾语各自 insert', () => {
    const plan = planFactAssert({
      ...base,
      predicate: '知道',
      cardinality: 'multi',
      object: { id: 'o2' },
      existing: [
        {
          id: 'f1',
          slotKey: 'e_lin|知道|o1',
          objectJson: '{"id":"o1"}',
          truth: 1,
          secrecy: 1,
          validFrom: '第01天',
        },
      ],
    });
    expect(plan.ok && plan.action).toBe('insert');
  });

  it('设定冲突只报锁定槽位上的不同值', () => {
    const locks = [{ scope: 'fact', slotKey: 'e_lin|住在|' }];
    const conflict = settingConflictOf(
      { subject: '林砚', predicate: '住在', object: '船屋' },
      'e_lin',
      'single',
      '"客栈"',
      locks,
    );
    expect(conflict?.slotKey).toBe('e_lin|住在|');
    expect(
      settingConflictOf(
        { subject: '林砚', predicate: '住在', object: '客栈' },
        'e_lin',
        'single',
        '"客栈"',
        locks,
      ),
    ).toBeNull();
    expect(
      settingConflictOf(
        { subject: '林砚', predicate: '住在', object: '船屋' },
        'e_lin',
        'single',
        null,
        [],
      ),
    ).toBeNull();
  });

  it('truth 三态标签', () => {
    expect(truthLabel(1)).toBe('真');
    expect(truthLabel(0)).toBe('未知');
    expect(truthLabel(-1)).toBe('假');
  });
});

describe('relations · 突变钳制', () => {
  it('阈值内直接落库', () => {
    const result = adjustRelation({ oldValue: 0, requested: 0.3, reason: '' });
    expect(result).toMatchObject({ value: 0.3, jumped: false, clamped: false, reason: null });
    expect(adjustRelation({ oldValue: 0, requested: 0.1, reason: '微调' }).reason).toBe('微调');
  });

  it('超阈值有理由 → 放行并保留理由', () => {
    const result = adjustRelation({ oldValue: 0, requested: 0.8, reason: '他救了她的命' });
    expect(result).toMatchObject({ value: 0.8, jumped: true, clamped: false, reason: '他救了她的命' });
  });

  it('超阈值无理由 → 钳制到 ±阈值并写自动说明', () => {
    const up = adjustRelation({ oldValue: 0, requested: 0.8, reason: '  ' });
    expect(up.clamped).toBe(true);
    expect(up.value).toBeCloseTo(0.35, 6);
    expect(up.reason).toContain('钳制');
    const down = adjustRelation({ oldValue: -0.5, requested: -1, reason: '' });
    expect(down.value).toBeCloseTo(-0.85, 6);
  });

  it('钳制后仍被 [-1,1] 截断', () => {
    const result = adjustRelation({ oldValue: 0.9, requested: 1, reason: '', threshold: 0.5 });
    expect(result.value).toBe(1);
    const low = adjustRelation({ oldValue: -0.9, requested: -1, reason: '', threshold: 0.5 });
    expect(low.value).toBe(-1);
  });
});

describe('text · 分词', () => {
  it('中文二元组 + ASCII 单词', () => {
    expect(tokenize('林砚住在客栈')).toEqual(['林砚', '砚住', '住在', '在客', '客栈']);
    expect(tokenize('Hello，world 42')).toEqual(['hello', 'world', '42']);
    expect(tokenize('信')).toEqual(['信']);
    expect(tokenize('   ')).toEqual([]);
  });

  it('NFKC 与大小写归一', () => {
    expect(tokenize('ＡＢＣ')).toEqual(['abc']);
    expect(tokenize('A')).toEqual([]);
  });

  it('Jaccard 相似度', () => {
    expect(jaccard([], ['a'])).toBe(0);
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6);
  });
});

describe('embed · 向量与管线', () => {
  it('hash 嵌入确定性、L2 归一化', () => {
    const a = hashEmbed('账本在沈昼手里');
    const b = hashEmbed('账本在沈昼手里');
    expect(a).toEqual(b);
    const norm = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
    expect(hashEmbed('完全不同的句子')).not.toEqual(a);
  });

  it('provider 输出维度与数量', async () => {
    const provider = new HashEmbeddingProvider(16);
    const vectors = await provider.embed(['甲', '乙']);
    expect(provider.name).toBe('hash');
    expect(vectors).toHaveLength(2);
    expect(vectors[0]!.length).toBe(16);
    expect(() => new HashEmbeddingProvider(4)).toThrow(RangeError);
  });

  it('余弦：同向为 1，正交为 0，维度不一致抛错', () => {
    expect(cosine(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBeCloseTo(1, 6);
    expect(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
    expect(cosine(new Float32Array([0, 0]), new Float32Array([1, 0]))).toBe(0);
    expect(() => cosine(new Float32Array([1]), new Float32Array([1, 2]))).toThrow(RangeError);
  });

  it('BLOB 编解码往返（Float32 小端）', () => {
    const vector = l2Normalize(new Float32Array([1, 2, 3, 4]));
    const buffer = encodeVector(vector);
    expect(buffer.length).toBe(16);
    const decoded = decodeVector(buffer, 4);
    expect([...decoded]).toEqual([...vector]);
    expect(() => decodeVector(new Uint8Array(3))).toThrow(RangeError);
    expect(() => decodeVector(buffer, 5)).toThrow(RangeError);
  });

  it('prepareVector 校验维度、有限数、非零', () => {
    expect([...prepareVector([1, 0, 0, 0], 4)]).toEqual([1, 0, 0, 0]);
    expect(() => prepareVector([1], 4)).toThrow(RangeError);
    expect(() => prepareVector([Number.NaN, 0, 0, 0], 4)).toThrow(RangeError);
    expect(() => prepareVector([0, 0, 0, 0], 4)).toThrow(RangeError);
    expect([...l2Normalize(new Float32Array([0, 0]))]).toEqual([0, 0]);
  });
});

describe('retrieval · 四通道 + 收口', () => {
  const corpus: MemoryRecord[] = [
    record({
      id: 'n1',
      text: '林砚住在客栈，账本藏在床下',
      slotKey: 'e_lin|住在|',
      embedding: hashEmbed('林砚住在客栈，账本藏在床下'),
    }),
    record({ id: 'n2', text: '沈昼拿走了账本', embedding: hashEmbed('沈昼拿走了账本') }),
    record({ id: 'n3', text: '关系里程碑：两人结拜', kind: 'relationship', pinned: true }),
    record({ id: 'n4', text: '未结线索：账本第七页被撕掉', kind: 'clue' }),
    record({ id: 'n5', text: '已回收的线索：旧钥匙', kind: 'clue', resolvedSeq: 9 }),
    record({ id: 'n6', text: '前任的病史', sensitivity: 3, embedding: hashEmbed('前任的病史') }),
    record({ id: 'n7', text: '沈昼的私密记忆', ownerId: 'e_shen' }),
    record({ id: 'n8', text: '账本封皮上的客栈印记', embedding: hashEmbed('账本封皮上的客栈印记') }),
  ];
  const edges = [{ src: 'n1', dst: 'n8', kind: 'CO_OCCURS' as const, weight: 0.9 }];

  it('词面 + 向量双通道命中；slot 与 graph 通道留痕', () => {
    const result = searchMemoryIndex(buildMemoryIndex(corpus, edges), {
      text: '账本',
      queryVector: hashEmbed('账本'),
      slotKey: 'e_lin|住在|',
      now: NOW,
    });
    expect(result.reason).toBe('ok');
    expect(result.ranked.map((entry) => entry.id)).toContain('n1');
    const n1 = result.ranked.find((entry) => entry.id === 'n1')!;
    expect(n1.channels.fts).toBe(1);
    expect(n1.channels.vector).toBeGreaterThan(0);
    expect(n1.channels.slot).toBe(1);
    expect(result.ranked.some((entry) => entry.channels.graph !== undefined)).toBe(true);
  });

  it('slot 通道是精确命中：单通道即可过下限', () => {
    const result = searchMemoryIndex(
      buildMemoryIndex([
        record({ id: 's1', text: '无关文字', slotKey: 'e_lin|住在|', importance: 1 }),
        record({ id: 's2', text: '另一条', slotKey: 'e_lin|身份|', importance: 1 }),
      ]),
      { text: '住在', slotKey: 'e_lin|住在|', now: NOW },
    );
    expect(result.reason).toBe('ok');
    expect(result.ranked.map((entry) => entry.id)).toEqual(['s1']);
  });

  it('无关查询返回空（绝对下限），常驻项仍单独返回', () => {
    const result = searchMemory(corpus, edges, {
      text: '天气很好',
      now: NOW,
    });
    expect(result.reason).toBe('below_floor');
    expect(result.ranked).toEqual([]);
    expect(result.resident.map((entry) => entry.id)).toEqual(['n3', 'n4']);
  });

  it('过滤：已回收线索、高敏自动召回、他人私有记忆', () => {
    const result = searchMemoryIndex(buildMemoryIndex(corpus, edges), {
      text: '账本',
      queryVector: hashEmbed('账本'),
      asCharacterId: 'e_lin',
      auto: true,
      now: NOW,
    });
    expect(result.filtered).toBeGreaterThanOrEqual(3);
    expect(result.ranked.some((entry) => entry.id === 'n7')).toBe(false);
    expect(result.resident.some((entry) => entry.id === 'n4')).toBe(true);
  });

  it('高敏显式查询可见', () => {
    const result = searchMemoryIndex(buildMemoryIndex(corpus), {
      text: '病史',
      queryVector: hashEmbed('病史'),
      auto: false,
      now: NOW,
    });
    expect(result.ranked.some((entry) => entry.id === 'n6')).toBe(true);
  });

  it('相对截断：只有单通道的弱匹配被丢掉', () => {
    const nodes = [
      record({ id: 'strong', text: '账本 账本', embedding: hashEmbed('账本 账本') }),
      record({ id: 'weak', text: '账本' }),
    ];
    const result = searchMemoryIndex(buildMemoryIndex(nodes), {
      text: '账本',
      queryVector: hashEmbed('账本'),
      now: NOW,
    });
    expect(result.ranked.map((entry) => entry.id)).toEqual(['strong']);
  });

  it('MMR：前 3 名免疫，第 4 名起去冗余且不超过 limit', () => {
    const nodes = Array.from({ length: 6 }, (_, i) =>
      record({ id: `m${i}`, text: '账本 账本', embedding: hashEmbed('账本 账本') }),
    );
    const result = searchMemoryIndex(buildMemoryIndex(nodes), {
      text: '账本',
      queryVector: hashEmbed('账本'),
      limit: 4,
      now: NOW,
    });
    expect(result.ranked).toHaveLength(4);
    expect(result.ranked.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('时效：event 半衰 30 天，fact/clue 不衰减，坏时间不猜', () => {
    const now = NOW;
    expect(recencyOf('event', new Date(Date.parse(now) - 30 * DAY).toISOString(), now)).toBeCloseTo(0.5, 6);
    expect(recencyOf('fact', '第01天', now)).toBe(1);
    expect(recencyOf('clue', '2020-01-01T00:00:00.000Z', now)).toBe(1);
    expect(recencyOf('event', '第01天', now)).toBe(1);
    expect(recencyOf('event', new Date(Date.parse(now) + DAY).toISOString(), now)).toBe(1);
  });

  it('单通道排名截断：>512 候选时仍只保留前 512（不影响最终输出）', () => {
    const nodes = Array.from({ length: 600 }, (_, i) =>
      record({ id: `t${String(i).padStart(3, '0')}`, text: '账本 账本', embedding: hashEmbed('账本 账本') }),
    );
    const result = searchMemoryIndex(buildMemoryIndex(nodes), {
      text: '账本',
      queryVector: hashEmbed('账本'),
      limit: 8,
      now: NOW,
    });
    expect(result.reason).toBe('ok');
    expect(result.ranked).toHaveLength(8);
    // 同分节点按 id 稳定排序：前 8 个一定是 id 最小的 8 个
    expect(result.ranked.map((entry) => entry.id)).toEqual([
      't000', 't001', 't002', 't003', 't004', 't005', 't006', 't007',
    ]);
  });

  it('空索引返回 below_floor', () => {
    expect(searchMemory([], [], { text: '账本', now: NOW })).toMatchObject({
      ranked: [],
      resident: [],
      reason: 'below_floor',
      filtered: 0,
    });
  });
});

describe('summarize · 确定性摘要', () => {
  it('取第一段环境描写与最后一拍；不跨句截断', () => {
    const text = sceneSummaryText({
      title: '雨夜·账本',
      goal: '夺回账本',
      beats: [
        { seq: 1, roleType: 'narrator', speaker: '旁白', prose: '雨声压住了客栈的门轴。灯快尽了。' },
        { seq: 2, roleType: 'character', speaker: '林砚', prose: '把账本还我。' },
      ],
    });
    expect(text).toContain('雨夜·账本');
    expect(text).toContain('夺回账本');
    expect(text).toContain('雨声压住了客栈的门轴。');
    expect(text).toContain('林砚：把账本还我。');
  });

  it('没有旁白时用第一拍；空场景返回空串', () => {
    const text = sceneSummaryText({
      title: '空场',
      goal: '',
      beats: [{ seq: 1, roleType: 'character', speaker: '林砚', prose: '谁在门外？' }],
    });
    expect(text).toBe('空场。谁在门外？');
    expect(sceneSummaryText({ title: '空场', goal: '', beats: [] })).toBe('');
    expect(
      sceneSummaryText({
        title: '只有导演',
        goal: '',
        beats: [{ seq: 1, roleType: 'director', speaker: '导演', prose: '抽牌' }],
      }),
    ).toBe('');
  });

  it('没有句号边界时按硬上限收口', () => {
    const text = sceneSummaryText({
      title: '长',
      goal: '',
      beats: [{ seq: 1, roleType: 'narrator', speaker: '旁白', prose: '甲'.repeat(300) }],
    });
    expect(text.length).toBe(240);
    expect(text.startsWith('长。')).toBe(true);
  });

  it('长文本在句号处收口', () => {
    const long = `${'甲'.repeat(150)}。${'乙'.repeat(150)}。`;
    const text = sceneSummaryText({
      title: '长场',
      goal: '',
      beats: [{ seq: 1, roleType: 'narrator', speaker: '旁白', prose: long }],
    });
    expect(text.length).toBeLessThanOrEqual(240);
    expect(text.endsWith('。')).toBe(true);
  });

  it('firstSentence 与降权', () => {
    expect(firstSentence('第一句。第二句。')).toBe('第一句。');
    expect(firstSentence('没有句号')).toBe('没有句号');
    expect(firstSentence('  ')).toBe('');
    expect(downweightedImportance(1.6)).toBe(0.8);
    expect(downweightedImportance(0.06)).toBe(0.05);
  });
});

describe('assemble · 记忆段', () => {
  const scene: SceneCardView = {
    title: '雨夜',
    location: '客栈',
    storyStart: '第01天',
    timeline: 'main',
    presentNames: ['林砚'],
    goal: '夺回账本',
    conflictLevel: 1,
    situation: '',
  };

  it('memories 进入 memory 段，事实仍在', () => {
    const result = assembleCharacterContext({
      characterId: 'e_lin',
      agent: {
        name: '林砚',
        identity: '掌柜',
        personality: '克制',
        speechStyle: '短句',
        values: '活着',
        want: '账本',
      },
      scene,
      recent: [],
      facts: [
        {
          id: 'f1',
          subjectId: 'e_lin',
          subjectName: '林砚',
          predicate: '住在',
          objectText: '客栈',
          truth: 1,
          secrecy: 1,
          source: '设定',
        },
      ],
      cognition: [{ characterId: 'e_lin', factId: 'f1', attitude: 'knows', certainty: 1 }],
      relations: [],
      clues: [],
      memories: [{ id: 'mn1', text: '账本第七页被撕掉了', kind: 'event' }],
    });
    expect(result.prompt.user).toContain('林砚住在客栈');
    expect(result.prompt.user).toContain('记忆·event');
    expect(result.prompt.user).toContain('账本第七页');
  });
});

describe('params · P2 常量自检', () => {
  it('rrf_ref 与公式一致，floor 在 (0,1)', () => {
    expect(PARAMS['memory.rrf_ref']).toBeCloseTo(
      (PARAMS['memory.w_slot'] + PARAMS['memory.w_fts']) / (PARAMS['memory.rrf_k'] + 1),
      6,
    );
    expect(PARAMS['memory.floor']).toBeGreaterThan(0);
    expect(PARAMS['memory.floor']).toBeLessThan(1);
  });
});
