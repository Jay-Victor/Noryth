import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommandBus,
  ConstraintError,
  SchemaVersionError,
  UsageError,
  closeDatabase,
  constraintNameOf,
  createProject,
  getActiveBranch,
  isSqliteConstraint,
  migrate,
  openDatabase,
  openDatabase as open,
  SCHEMA_VERSION,
  type Db,
} from '@noryth/store';

const TMP = path.resolve(process.cwd(), 'node_modules', '.cache', 'noryth-tests');
let db: Db;
let file: string;
let bus: CommandBus;

function fixture(target: Db): void {
  const project = createProject(target, {
    name: '幂等测试',
    rootPath: 'C:/tmp/noryth-fixture',
    now: '2026-01-01T00:00:00.000Z',
  });
  const branch = getActiveBranch(target)!;
  expect(branch.id).toBe(project.branchId);
  target
    .prepare(
      `INSERT INTO entity(id, branch_id, kind, name) VALUES
       ('e_lin', ?, 'character', '林砚'), ('e_shen', ?, 'character', '沈昼')`,
    )
    .run(branch.id, branch.id);
  target
    .prepare(
      `INSERT INTO scene(id, branch_id, idx, title, story_start, present, goal, state, exit_conditions)
       VALUES ('s1', ?, 0, '雨夜', '第三天夜', '["e_lin","e_shen"]', '{}', 'open', '{}')`,
    )
    .run(branch.id);
}

const line = (prose: string) => ({
  sceneId: 's1',
  agentId: 'e_lin',
  roleType: 'character' as const,
  prose,
  structured: { line: prose },
  audience: ['e_shen'],
  percept: 'public' as const,
});

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  file = path.join(TMP, `store-${randomUUID()}.db`);
  db = openDatabase(file);
  migrate(db);
  fixture(db);
  bus = new CommandBus(db);
});

afterEach(() => {
  closeDatabase(db);
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(file + suffix, { force: true });
  }
});

describe('schema 与迁移', () => {
  it('建库后有 26 张领域表且 user_version=1', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    expect(tables).toHaveLength(26);
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION);
  });

  it('重复 migrate 是 no-op', () => {
    expect(migrate(db)).toEqual({ from: 1, to: 1, applied: false });
  });

  it('数据库版本高于程序时拒绝打开', () => {
    db.pragma('user_version = 99');
    expect(() => migrate(db)).toThrow(SchemaVersionError);
  });

  it('migrate 在只读连接上不会写库', () => {
    const ro = open(file, { readonly: true });
    try {
      expect(migrate(ro).applied).toBe(false);
    } finally {
      closeDatabase(ro);
    }
  });
});

describe('命令总线 · 幂等收据（P0 门禁 4）', () => {
  it('同一命令重放两次只产生一条消息', () => {
    const command = { kind: 'message.append', idempotencyKey: 'k-1', payload: line('你迟到了。') };
    const first = bus.submit({ type: 'user', id: 'author' }, command);
    const second = bus.submit({ type: 'user', id: 'author' }, command);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.seq).toBe(first.seq);
    expect(second.result).toEqual(first.result);
    expect((db.prepare('SELECT count(*) AS c FROM message').get() as { c: number }).c).toBe(1);
    expect((db.prepare('SELECT count(*) AS c FROM receipt').get() as { c: number }).c).toBe(1);
    expect(getActiveBranch(db)!.headSeq).toBe(1);
  });

  it('同一请求不同键序命中同一条收据（canonical JSON）', () => {
    const reordered = {
      percept: 'public' as const,
      audience: ['e_shen'],
      structured: { line: 'A' },
      prose: 'A',
      agentId: 'e_lin',
      roleType: 'character',
      sceneId: 's1',
    };
    bus.submit(
      { type: 'user' },
      { kind: 'message.append', idempotencyKey: 'k-order', payload: line('A') },
    );
    const second = bus.submit(
      { type: 'user' },
      { kind: 'message.append', idempotencyKey: 'k-order', payload: reordered },
    );
    expect(second.replayed).toBe(true);
    expect((db.prepare('SELECT count(*) AS c FROM message').get() as { c: number }).c).toBe(1);
  });

  it('同键不同请求被拒绝，且不写入', () => {
    bus.submit({ type: 'user' }, { kind: 'message.append', idempotencyKey: 'k-1', payload: line('A') });
    expect(() =>
      bus.submit({ type: 'user' }, { kind: 'message.append', idempotencyKey: 'k-1', payload: line('B') }),
    ).toThrowError(ConstraintError);
    expect((db.prepare('SELECT count(*) AS c FROM message').get() as { c: number }).c).toBe(1);
    expect(getActiveBranch(db)!.headSeq).toBe(1);
  });

  it('expectedHead 过期时拒绝，失败不占用幂等键', () => {
    bus.submit(
      { type: 'user' },
      { kind: 'message.append', idempotencyKey: 'k-advance', payload: line('第一拍') },
    );
    expect(() =>
      bus.submit(
        { type: 'user' },
        { kind: 'message.append', idempotencyKey: 'k-2', expectedHead: 0, payload: line('A') },
      ),
    ).toThrowError(/过期 head/);
    expect((db.prepare('SELECT count(*) AS c FROM receipt').get() as { c: number }).c).toBe(1);

    const ok = bus.submit(
      { type: 'user' },
      { kind: 'message.append', idempotencyKey: 'k-2', expectedHead: 1, payload: line('A') },
    );
    expect(ok.replayed).toBe(false);
    expect(ok.seq).toBe(2);
  });

  it('投影失败时事件、消息、收据、head 全部回滚（引用完整性）', () => {
    expect(() =>
      bus.submit(
        { type: 'user' },
        {
          kind: 'message.append',
          idempotencyKey: 'k-3',
          payload: { ...line('A'), sceneId: 'scene_missing' },
        },
      ),
    ).toThrowError(UsageError);

    expect((db.prepare('SELECT count(*) AS c FROM message').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) AS c FROM receipt').get() as { c: number }).c).toBe(0);
    expect(
      (db.prepare("SELECT count(*) AS c FROM event WHERE kind = 'message.appended'").get() as {
        c: number;
      }).c,
    ).toBe(0);
    expect(getActiveBranch(db)!.headSeq).toBe(0);

    // 键没有被占用：同一个键可以用正确负载重试
    const retry = bus.submit(
      { type: 'user' },
      { kind: 'message.append', idempotencyKey: 'k-3', payload: line('A') },
    );
    expect(retry.seq).toBe(1);
  });
});

