import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandBus,
  UsageError,
  closeDatabase,
  constraintNameOf,
  createCheckpointWithSnapshot,
  createProject,
  decodeStatePackage,
  domainFingerprint,
  exportStatePackage,
  getActiveBranch,
  migrate,
  openDatabase,
  readDeck,
  restoreBranch,
  restoreFromPackage,
  type Db,
} from '@noryth/store';
import { PARAMS } from '@noryth/core';

const TMP = path.resolve(process.cwd(), 'node_modules', '.cache', 'noryth-p1-store');
let db: Db;
let file: string;
let bus: CommandBus;
let sceneId: string;
let present: string[];

function createScene(overrides: Record<string, unknown> = {}): {
  sceneId: string;
  present: string[];
} {
  const result = bus.submit<{ sceneId: string; present: string[] }>(
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
        cards: [
          { title: '不速之客', minLevel: 0, weight: 1, oneShot: false },
          { title: '有人死了', minLevel: 4, weight: 2, oneShot: true },
        ],
        ...overrides,
      },
    },
  );
  return result.result;
}

function openScene(): void {
  bus.submit(
    { type: 'user', id: 'author' },
    {
      kind: 'scene.state',
      idempotencyKey: `open-${sceneId}`,
      payload: { sceneId, to: 'open' },
    },
  );
}

let key = 0;
function commitBeat(
  agentId: string,
  overrides: Record<string, unknown> = {},
): { beatSeq: number; messageSeq: number; beatId: string } {
  key += 1;
  const roleType = (overrides.roleType as string) ?? 'character';
  const audience =
    overrides.audience ??
    (roleType === 'narrator' ? [] : present.filter((id) => id !== agentId).slice(0, 1));
  const result = bus.submit<{ beatSeq: number; messageSeq: number; beatId: string }>(
    { type: 'character', id: agentId },
    {
      kind: 'beat.commit',
      idempotencyKey: `beat-${key}`,
      payload: {
        sceneId,
        agentId,
        roleType,
        mode: 'auto',
        score: 0.5,
        damped: 0.4,
        breakdown: { parts: {} },
        prose: `第 ${key} 拍。`,
        structured: { line: `第 ${key} 拍。` },
        percept: roleType === 'narrator' ? 'narrator_reader' : 'public',
        audience,
        cognition: [],
        relations: [],
        conflictLevel: 2.1,
        ...overrides,
      },
    },
  );
  return result.result;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  file = path.join(TMP, `theater-${randomUUID()}.db`);
  db = openDatabase(file);
  migrate(db);
  createProject(db, { name: 'P1 测试', rootPath: 'C:/tmp/noryth-p1' });
  bus = new CommandBus(db);
  const created = createScene();
  sceneId = created.sceneId;
  present = created.present;
});

afterEach(() => {
  closeDatabase(db);
  for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
});

