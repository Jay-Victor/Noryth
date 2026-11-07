import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandBus,
  closeDatabase,
  createCheckpointWithSnapshot,
  createProject,
  decodeStatePackage,
  exportStatePackage,
  getActiveBranch,
  listFacts,
  listJobs,
  listLocks,
  listMemory,
  listPredicates,
  memoryTree,
  migrate,
  openDatabase,
  readCharacterContext,
  restoreBranch,
  restoreFromPackage,
  searchMemories,
  type Db,
} from '@noryth/store';
import {
  assembleCharacterContext,
  hashEmbed,
  type JobStatus,
} from '@noryth/core';

const TMP = path.resolve(process.cwd(), 'node_modules', '.cache', 'noryth-p2-store');
let db: Db;
let file: string;
let bus: CommandBus;
let sceneId: string;
let present: string[];
let key = 0;

function scene(overrides: Record<string, unknown> = {}): void {
  const result = bus.submit<{ sceneId: string; present: string[]; narratorAgentId: string }>(
    { type: 'user', id: 'author' },
    {
      kind: 'scene.create',
      idempotencyKey: `scene-${randomUUID()}`,
      payload: {
        title: '雨夜·账本',
        cast: [
          { name: '林砚', goalRel: 1, initiative: 0.9, identity: '客栈掌柜' },
          { name: '沈昼', goalRel: 1, initiative: 0.6 },
          { name: '祁昭', goalRel: 0.5, initiative: 0.3 },
        ],
        present: ['林砚', '沈昼', '祁昭'],
        storyStart: '第01天',
        goal: '夺回账本',
        situation: '灯快尽了。',
        conflictLevel: 2.1,
        maxBeats: 20,
        exitConditions: { op: 'beats', cmp: '>=', value: 20 },
        ...overrides,
      },
    },
  ).result;
  sceneId = result.sceneId;
  present = result.present;
}

function openScene(): void {
  bus.submit(
    { type: 'user', id: 'author' },
    { kind: 'scene.state', idempotencyKey: `open-${sceneId}`, payload: { sceneId, to: 'open' } },
  );
}

function commitBeat(agentId: string, overrides: Record<string, unknown> = {}): { beatSeq: number } {
  key += 1;
  const roleType = (overrides.roleType as string) ?? 'character';
  const audience =
    overrides.audience ??
    (roleType === 'narrator' ? [] : present.filter((id) => id !== agentId));
  return bus.submit<{ beatSeq: number }>(
    { type: 'character', id: agentId },
    {
      kind: 'beat.commit',
      idempotencyKey: `beat-${key}`,
      payload: {
        sceneId,
        agentId: roleType === 'narrator' ? 'narrator' : agentId,
        roleType,
        mode: 'auto',
        score: 0.5,
        damped: 0.4,
        breakdown: {},
        prose: `第 ${key} 拍。`,
        structured: roleType === 'narrator' ? { paragraphs: [`第 ${key} 拍。`] } : { line: `第 ${key} 拍。` },
        percept: roleType === 'narrator' ? 'narrator_reader' : 'public',
        audience,
        cognition: [],
        relations: [],
        conflictLevel: 2.1,
        ...overrides,
      },
    },
  ).result;
}

function closeScene(): { summaryNodeId: string | null } {
  return bus.submit<{ summaryNodeId: string | null }>(
    { type: 'user', id: 'author' },
    {
      kind: 'scene.state',
      idempotencyKey: `close-${sceneId}-${randomUUID()}`,
      payload: { sceneId, to: 'closed', reason: 'test' },
    },
  ).result;
}

function fact(
  subject: string,
  predicate: string,
  object: unknown,
  overrides: Record<string, unknown> = {},
): { factId: string; slotKey: string; action: string; supersededId: string | null } {
  return bus.submit<{
    factId: string;
    slotKey: string;
    action: string;
    supersededId: string | null;
  }>(
    { type: 'user', id: 'author' },
    {
      kind: 'fact.assert',
      idempotencyKey: `fact-${randomUUID()}`,
      payload: { subject, predicate, object, ...overrides },
    },
  ).result;
}