describe('事件日志只追加（P0 门禁 5）', () => {
  it('UPDATE 被 ck_event_immutable 拒绝', () => {
    try {
      db.prepare("UPDATE event SET kind = 'tampered' WHERE kind = 'project.created'").run();
      throw new Error('应当被拒绝');
    } catch (error) {
      expect(constraintNameOf(error)).toBe('ck_event_immutable');
      expect(isSqliteConstraint(error)).toBe(true);
      expect((error as Error).message).toContain('ck_event_immutable');
    }
  });

  it('DELETE 被 ck_event_immutable 拒绝', () => {
    try {
      db.prepare('DELETE FROM event').run();
      throw new Error('应当被拒绝');
    } catch (error) {
      expect(constraintNameOf(error)).toBe('ck_event_immutable');
      expect(isSqliteConstraint(error)).toBe(true);
    }
  });
});

describe('消息写入的感知规则', () => {
  it('耳语必须有受众', () => {
    expect(() =>
      bus.submit(
        { type: 'user' },
        {
          kind: 'message.append',
          idempotencyKey: 'k-w',
          payload: { ...line('过来'), audience: [], percept: 'whisper' },
        },
      ),
    ).toThrowError(/耳语必须有受众/);
  });

  it('心理独白不得有受众', () => {
    expect(() =>
      bus.submit(
        { type: 'user' },
        {
          kind: 'message.append',
          idempotencyKey: 'k-s',
          payload: { ...line('他在试探我'), audience: ['e_shen'], percept: 'soliloquy' },
        },
      ),
    ).toThrowError(/不得有受众/);
  });

  it('受众必须是本分支实体', () => {
    expect(() =>
      bus.submit(
        { type: 'user' },
        {
          kind: 'message.append',
          idempotencyKey: 'k-a',
          payload: { ...line('你好'), audience: ['e_ghost'] },
        },
      ),
    ).toThrowError(/受众不是本分支实体/);
  });

  it('空消息被拒绝', () => {
    expect(() =>
      bus.submit(
        { type: 'user' },
        {
          kind: 'message.append',
          idempotencyKey: 'k-e',
          payload: { ...line(''), structured: {}, audience: [] },
        },
      ),
    ).toThrowError(/空消息/);
  });

  it('用户消息（无 beat）可以写入，seq 与 head 一致', () => {
    const result = bus.submit(
      { type: 'user', id: 'author' },
      {
        kind: 'message.append',
        idempotencyKey: 'k-u',
        payload: { ...line('以旁白身份补一句'), roleType: 'user', agentId: 'author', percept: 'public' },
      },
    );
    const row = db.prepare('SELECT seq, beat_id, role_type FROM message WHERE id = ?').get(
      (result.result as { messageId: string }).messageId,
    ) as { seq: number; beat_id: string | null; role_type: string };
    expect(row.seq).toBe(1);
    expect(row.beat_id).toBeNull();
    expect(row.role_type).toBe('user');
  });
});