describe('P1 · 建场', () => {
  it('3 角色 + 1 旁白 + 牌堆，一次事件写入', () => {
    const entities = db
      .prepare("SELECT count(*) AS c FROM entity WHERE kind = 'character'")
      .get() as { c: number };
    const agents = db.prepare('SELECT role_type, count(*) AS c FROM agent_config GROUP BY role_type').all() as {
      role_type: string;
      c: number;
    }[];
    expect(entities.c).toBe(3);
    expect(agents.find((a) => a.role_type === 'character')?.c).toBe(3);
    expect(agents.find((a) => a.role_type === 'narrator')?.c).toBe(1);
    expect(readDeck(db, getActiveBranch(db)!.id)).toHaveLength(2);
    expect(
      (db.prepare("SELECT count(*) AS c FROM event WHERE kind = 'scene.created'").get() as { c: number }).c,
    ).toBe(1);
  });

  it('复用已有角色与旁白，不重复建实体', () => {
    createScene({ title: '第二场', storyStart: '第02天' });
    expect(
      (db.prepare("SELECT count(*) AS c FROM entity WHERE kind = 'character'").get() as { c: number }).c,
    ).toBe(3);
    expect(
      (db.prepare("SELECT count(*) AS c FROM agent_config WHERE role_type = 'narrator'").get() as { c: number }).c,
    ).toBe(1);
  });

  it('场景第一拍必须旁白（由 planBeat 决定；命令层只校验身份与受众）', () => {
    openScene();
    expect(() =>
      commitBeat('narrator', { roleType: 'narrator', audience: [present[0]!] }),
    ).toThrowError(/旁白不得有受众/);
  });

  it('在场者之外的角色不能发言', () => {
    openScene();
    expect(() =>
      commitBeat('e_missing', { audience: [] }),
    ).toThrowError(UsageError);
  });

  it('一轮 beat 落进 message / beat / scene.beats', () => {
    openScene();
    const first = commitBeat(present[0]!);
    expect(first.beatSeq).toBe(1);
    const beat = db.prepare('SELECT seq, agent_id FROM beat WHERE id = ?').get(first.beatId) as {
      seq: number;
      agent_id: string;
    };
    expect(beat.seq).toBe(1);
    expect(beat.agent_id).toBe(present[0]);
    expect(
      (db.prepare('SELECT beats FROM scene WHERE id = ?').get(sceneId) as { beats: number }).beats,
    ).toBe(1);
    expect(
      (db.prepare('SELECT count(*) AS c FROM message WHERE scene_id = ?').get(sceneId) as { c: number }).c,
    ).toBe(1);
  });

  it('到 max_beats 后拒绝新拍（不静默超拍）', () => {
    const short = createScene({
      title: '短场',
      storyStart: '第02天',
      maxBeats: 2,
      exitConditions: { op: 'beats', cmp: '>=', value: 99 },
    });
    sceneId = short.sceneId;
    present = short.present;
    openScene();
    for (let i = 0; i < 2; i += 1) commitBeat(present[i % 3]!);
    expect(() => commitBeat(present[0]!)).toThrowError(/max_beats/);
  });

  it('收束旁白走 message.append，不占拍号', () => {
    openScene();
    commitBeat(present[0]!);
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'scene.state',
        idempotencyKey: 'closing',
        payload: { sceneId, to: 'closing' },
      },
    );
    bus.submit(
      { type: 'character', id: 'narrator' },
      {
        kind: 'message.append',
        idempotencyKey: 'closing-msg',
        payload: {
          sceneId,
          agentId: 'narrator',
          roleType: 'narrator',
          prose: '天亮了。',
          structured: { paragraphs: ['天亮了。'], closing: true },
          audience: [],
          percept: 'narrator_reader',
        },
      },
    );
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'scene.state',
        idempotencyKey: 'closed',
        payload: { sceneId, to: 'closed' },
      },
    );
    const scene = db.prepare('SELECT beats, state, closed_seq FROM scene WHERE id = ?').get(sceneId) as {
      beats: number;
      state: string;
      closed_seq: number;
    };
    expect(scene.beats).toBe(1);
    expect(scene.state).toBe('closed');
    expect(scene.closed_seq).toBeGreaterThan(0);
    expect(
      (db.prepare("SELECT count(*) AS c FROM message WHERE role_type = 'narrator'").get() as { c: number }).c,
    ).toBe(1);
  });
});