function echoName(): string {
  return present[0]!;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  file = path.join(TMP, `p2-${randomUUID()}.db`);
  db = openDatabase(file);
  migrate(db);
  createProject(db, { name: 'P2 测试', rootPath: 'C:/tmp/noryth-p2' });
  bus = new CommandBus(db);
  scene();
});

afterEach(() => {
  closeDatabase(db);
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});

describe('P2 · 事实库', () => {
  it('insert → same → supersede：旧行保留，valid_to 指向新值起点', () => {
    const first = fact('林砚', '住在', '客栈', { validFrom: '第01天', secrecy: 1 });
    expect(first.action).toBe('insert');
    const same = fact('林砚', '住在', '客栈', { validFrom: '第01天', secrecy: 1 });
    expect(same.action).toBe('same');
    expect(same.factId).toBe(first.factId);

    const second = fact('林砚', '住在', '船屋', { validFrom: '第02天' });
    expect(second.action).toBe('supersede');
    expect(second.supersededId).toBe(first.factId);

    const active = listFacts(db, { subject: '林砚' });
    expect(active).toHaveLength(1);
    expect(active[0]!.objectText).toBe('船屋');
    const history = listFacts(db, { subject: '林砚', includeHistorical: true });
    expect(history).toHaveLength(2);
    expect(history.find((row) => row.id === first.factId)!.validTo).toBe('第02天');
  });

  it('三态 truth 与谓词基数来自 predicate_spec', () => {
    const lie = fact('林砚', '身份', '账房先生', { truth: -1 });
    expect(listFacts(db, { subject: '林砚' })[0]).toMatchObject({
      truth: -1,
      truthLabel: '假',
    });
    expect(lie.slotKey).toBe(`${present[0]}|身份|`);
    const multi = fact('林砚', '去过', { id: 'p1', name: '码头' });
    expect(multi.slotKey).toBe(`${present[0]}|去过|p1`);
    // 多值谓词缺 id 被 core 拒绝
    expect(() => fact('林砚', '去过', '码头')).toThrow(/带字符串 id/);
  });

  it('未登记的谓词明确拒绝，而不是猜基数', () => {
    expect(() => fact('林砚', '暗恋', '沈昼')).toThrow(/predicate_spec/);
  });

  it('fact.close 关闭当前值，历史仍可查', () => {
    const created = fact('林砚', '住在', '客栈', { validFrom: '第01天' });
    const closed = bus.submit<{ closed: number }>(
      { type: 'user', id: 'author' },
      {
        kind: 'fact.close',
        idempotencyKey: 'close-fact',
        payload: { subject: '林砚', predicate: '住在', at: '第05天' },
      },
    ).result;
    expect(closed.closed).toBe(1);
    expect(listFacts(db, { subject: '林砚' })).toHaveLength(0);
    expect(listFacts(db, { subject: '林砚', includeHistorical: true })[0]!.id).toBe(created.factId);
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'fact.close',
          idempotencyKey: 'close-fact-again',
          payload: { subject: '林砚', predicate: '住在' },
        },
      ),
    ).toThrow(/没有当前有效事实/);
  });

  it('单值槽位：命令层永远只留一个当前值；直接插入第二行被唯一索引拒绝', () => {
    const branch = getActiveBranch(db)!;
    db.prepare("INSERT INTO entity(id, branch_id, kind, name) VALUES ('e_jade', ?, 'item', '玉佩')").run(
      branch.id,
    );
    fact('玉佩', '持有', { id: present[0]!, name: '林砚' });
    fact('玉佩', '持有', { id: present[1]!, name: '沈昼' });
    const active = listFacts(db, { subject: '玉佩' });
    expect(active).toHaveLength(1);
    expect(active[0]!.objectText).toBe('沈昼');
    const item = listFacts(db, { subject: '玉佩' })[0]!;
    const subjectId = db
      .prepare('SELECT subject_id FROM fact WHERE id = ?')
      .get(item.id) as { subject_id: string };
    expect(() =>
      db
        .prepare(
          `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth,
             secrecy, valid_from, created_at)
           VALUES ('f-direct2', ?, ?, '持有', '{"id":"x"}', 'single', 1, 0, '第03天', ?)`,
        )
        .run(branch.id, subjectId.subject_id, new Date().toISOString()),
    ).toThrow(/UNIQUE|constraint/i);
  });
});

