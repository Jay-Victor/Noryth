#!/usr/bin/env node
/**
 * P0 门禁 3–6 的机器判定。
 *
 * 门禁 1（schema 约束）、2（参数零漂移）分别由 `python scripts/check.py --schema|--params`
 * 与 `vitest` 覆盖；这个脚本只做"必须是真实 CLI + 真实 Git + 真实 SQLite"的那几条。
 *
 * 用法：node scripts/check-p0.mjs   （需要先 pnpm build）
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'noryth-p0-gate');
const INIT_DIR = path.join(CACHE, 'project');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'main.js');

const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));
const store = require(path.join(ROOT, 'packages', 'store', 'dist', 'index.js'));

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ ok: true, label, note: 'ok' });
  } catch (error) {
    results.push({ ok: false, label, note: error instanceof Error ? error.message : String(error) });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function runCli(args) {
  const out = execFileSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const trimmed = out.trim();
  const line = trimmed.split(/\r?\n/).filter(Boolean).pop() ?? '';
  return JSON.parse(line);
}
function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function closeQuietly(db) {
  try {
    if (db.open) db.close();
  } catch {
    /* 已关闭 */
  }
}

rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

// ── 门禁 3：init 建出 7 个文件/目录，二次执行不破坏 ──────────────────────
let firstInit = null;
let manifestHash = '';
let dbEventCount = 0;
check('门禁 3a · noryth init 建出 7 个文件/目录', () => {
  firstInit = runCli(['init', INIT_DIR, '--name', '门禁项目', '--json']);
  assert(firstInit.ok === true, 'init 返回 ok=false');
  assert(firstInit.data.created === true, '首次 init 未标记 created');
  assert(core.INIT_ENTRIES.length === 7, `INIT_ENTRIES 应为 7 项，实际 ${core.INIT_ENTRIES.length}`);
  const missing = core.INIT_ENTRIES.filter((entry) => !existsSync(path.join(INIT_DIR, entry)));
  assert(missing.length === 0, `缺少：${missing.join(', ')}`);
  // 04-ui.md §2 第 5 步点名的 4 个，必须在
  for (const entry of ['noryth.json', '.noryth', 'chapters', '.gitignore']) {
    assert(existsSync(path.join(INIT_DIR, entry)), `文档点名的骨架缺失：${entry}`);
  }
  assert(statSync(path.join(INIT_DIR, core.PROJECT_LAYOUT.database)).size > 0, '数据库是空文件');

  const db = store.openDatabase(path.join(INIT_DIR, core.PROJECT_LAYOUT.database), {
    readonly: true,
  });
  try {
    const version = Number(db.pragma('user_version', { simple: true }));
    assert(version === 1, `user_version=${version}，期望 1`);
    const tables = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get().c;
    assert(tables === 26, `表数为 ${tables}，期望 26`);
    const project = db.prepare('SELECT id, name FROM project').get();
    assert(project !== undefined, '数据库没有 project 行');
    assert(project.id === firstInit.data.projectId, '数据库 projectId 与 CLI 返回值不一致');
  } finally {
    closeQuietly(db);
  }
});

check('门禁 3b · 二次 init 不破坏（manifest / 事件 / Git 提交数不变）', () => {
  const manifestPath = path.join(INIT_DIR, core.PROJECT_LAYOUT.manifest);
  manifestHash = readFileSync(manifestPath, 'utf8');
  const db = store.openDatabase(path.join(INIT_DIR, core.PROJECT_LAYOUT.database));
  try {
    dbEventCount = db.prepare('SELECT count(*) AS c FROM event').get().c;
  } finally {
    closeQuietly(db);
  }
  const second = runCli(['init', INIT_DIR, '--json']);
  assert(second.ok === true, '第二次 init 失败');
  assert(second.data.created === false, '第二次 init 误判为新建');
  assert(second.data.projectId === firstInit.data.projectId, 'projectId 变了');
  assert(readFileSync(manifestPath, 'utf8') === manifestHash, 'noryth.json 被改写');
  const db2 = store.openDatabase(path.join(INIT_DIR, core.PROJECT_LAYOUT.database));
  try {
    assert(
      db2.prepare('SELECT count(*) AS c FROM event').get().c === dbEventCount,
      '事件数变化（重复初始化写入了新事件）',
    );
    assert(db2.prepare('SELECT count(*) AS c FROM project').get().c === 1, 'project 行数不为 1');
  } finally {
    closeQuietly(db2);
  }
  assert(git(INIT_DIR, ['rev-list', '--count', 'HEAD']) === '1', 'Git 提交数不为 1');
  assert(git(INIT_DIR, ['status', '--porcelain']) === '', '二次 init 后工作区不干净');
  const entries = readdirSync(INIT_DIR).sort();
  assert(
    JSON.stringify(entries) ===
      JSON.stringify(['.git', '.gitignore', '.noryth', 'chapters', 'noryth.json', 'skills']),
    `顶层目录树异常：${entries.join(', ')}`,
  );
});