describe('P1 · 知识边界落库', () => {
  function addFact(subjectId: string, predicate = '住在', object = '"客栈"'): string {
    const branch = getActiveBranch(db)!;
    const id = `f-${randomUUID()}`;
    db.prepare(
      `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
         valid_from, source_seq, created_at)
       VALUES (?, ?, ?, ?, ?, 'single', 1, 1, '第01天', 2, ?)`,
    ).run(id, branch.id, subjectId, predicate, object, new Date().toISOString());
    return id;
  }

  it('beat 的 cognition 行写入，重复行被忽略', () => {
    openScene();
    const lin = present[0]!;
    const shen = present[1]!;
    const factId = addFact(lin);
    commitBeat(shen, {
      cognition: [{ characterId: shen, factId, attitude: 'knows', percept: 'told' }],
    });
    commitBeat(lin, {
      cognition: [{ characterId: shen, factId, attitude: 'knows', percept: 'told' }],
    });
    const rows = db.prepare('SELECT * FROM cognition WHERE fact_id = ?').all(factId) as {
      character_id: string;
      source_message_id: string | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.character_id).toBe(shen);
    expect(rows[0]!.source_message_id).not.toBeNull();
  });

  it('cognition 引用不存在的事实被拒绝，整条拍回滚', () => {
    openScene();
    expect(() =>
      commitBeat(present[0]!, {
        cognition: [{ characterId: present[1]!, factId: 'f-ghost', attitude: 'knows' }],
      }),
    ).toThrowError(/无效事实/);
    expect(
      (db.prepare('SELECT count(*) AS c FROM beat').get() as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare('SELECT count(*) AS c FROM event WHERE kind = \'beat.committed\'').get() as { c: number }).c,
    ).toBe(0);
  });
});

describe('P1 · 关系突变', () => {
  it('无理由的大幅变化被钳制到阈值', () => {
    const lin = present[0]!;
    const shen = present[1]!;
    const result = bus.submit<{ value: number; clamped: boolean }>(
      { type: 'user', id: 'author' },
      {
        kind: 'relation.set',
        idempotencyKey: 'rel-1',
        payload: { fromId: lin, toId: shen, axis: 'trust', value: 1 },
      },
    );
    expect(result.result.clamped).toBe(true);
    expect(result.result.value).toBeCloseTo(PARAMS['consistency.relation_jump_threshold'], 6);
  });

  it('给了理由就按原值写入', () => {
    const lin = present[0]!;
    const shen = present[1]!;
    const result = bus.submit<{ value: number; clamped: boolean }>(
      { type: 'user', id: 'author' },
      {
        kind: 'relation.set',
        idempotencyKey: 'rel-2',
        payload: { fromId: lin, toId: shen, axis: 'trust', value: 1, reason: '他救了她的命' },
      },
    );
    expect(result.result.clamped).toBe(false);
    expect(result.result.value).toBe(1);
  });
});

describe('P1 · 时间线', () => {
  it('同 timeline 内故事时间倒退被 ck_scene_time_regression 拒绝', () => {
    createScene({ title: '第十天', storyStart: '第10天' });
    try {
      createScene({ title: '倒退', storyStart: '第05天' });
      throw new Error('应当被拒绝');
    } catch (error) {
      expect(constraintNameOf(error)).toBe('ck_scene_time_regression');
    }
  });

  it('换 timeline 的闪回通过', () => {
    createScene({ title: '第十天', storyStart: '第10天' });
    const flashback = createScene({
      title: '闪回',
      storyStart: '第05天',
      timeline: 'flashback-a',
    });
    expect(flashback.sceneId).toBeTruthy();
  });
});