describe('P2 · 设定锁', () => {
  it('锁住槽位后，换新 fact id 写同槽位被 100% 拒绝（应用层 + 触发器）', () => {
    fact('林砚', '住在', '客栈', { validFrom: '第01天' });
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'lock.set',
        idempotencyKey: 'lock-1',
        payload: {
          scope: 'fact',
          subject: '林砚',
          predicate: '住在',
          reason: '作者定稿：林砚只能住客栈',
        },
      },
    );
    expect(listLocks(db)).toHaveLength(1);
    for (let i = 0; i < 5; i += 1) {
      expect(() => fact('林砚', '住在', `别处-${i}`)).toThrow(/锁定/);
    }
    const branch = getActiveBranch(db)!;
    const subjectId = (db.prepare("SELECT id FROM entity WHERE name = '林砚'").get() as { id: string }).id;
    expect(() =>
      db
        .prepare(
          `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth,
             secrecy, valid_from, created_at)
           VALUES (?, ?, ?, '住在', '"绕过"', 'single', 1, 0, '第09天', ?)`,
        )
        .run(`f-bypass-${randomUUID()}`, branch.id, subjectId, new Date().toISOString()),
    ).toThrow(/ck_fact_locked/);
    // 幂等重放同值不写新行，允许
    expect(fact('林砚', '住在', '客栈', { validFrom: '第01天' }).action).toBe('same');
  });

  it('锁必须给理由；重复锁定被拒绝', () => {
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'lock.set',
          idempotencyKey: 'lock-empty',
          payload: { scope: 'fact', subject: '林砚', predicate: '住在', reason: '  ' },
        },
      ),
    ).toThrow();
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'lock.set',
        idempotencyKey: 'lock-a',
        payload: { scope: 'world', slotKey: 'world|magic', reason: '低魔设定' },
      },
    );
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'lock.set',
          idempotencyKey: 'lock-b',
          payload: { scope: 'world', slotKey: 'world|magic', reason: '再来一次' },
        },
      ),
    ).toThrow(/已锁定/);
  });
});