// ── 门禁 4：同一命令重放两次只产生一条消息 ────────────────────────────────
const idemDbPath = path.join(CACHE, 'idempotency.db');
check('门禁 4 · 同一命令重放两次只产生一条消息', () => {
  const db = store.openDatabase(idemDbPath);
  try {
    store.migrate(db);
    store.createProject(db, { name: '幂等门禁', rootPath: CACHE });
    const branch = store.getActiveBranch(db);
    db.prepare(
      "INSERT INTO entity(id, branch_id, kind, name) VALUES ('e_lin', ?, 'character', '林砚'), ('e_shen', ?, 'character', '沈昼')",
    ).run(branch.id, branch.id);
    db.prepare(
      "INSERT INTO scene(id, branch_id, idx, title, story_start, present, goal, state, exit_conditions) VALUES ('s1', ?, 0, '雨夜', '第三天夜', '[\"e_lin\",\"e_shen\"]', '{}', 'open', '{}')",
    ).run(branch.id);

    const bus = new store.CommandBus(db);
    const command = {
      kind: 'message.append',
      idempotencyKey: 'gate-4',
      payload: {
        sceneId: 's1',
        agentId: 'e_lin',
        roleType: 'character',
        prose: '你迟到了。',
        structured: { line: '你迟到了。' },
        audience: ['e_shen'],
        percept: 'public',
      },
    };
    const first = bus.submit({ type: 'user', id: 'author' }, command);
    const second = bus.submit({ type: 'user', id: 'author' }, command);
    assert(first.replayed === false, '首次提交被当成重放');
    assert(second.replayed === true, '第二次提交没有命中收据');
    assert(first.seq === second.seq, '两次返回的 seq 不同');

    const messages = db.prepare('SELECT count(*) AS c FROM message').get().c;
    assert(messages === 1, `message 行数为 ${messages}，期望 1`);
    const receipts = db.prepare('SELECT count(*) AS c FROM receipt').get().c;
    assert(receipts === 1, `receipt 行数为 ${receipts}，期望 1`);
    const appended = db
      .prepare("SELECT count(*) AS c FROM event WHERE kind = 'message.appended'")
      .get().c;
    assert(appended === 1, `message.appended 事件数为 ${appended}，期望 1`);
  } finally {
    closeQuietly(db);
  }
});

// ── 门禁 5：事件日志 UPDATE/DELETE 被拒 ───────────────────────────────────
check('门禁 5 · 事件日志 UPDATE/DELETE 被 ck_event_immutable 拒绝', () => {
  const db = store.openDatabase(idemDbPath);
  try {
    let updateError = null;
    try {
      db.prepare("UPDATE event SET kind = 'tampered'").run();
    } catch (error) {
      updateError = error;
    }
    assert(updateError !== null, 'UPDATE event 未被拒绝');
    assert(store.isSqliteConstraint(updateError), `不是完整性错误：${updateError?.code ?? '?'}`);
    assert(
      store.constraintNameOf(updateError) === 'ck_event_immutable',
      `约束名错误：${store.constraintNameOf(updateError)}`,
    );
    assert(updateError.message.includes('ck_event_immutable'), '错误信息不含约束名');

    let deleteError = null;
    try {
      db.prepare('DELETE FROM event').run();
    } catch (error) {
      deleteError = error;
    }
    assert(deleteError !== null, 'DELETE event 未被拒绝');
    assert(store.isSqliteConstraint(deleteError), 'DELETE 抛出的不是完整性错误');
    assert(
      store.constraintNameOf(deleteError) === 'ck_event_immutable',
      'DELETE 未被 ck_event_immutable 拒绝',
    );
  } finally {
    closeQuietly(db);
  }
});

// ── 门禁 6：提交后 git log 有 1 条，含 Noryth-Checkpoint ──────────────────
check('门禁 6 · git log 有 1 条提交且含 Noryth-Checkpoint', () => {
  const count = git(INIT_DIR, ['rev-list', '--count', 'HEAD']);
  assert(count === '1', `提交数为 ${count}，期望 1`);
  const body = git(INIT_DIR, ['log', '--format=%B']);
  assert(body.includes('Noryth-Checkpoint:'), '提交信息缺少 Noryth-Checkpoint');
  const match = /Noryth-Checkpoint:\s*(\S+)/.exec(body);
  assert(match !== null, '无法解析检查点 ID');
  const checkpointId = match[1];
  const db = store.openDatabase(path.join(INIT_DIR, core.PROJECT_LAYOUT.database), {
    readonly: true,
  });
  try {
    const row = db.prepare('SELECT id, trigger, seq FROM checkpoint WHERE id = ?').get(checkpointId);
    assert(row !== undefined, `提交里的检查点 ${checkpointId} 不在数据库中`);
    assert(row.trigger === 'git_commit', `检查点 trigger=${row.trigger}，期望 git_commit`);
  } finally {
    closeQuietly(db);
  }
});

// ── 报告 ─────────────────────────────────────────────────────────────────
console.log('═'.repeat(78));
console.log('Noryth P0 门禁 3–6');
console.log('═'.repeat(78));
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.label}${r.ok ? '' : `\n        ${r.note}`}`);
}
const passed = results.filter((r) => r.ok).length;
console.log('─'.repeat(78));
console.log(`  ${passed}/${results.length} 通过 · 产物：${CACHE}`);
process.exit(passed === results.length ? 0 : 1);