describe('P1 · 回退 8 域', () => {
  it('快照 + 重放后逐域值与目标一致，旧分支保留', () => {
    openScene();
    const lin = present[0]!;
    const shen = present[1]!;
    for (let i = 0; i < 4; i += 1) commitBeat(present[i % 3]!);
    const branch = getActiveBranch(db)!;
    const targetSeq = branch.headSeq;
    createCheckpointWithSnapshot(db, {
      branchId: branch.id,
      seq: targetSeq,
      label: '目标',
      trigger: 'manual',
    });
    const targetFp = domainFingerprint(db, branch.id);

    // 目标之后：消息、事实、认知、关系、正文、卡牌、摘要、向量全部变化。
    for (let i = 0; i < 2; i += 1) commitBeat(present[i % 3]!);
    const oneShotCard = (
      db.prepare('SELECT id FROM event_card WHERE one_shot = 1 LIMIT 1').get() as { id: string }
    ).id;
    commitBeat(present[0]!, { cardId: oneShotCard });
    const afterSeq = getActiveBranch(db)!.headSeq;
    const factId = `f-${randomUUID()}`;
    db.prepare(
      `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
         valid_from, source_seq, created_at)
       VALUES (?, ?, ?, '住在', '"客栈"', 'single', 1, 1, '第01天', ?, ?)`,
    ).run(factId, branch.id, lin, afterSeq, new Date().toISOString());
    db.prepare(
      `INSERT INTO cognition(branch_id, character_id, fact_id, attitude, certainty, learned_seq,
         source_message_id, percept)
       VALUES (?, ?, ?, 'knows', 1, ?, NULL, 'witness')`,
    ).run(branch.id, shen, factId, afterSeq);
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'relation.set',
        idempotencyKey: 'rel-after',
        payload: { fromId: lin, toId: shen, axis: 'trust', value: 0.5, reason: '目标之后' },
      },
    );
    const chapterId = `ch-${randomUUID()}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO chapter(id, branch_id, idx, title, file_path, content_hash, word_count,
         covered_until_seq, status, current_rev, updated_seq)
       VALUES (?, ?, 0, '第一章', 'chapters/01.md', ?, 10, ?, 'draft', 1, ?)`,
    ).run(chapterId, branch.id, 'a'.repeat(64), afterSeq, afterSeq);
    db.prepare(
      `INSERT INTO revision(id, chapter_id, rev, parent_rev, content, content_hash, author,
         reason, issue_ids, created_at)
       VALUES (?, ?, 1, NULL, '正文', ?, 'user', NULL, '[]', ?)`,
    ).run(`rv-${randomUUID()}`, chapterId, 'b'.repeat(64), now);
    const summaryId = `mn-${randomUUID()}`;
    db.prepare(
      `INSERT INTO memory_node(id, branch_id, kind, text, valid_from, source_seq)
       VALUES (?, ?, 'summary', '这一场的摘要。', '第01天', ?)`,
    ).run(summaryId, branch.id, afterSeq);
    db.prepare(
      `INSERT INTO memory_node(id, branch_id, kind, text, valid_from, source_seq, embedding,
         embedding_model, embedding_dim)
       VALUES (?, ?, 'event', '带向量的一拍。', '第01天', ?, ?, 'test', 4)`,
    ).run(
      `mn-${randomUUID()}`,
      branch.id,
      afterSeq,
      Buffer.alloc(16, 1),
    );

    const beforeCounts = {
      messages: (db.prepare('SELECT count(*) AS c FROM message WHERE branch_id = ?').get(branch.id) as { c: number }).c,
      facts: (db.prepare('SELECT count(*) AS c FROM fact WHERE branch_id = ?').get(branch.id) as { c: number }).c,
      cognition: (db.prepare('SELECT count(*) AS c FROM cognition WHERE branch_id = ?').get(branch.id) as { c: number }).c,
      relations: (db.prepare('SELECT count(*) AS c FROM relation WHERE branch_id = ?').get(branch.id) as { c: number }).c,
      chapters: (db.prepare('SELECT count(*) AS c FROM chapter WHERE branch_id = ?').get(branch.id) as { c: number }).c,
      summaries: (db.prepare("SELECT count(*) AS c FROM memory_node WHERE branch_id = ? AND kind = 'summary'").get(branch.id) as { c: number }).c,
      vectors: (db.prepare('SELECT count(*) AS c FROM memory_node WHERE branch_id = ? AND embedding IS NOT NULL').get(branch.id) as { c: number }).c,
    };

    const result = restoreBranch(db, { targetSeq, idempotencyKey: 'restore-1' });

    expect(result.branchName).toBe('main~r1');
    expect(result.counts.messages).toBe(4);
    expect(result.counts.facts).toBe(0);
    expect(result.counts.cognition).toBe(0);
    expect(result.counts.relations).toBe(0);
    expect(result.counts.chapters).toBe(0);
    expect(result.counts.cards).toBe(2);
    expect(result.counts.summaries).toBe(0);
    expect(result.counts.vectors).toBe(0);

    const restoredFp = domainFingerprint(db, result.branchId);
    for (const domain of Object.keys(targetFp)) {
      expect(restoredFp[domain]).toEqual(targetFp[domain]);
    }

    // 旧分支一行不删
    const oldCounts = {
      messages: (db.prepare('SELECT count(*) AS c FROM message WHERE branch_id = ?').get(branch.id) as { c: number }).c,
      relations: (db.prepare('SELECT count(*) AS c FROM relation WHERE branch_id = ?').get(branch.id) as { c: number }).c,
      chapters: (db.prepare('SELECT count(*) AS c FROM chapter WHERE branch_id = ?').get(branch.id) as { c: number }).c,
    };
    expect(oldCounts.messages).toBe(beforeCounts.messages);
    expect(oldCounts.relations).toBe(beforeCounts.relations);
    expect(oldCounts.chapters).toBe(beforeCounts.chapters);

    // 活动指针切到新分支
    const active = getActiveBranch(db)!;
    expect(active.id).toBe(result.branchId);

    // 同键重放返回原结果，不再开分支
    const again = restoreBranch(db, { targetSeq, idempotencyKey: 'restore-1' });
    expect(again.replay).toBe(true);
    expect(again.branchId).toBe(result.branchId);
    expect(
      (db.prepare('SELECT count(*) AS c FROM branch').get() as { c: number }).c,
    ).toBe(2);
  });

  it('重放覆盖 scene.state / message.append / relation.set', () => {
    openScene();
    const branch = getActiveBranch(db)!;
    createCheckpointWithSnapshot(db, {
      branchId: branch.id,
      seq: branch.headSeq,
      label: '重放起点',
      trigger: 'manual',
    });
    const lin = present[0]!;
    const shen = present[1]!;
    bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'relation.set',
        idempotencyKey: 'replay-rel',
        payload: { fromId: lin, toId: shen, axis: 'trust', value: 0.2, reason: '重放测试' },
      },
    );
    bus.submit(
      { type: 'director' },
      {
        kind: 'message.append',
        idempotencyKey: 'replay-director',
        payload: {
          sceneId,
          agentId: 'director',
          roleType: 'director',
          prose: '抽牌「不速之客」',
          structured: { cardTitle: '不速之客' },
          audience: [],
          percept: 'director',
        },
      },
    );
    commitBeat(lin);
    const target = getActiveBranch(db)!.headSeq - 1;
    const result = restoreBranch(db, { targetSeq: target, idempotencyKey: 'restore-events' });
    expect(result.counts.messages).toBe(1);
    expect(result.counts.relations).toBe(1);
    expect(
      (db.prepare("SELECT count(*) AS c FROM message WHERE branch_id = ? AND role_type = 'director'").get(result.branchId) as { c: number }).c,
    ).toBe(1);
    expect(
      (db.prepare("SELECT count(*) AS c FROM message WHERE branch_id = ? AND role_type = 'character'").get(result.branchId) as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare('SELECT state FROM scene WHERE id = ?').get(
        db.prepare('SELECT id FROM scene WHERE branch_id = ?').get(result.branchId).id,
      ) as { state: string }).state,
    ).toBe('open');
  });

  it('回退分支自身也有回退点快照（二次回退不会变成空分支）', () => {
    openScene();
    for (let i = 0; i < 3; i += 1) commitBeat(present[i % 3]!);
    const target = getActiveBranch(db)!.headSeq;
    commitBeat(present[0]!); // 让 target 严格早于 head
    const first = restoreBranch(db, { targetSeq: target, idempotencyKey: 'restore-first' });
    expect(first.counts.messages).toBe(3);
    const second = restoreBranch(db, { targetSeq: target, idempotencyKey: 'restore-second' });
    expect(second.snapshotSeq).toBe(target);
    expect(second.counts.messages).toBe(3);
    expect(second.branchId).not.toBe(first.branchId);
  });

  it('回退到当前 head 被拒绝', () => {
    const branch = getActiveBranch(db)!;
    expect(() =>
      restoreBranch(db, { targetSeq: branch.headSeq, idempotencyKey: 'restore-head' }),
    ).toThrow();
  });

  it('目标早于第一个快照时从头重放', () => {
    openScene();
    for (let i = 0; i < 3; i += 1) commitBeat(present[i % 3]!);
    const branch = getActiveBranch(db)!;
    const result = restoreBranch(db, { targetSeq: branch.headSeq - 1, idempotencyKey: 'restore-early' });
    expect(result.snapshotSeq).toBe(0);
    expect(result.counts.messages).toBe(2);
  });
});