describe('P2 · 认知与越权', () => {
  it('cognition.grant 写入，失效事实被拒绝', () => {
    const created = fact('沈昼', '名为', '沈三', { secrecy: 3, validFrom: '第01天' });
    const granted = bus.submit<{ created: boolean }>(
      { type: 'user', id: 'author' },
      {
        kind: 'cognition.grant',
        idempotencyKey: 'grant-1',
        payload: { characterId: '林砚', factId: created.factId, percept: 'told' },
      },
    ).result;
    expect(granted.created).toBe(true);
    fact('沈昼', '名为', '沈四', { secrecy: 3, validFrom: '第02天' });
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'cognition.grant',
          idempotencyKey: 'grant-stale',
          payload: { characterId: '林砚', factId: created.factId },
        },
      ),
    ).toThrow(/无效或已失效/);
  });

  it('结构化断言越权：没有 cognition 的角色 asserts 已知事实 → 阻断且整拍回滚', () => {
    const secret = fact('沈昼', '名为', '沈三', { secrecy: 3 });
    openScene();
    const beatsBefore = (db.prepare('SELECT count(*) AS c FROM beat').get() as { c: number }).c;
    expect(() =>
      commitBeat(present[0]!, {
        structured: {
          line: '我知道你叫沈三。',
          asserts: [{ subject: '沈昼', predicate: '名为', object: '沈三' }],
        },
      }),
    ).toThrow(/结构化断言越权/);
    expect((db.prepare('SELECT count(*) AS c FROM beat').get() as { c: number }).c).toBe(beatsBefore);
    expect((db.prepare('SELECT count(*) AS c FROM message').get() as { c: number }).c).toBe(0);

    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'cognition.grant',
        idempotencyKey: 'grant-ok',
        payload: { characterId: present[0]!, factId: secret.factId, percept: 'told' },
      },
    );
    const committed = commitBeat(present[0]!, {
      structured: {
        line: '我知道你叫沈三。',
        asserts: [{ subject: '沈昼', predicate: '名为', object: '沈三' }],
      },
    });
    expect(committed.beatSeq).toBe(1);
  });

  it('reveals 已失效事实被拒绝（陈旧值不得被引用）', () => {
    const old = fact('林砚', '住在', '客栈', { validFrom: '第01天' });
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'cognition.grant',
        idempotencyKey: 'grant-old',
        payload: { characterId: present[1]!, factId: old.factId },
      },
    );
    fact('林砚', '住在', '船屋', { validFrom: '第02天' });
    openScene();
    expect(() =>
      commitBeat(present[1]!, {
        structured: { line: '他住在客栈。', reveals: [old.factId] },
      }),
    ).toThrow(/陈旧值不得再被引用/);
  });

  it('设定冲突：claim 与锁定事实不同 → ck_setting_conflict', () => {
    fact('林砚', '住在', '客栈', { validFrom: '第01天' });
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'lock.set',
        idempotencyKey: 'lock-setting',
        payload: { scope: 'fact', subject: '林砚', predicate: '住在', reason: '设定锁' },
      },
    );
    openScene();
    expect(() =>
      commitBeat(present[1]!, {
        structured: {
          line: '林砚住在船屋。',
          asserts: [{ subject: '林砚', predicate: '住在', object: '船屋' }],
        },
      }),
    ).toThrow(/ck_setting_conflict|锁定事实冲突/);
  });

  it('认知主体必须在本条消息的受众里', () => {
    const created = fact('林砚', '住在', '客栈');
    openScene();
    expect(() =>
      commitBeat(present[2]!, {
        audience: [present[0]!],
        cognition: [{ characterId: present[1]!, factId: created.factId }],
      }),
    ).toThrow(/认知主体不在/);
  });
});

describe('P2 · 关系钳制', () => {
  it('无理由的大跳变被钳制，有理由放行', () => {
    const set = (value: number, reason = ''): { value: number; clamped: boolean } =>
      bus.submit<{ value: number; clamped: boolean }>(
        { type: 'user', id: 'author' },
        {
          kind: 'relation.set',
          idempotencyKey: `rel-${randomUUID()}`,
          payload: { fromId: present[0]!, toId: present[1]!, axis: 'trust', value, reason },
        },
      ).result;
    const clamped = set(0.9);
    expect(clamped.clamped).toBe(true);
    expect(clamped.value).toBeCloseTo(0.35, 6);
    const allowed = set(-0.8, '他出卖了她');
    expect(allowed.clamped).toBe(false);
    expect(allowed.value).toBe(-0.8);
  });
});