describe('P1 · Git 状态包', () => {
  it('导出 → 空库导入：8 域一致，新坐标不倒退', () => {
    openScene();
    for (let i = 0; i < 4; i += 1) commitBeat(present[i % 3]!);
    const branch = getActiveBranch(db)!;
    const buffer = exportStatePackage(db, branch.id, branch.headSeq);
    // zstd 帧魔数：28 B5 2F FD
    expect([...buffer.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
    const pkg = decodeStatePackage(buffer);
    expect(pkg.projectId).toBe(branch.projectId);
    expect(pkg.seq).toBe(branch.headSeq);
    expect(pkg.tables.message).toHaveLength(4);

    const freshFile = path.join(TMP, `fresh-${randomUUID()}.db`);
    const fresh = openDatabase(freshFile);
    try {
      migrate(fresh);
      const restored = restoreFromPackage(fresh, pkg, {
        rootPath: 'C:/tmp/noryth-fresh',
        fromCommit: 'abc1234',
        idempotencyKey: 'pkg-restore-1',
      });
      expect(restored.branchName).toBe('main~r1');
      expect(restored.replayedEvents).toBe(0);
      expect(restored.counts.messages).toBe(4);
      expect(restored.headSeq).toBeGreaterThan(pkg.seq);
      expect(domainFingerprint(fresh, restored.branchId)).toEqual(
        domainFingerprint(db, branch.id),
      );

      // 复制来的拍没有本分支事件：eventSeq 必须归零，否则 beat rewind 指向空坐标
      const beats = fresh
        .prepare('SELECT breakdown FROM beat WHERE branch_id = ?')
        .all(restored.branchId) as { breakdown: string }[];
      expect(beats).toHaveLength(4);
      for (const beat of beats) {
        expect((JSON.parse(beat.breakdown) as { eventSeq: number }).eventSeq).toBe(0);
      }

      // 同 key 重放：返回同一分支，不重复建
      const again = restoreFromPackage(fresh, pkg, {
        rootPath: 'C:/tmp/noryth-fresh',
        fromCommit: 'abc1234',
        idempotencyKey: 'pkg-restore-1',
      });
      expect(again.replay).toBe(true);
      expect(again.branchId).toBe(restored.branchId);
    } finally {
      closeDatabase(fresh);
      for (const suffix of ['', '-wal', '-shm']) rmSync(freshFile + suffix, { force: true });
    }
  });

  it('拒绝导入别的项目的状态包', () => {
    openScene();
    commitBeat(present[0]!);
    const branch = getActiveBranch(db)!;
    const pkg = decodeStatePackage(exportStatePackage(db, branch.id, branch.headSeq));
    const otherFile = path.join(TMP, `other-${randomUUID()}.db`);
    const other = openDatabase(otherFile);
    try {
      migrate(other);
      const otherProject = createProject(other, { name: '别的项目', rootPath: 'C:/tmp/other' });
      expect(otherProject.id).not.toBe(pkg.projectId);
      expect(() =>
        restoreFromPackage(other, pkg, {
          rootPath: 'C:/tmp/other',
          fromCommit: 'deadbee',
          idempotencyKey: 'pkg-wrong-project',
        }),
      ).toThrow(/属于项目/);
    } finally {
      closeDatabase(other);
      for (const suffix of ['', '-wal', '-shm']) rmSync(otherFile + suffix, { force: true });
    }
  });
});