describe('P2 · 记忆与摘要', () => {
  it('memory.add / embed / search / tree / delete', () => {
    const added = bus.submit<{ id: string; hard: boolean; pinned: boolean }>(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.add',
        idempotencyKey: 'mem-1',
        payload: {
          kind: 'clue',
          text: '账本第七页被撕掉了',
          importance: 1.4,
          hard: false,
          sensitivity: 0,
        },
      },
    ).result;
    expect(added.pinned).toBe(false);

    const vector = hashEmbed('账本第七页被撕掉了');
    const embedded = bus.submit<{ updated: number }>(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.embed',
        idempotencyKey: 'embed-1',
        payload: { updates: [{ id: added.id, vector: [...vector], model: 'hash' }] },
      },
    ).result;
    expect(embedded.updated).toBe(1);
    expect(listMemory(db)[0]!.embedded).toBe(true);

    const found = searchMemories(db, { text: '账本 第七页', limit: 8 });
    expect(found.resident.map((row) => row.id)).toContain(added.id);

    const tree = memoryTree(db, added.id);
    expect(tree.summary?.id).toBe(added.id);
    expect(tree.children).toHaveLength(0);

    bus.submit(
      { type: 'user', id: 'author' },
      { kind: 'memory.delete', idempotencyKey: 'mem-del', payload: { id: added.id } },
    );
    expect(listMemory(db)).toHaveLength(0);
  });

  it('hard 必然 pinned；resolvedSeq 只属于 clue', () => {
    const node = bus.submit<{ pinned: boolean; hard: boolean }>(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.add',
        idempotencyKey: 'mem-hard',
        payload: { kind: 'world', text: '禁忌：不可直视神像', hard: true },
      },
    ).result;
    expect(node.hard).toBe(true);
    expect(node.pinned).toBe(true);
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'memory.add',
          idempotencyKey: 'mem-bad',
          payload: { kind: 'event', text: '普通事件', resolvedSeq: 3 },
        },
      ),
    ).toThrow(/只有线索/);
  });

  it('场景关闭写出摘要 + DERIVED_FROM；有子节点的摘要删不掉', () => {
    openScene();
    commitBeat(present[0]!, { prose: '把账本还我。' });
    commitBeat('narrator', { roleType: 'narrator', prose: '雨声压住了门轴。' });
    commitBeat(present[1]!, { prose: '账本不在我这里。' });
    const closed = closeScene();
    expect(closed.summaryNodeId).toBeTruthy();
    const summary = memoryTree(db, closed.summaryNodeId!);
    expect(summary.summary?.kind).toBe('summary');
    expect(summary.children).toHaveLength(3);
    expect(summary.children.every((child) => child.importance === 0.4)).toBe(true);
    expect(summary.summary!.text).toContain('雨声压住了门轴');
    const sceneRow = db.prepare('SELECT summary FROM scene WHERE id = ?').get(sceneId) as {
      summary: string;
    };
    expect(sceneRow.summary).toBe(summary.summary!.text);

    // DERIVED_FROM: child → summary；摘要（dst）有子节点 → 触发器拒绝删除
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'memory.delete',
          idempotencyKey: 'del-summary',
          payload: { id: closed.summaryNodeId },
        },
      ),
    ).toThrow(/ck_memory_has_children/);

    // 子节点（src）可以删：删掉它只是失去一条可回溯的原文
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.delete',
        idempotencyKey: 'del-child',
        payload: { id: summary.children[0]!.id },
      },
    );
    expect(memoryTree(db, closed.summaryNodeId!).children).toHaveLength(2);
  });

  it('角色上下文只注入 owner=本人 的记忆，作者材料不泄漏', () => {
    const charId = present[0]!;
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.add',
        idempotencyKey: 'mem-owner',
        payload: {
          kind: 'event',
          text: '林砚记得：账本在床下',
          ownerId: charId,
          importance: 1.2,
          embedding: [...hashEmbed('林砚记得：账本在床下')],
        },
      },
    );
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'memory.add',
        idempotencyKey: 'mem-world',
        payload: { kind: 'event', text: '作者材料：账本在床下', importance: 1.2 },
      },
    );
    const context = readCharacterContext(db, sceneId, charId);
    expect(context.memories).toHaveLength(1);
    expect(context.memories![0]!.text).toContain('林砚记得');
    const assembled = assembleCharacterContext(context);
    expect(assembled.prompt.user).toContain('林砚记得：账本在床下');
    expect(assembled.prompt.user).not.toContain('作者材料');
  });
});

describe('P2 · 后台任务', () => {
  it('enqueue 递增 generation；claim 丢弃旧代；finish 更新状态', () => {
    const first = bus.submit<{ jobId: string; generation: number }>(
      { type: 'user', id: 'author' },
      {
        kind: 'job.enqueue',
        idempotencyKey: 'job-1',
        payload: { kind: 'embed', targetId: 'mn-x' },
      },
    ).result;
    const second = bus.submit<{ jobId: string; generation: number }>(
      { type: 'user', id: 'author' },
      {
        kind: 'job.enqueue',
        idempotencyKey: 'job-2',
        payload: { kind: 'embed', targetId: 'mn-x' },
      },
    ).result;
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);

    const claimed = bus.submit<{ job: { id: string }; discarded: string[] }>(
      { type: 'user', id: 'author' },
      { kind: 'job.claim', idempotencyKey: 'job-claim', payload: {} },
    ).result;
    expect(claimed.job.id).toBe(second.jobId);
    expect(claimed.discarded).toEqual([first.jobId]);

    const finished = bus.submit<{ status: JobStatus }>(
      { type: 'user', id: 'author' },
      {
        kind: 'job.finish',
        idempotencyKey: 'job-finish',
        payload: { jobId: second.jobId, status: 'done' },
      },
    ).result;
    expect(finished.status).toBe('done');
    expect(listJobs(db).map((job) => job.status).sort()).toEqual(['discarded', 'done']);
  });

  it('空队列 claim 报错；未 running 的任务不能结束', () => {
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        { kind: 'job.claim', idempotencyKey: 'claim-empty', payload: {} },
      ),
    ).toThrow(/队列为空/);
    const enqueued = bus.submit<{ jobId: string }>(
      { type: 'user', id: 'author' },
      { kind: 'job.enqueue', idempotencyKey: 'job-q', payload: { kind: 'index' } },
    ).result;
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'job.finish',
          idempotencyKey: 'finish-queued',
          payload: { jobId: enqueued.jobId, status: 'done' },
        },
      ),
    ).toThrow(/不能结束/);
  });
});

describe('P2 · 回退与重放', () => {
  it('回退到事实 supersede 之前：旧值回来，新值不残留（陈旧值泄漏 0）', () => {
    const first = fact('林砚', '住在', '客栈', { validFrom: '第01天' });
    const target = getActiveBranch(db).headSeq;
    fact('林砚', '住在', '船屋', { validFrom: '第02天' });
    expect(listFacts(db, { subject: '林砚' })[0]!.objectText).toBe('船屋');

    const restored = restoreBranch(db, {
      targetSeq: target,
      idempotencyKey: 'restore-fact',
      label: '回退到客栈',
    });
    const active = listFacts(db, { subject: '林砚' });
    expect(active).toHaveLength(1);
    expect(active[0]!.objectText).toBe('客栈');
    expect(active[0]!.id).not.toBe(first.factId); // 新分支重分配主键
    const newScene = db
      .prepare('SELECT id FROM scene WHERE branch_id = ? AND title = ?')
      .get(restored.branchId, '雨夜·账本') as { id: string };
    const context = readCharacterContext(db, newScene.id, present[0]!);
    expect(JSON.stringify(context.facts)).not.toContain('船屋');
    expect(active[0]!.validTo).toBeNull();
    // 旧分支仍在，且仍有船屋
    const oldFact = db
      .prepare('SELECT object_json FROM fact WHERE branch_id = ? AND valid_to IS NULL')
      .get(restored.fromBranchId) as { object_json: string };
    expect(oldFact.object_json).toBe('"船屋"');
  });

  it('回退穿过场景关闭事件时，摘要节点与边一起重放', () => {
    openScene();
    commitBeat(present[0]!, { prose: '第一拍。' });
    commitBeat(present[1]!, { prose: '第二拍。' });
    closeScene();
    const target = getActiveBranch(db).headSeq;
    // 再写一个事件，保证 target 严格小于 head（回退到当前 head 会被拒绝）
    bus.submit(
      { type: 'system' },
      {
        kind: 'system.warn',
        idempotencyKey: 'after-close-warn',
        payload: { code: 'after_close', message: '推进 head，用于回退测试' },
      },
    );
    const before = db
      .prepare('SELECT id FROM memory_node WHERE kind = ?')
      .all('summary') as { id: string }[];
    expect(before).toHaveLength(1);

    const restored = restoreBranch(db, {
      targetSeq: target,
      idempotencyKey: 'restore-summary',
      label: '重放摘要',
    });
    const summaries = db
      .prepare('SELECT id FROM memory_node WHERE branch_id = ? AND kind = ?')
      .all(restored.branchId, 'summary') as { id: string }[];
    expect(summaries).toHaveLength(1);
    const children = db
      .prepare(
        "SELECT count(*) AS c FROM memory_edge WHERE dst = ? AND kind = 'DERIVED_FROM'",
      )
      .get(summaries[0]!.id) as { c: number };
    expect(children.c).toBe(2);
  });
});

describe('P2 · 实体与自定义谓词', () => {
  function addEntity(payload: Record<string, unknown>): { entityId: string; action: string } {
    return bus.submit<{ entityId: string; action: string }>(
      { type: 'user', id: 'author' },
      { kind: 'entity.add', idempotencyKey: `entity-${randomUUID()}`, payload },
    ).result;
  }

  function definePredicate(
    predicate: string,
    cardinality: 'single' | 'multi' = 'single',
    description = '',
  ): void {
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'predicate.define',
        idempotencyKey: `predicate-${randomUUID()}`,
        payload: { predicate, cardinality, description },
      },
    );
  }

  it('entity add：物品可建；同内容幂等，内容不同拒绝；事实可用新实体', () => {
    const added = addEntity({
      kind: 'item',
      name: '玉佩',
      aliases: ['双鱼佩'],
      card: { material: '和田玉' },
    });
    expect(added.action).toBe('insert');
    const same = addEntity({
      kind: 'item',
      name: '玉佩',
      aliases: ['双鱼佩'],
      card: { material: '和田玉' },
    });
    expect(same.action).toBe('same');
    expect(same.entityId).toBe(added.entityId);
    expect(() =>
      addEntity({ kind: 'item', name: '玉佩', card: { material: '翡翠' } }),
    ).toThrow(/内容不同/);

    const held = fact('玉佩', '持有', { id: present[0]!, name: '林砚' });
    expect(held.action).toBe('insert');
    expect(held.slotKey).toContain('|持有|');

    // 别名可解析：不用改名字也能给同一实体写事实
    const viaAlias = fact('双鱼佩', '位于', '枯井', { validFrom: '第02天' });
    expect(viaAlias.slotKey.startsWith(`${added.entityId}|位于|`)).toBe(true);
  });

  it('predicate define：自定义谓词可写入事实；重复与含 | 被拒绝', () => {
    definePredicate('送达', 'single', '信件是否送达');
    const spec = listPredicates(db).find((row) => row.predicate === '送达');
    expect(spec).toMatchObject({ cardinality: 'single', builtin: false });
    expect(() => definePredicate('送达')).toThrow(/已存在/);
    expect(() => definePredicate('坏|谓词')).toThrow(/\|/);

    const delivered = fact('林砚', '送达', true, { validFrom: '第01天' });
    expect(delivered.slotKey).toBe(`${present[0]}|送达|`);
    expect(listFacts(db, { subject: '林砚' })[0]!.predicate).toBe('送达');
  });

  it('状态包携带 predicate_spec：导入空库后事实外键不悬空', () => {
    definePredicate('送达', 'single');
    fact('林砚', '送达', true, { validFrom: '第01天' });
    const branch = getActiveBranch(db)!;
    const buffer = exportStatePackage(db, branch.id, branch.headSeq);
    const pkg = decodeStatePackage(buffer);
    const exported = (pkg.tables.predicate_spec ?? []).find(
      (row) => row.predicate === '送达',
    ) as Record<string, unknown> | undefined;
    expect(exported).toMatchObject({ cardinality: 'single', builtin: 0 });

    const otherFile = path.join(TMP, `pkg-${randomUUID()}.db`);
    const other = openDatabase(otherFile);
    try {
      migrate(other);
      const restored = restoreFromPackage(other, pkg, {
        rootPath: 'C:/tmp/noryth-p2-package',
        fromCommit: 'f'.repeat(40),
        idempotencyKey: 'package-custom-predicate',
      });
      expect(getActiveBranch(other).id).toBe(restored.branchId);
      const rows = listFacts(other, { subject: '林砚' });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.predicate).toBe('送达');
      expect(rows[0]!.objectText).toBe('true');
    } finally {
      closeDatabase(other);
      for (const suffix of ['', '-wal', '-shm']) rmSync(otherFile + suffix, { force: true });
    }
  });

  it('快照回退先恢复 predicate_spec，再用它写事实', () => {
    definePredicate('送达', 'single');
    fact('林砚', '送达', true, { validFrom: '第01天' });
    const branch = getActiveBranch(db)!;
    const target = branch.headSeq;
    createCheckpointWithSnapshot(db, {
      branchId: branch.id,
      seq: target,
      label: '自定义谓词基线',
      trigger: 'manual',
    });
    fact('林砚', '送达', false, { validFrom: '第02天' });
    expect(listFacts(db, { subject: '林砚' })[0]!.objectText).toBe('false');

    restoreBranch(db, {
      targetSeq: target,
      idempotencyKey: 'restore-custom-predicate',
      label: '回到送达前',
    });
    const active = listFacts(db, { subject: '林砚' });
    expect(active).toHaveLength(1);
    expect(active[0]!.predicate).toBe('送达');
    expect(active[0]!.objectText).toBe('true');
    expect(listPredicates(db).some((row) => row.predicate === '送达')).toBe(true);
  });

  it('lock release：解锁后可写；锁历史留在事件里；重复解锁报错', () => {
    fact('林砚', '住在', '客栈', { validFrom: '第01天' });
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'lock.set',
        idempotencyKey: 'lock-release-set',
        payload: {
          scope: 'fact',
          subject: '林砚',
          predicate: '住在',
          reason: '先锁住',
        },
      },
    );
    expect(() => fact('林砚', '住在', '船屋', { validFrom: '第02天' })).toThrow(/锁定/);
    const released = bus.submit<{ released: true }>(
      { type: 'user', id: 'author' },
      {
        kind: 'lock.release',
        idempotencyKey: 'lock-release-do',
        payload: { scope: 'fact', subject: '林砚', predicate: '住在' },
      },
    ).result;
    expect(released.released).toBe(true);
    expect(listLocks(db)).toHaveLength(0);
    expect(fact('林砚', '住在', '船屋', { validFrom: '第02天' }).action).toBe('supersede');
    const events = db
      .prepare("SELECT count(*) AS c FROM event WHERE kind IN ('lock.set','lock.released')")
      .get() as { c: number };
    expect(events.c).toBe(2);
    expect(() =>
      bus.submit(
        { type: 'user', id: 'author' },
        {
          kind: 'lock.release',
          idempotencyKey: 'lock-release-again',
          payload: { scope: 'fact', subject: '林砚', predicate: '住在' },
        },
      ),
    ).toThrow(/没有这条设定锁/);
  });
});
