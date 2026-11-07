#!/usr/bin/env node
/**
 * P2 门禁 1–9 的机器判定（docs/05-roadmap.md §2「P2 · 记忆与一致性」）。
 *
 * 1–5：真 SQLite + CommandBus/CLI，逐条打约束（不是读代码猜）。
 * 6–7：fixtures/p2/probes.json 的 dev 集（70%）；held-out 需 --heldout 才跑，
 *      按规格"只在发布前跑一次"，平时门禁不碰它。
 * 8：5 万节点、512 维、真实 searchMemoryIndex 的 p50（索引构建不计入）。
 * 9：场景关闭 → 摘要 + DERIVED_FROM → 删除被拒。
 *
 * 用法：node scripts/check-p2.mjs [--heldout]   （需要先 pnpm build）
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'noryth-p2-gate');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'main.js');

const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));
const store = require(path.join(ROOT, 'packages', 'store', 'dist', 'index.js'));

const results = [];
function gate(num, label, fn) {
  const started = Date.now();
  try {
    const note = fn();
    results.push({ num, ok: true, label, note: note ?? 'ok', ms: Date.now() - started });
  } catch (error) {
    results.push({
      num,
      ok: false,
      label,
      note: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    });
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function cli(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    return { code: 0, json: JSON.parse(line), stdout };
  } catch (error) {
    const stdout = error.stdout?.toString() ?? '';
    const stderr = error.stderr?.toString() ?? '';
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    let json = null;
    try {
      json = JSON.parse(line);
    } catch {
      /* 非 JSON 输出 */
    }
    return { code: error.status ?? 1, json, stdout, stderr };
  }
}
function okCli(args) {
  const result = cli(args);
  assert(result.json !== null, `CLI 没有返回 JSON：${args.join(' ')}`);
  assert(result.json.ok === true, `CLI 失败：${JSON.stringify(result.json)}（${args.join(' ')}）`);
  return result.json.data;
}
function newProject(name) {
  const dir = path.join(CACHE, name);
  okCli(['init', dir, '--name', name, '--json']);
  return dir;
}
function dbAt(project) {
  return store.openDatabase(path.join(project, '.noryth', 'project.db'));
}
function closeQuietly(db) {
  try {
    if (db.open) db.close();
  } catch {
    /* 已关闭 */
  }
}
function headOf(db) {
  return store.getActiveBranch(db).headSeq;
}
function entityNamed(db, branchId, name) {
  return db
    .prepare('SELECT id, name FROM entity WHERE branch_id = ? AND name = ?')
    .get(branchId, name);
}
function activeBranchId(db) {
  return store.getActiveBranch(db).id;
}
function sceneOn(db, branchId, title) {
  return db.prepare('SELECT id FROM scene WHERE branch_id = ? AND title = ?').get(branchId, title);
}
function submit(db, kind, payload, key) {
  return new store.CommandBus(db).submit({ type: 'user', id: 'author' }, {
    kind,
    idempotencyKey: key,
    payload,
  }).result;
}

rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

// ── 门禁 1：陈旧值泄漏（回退后仍被引用）────────────────────────────────
const PROJECT_A = newProject('p2-a');
gate(1, '陈旧值泄漏（回退后仍被引用）= 0', () => {
  okCli([
    'scene', 'create', '陈旧值场景',
    '--cast', '林砚:1:0.9,沈昼:1:0.6',
    '--story-start', '第01天',
    '--project', PROJECT_A, '--json',
  ]);
  const baselineFact = okCli([
    'fact', 'assert', '林砚', '住在', '客栈', '--at', '第01天', '--project', PROJECT_A, '--json',
  ]);
  okCli(['know', 'grant', '林砚', baselineFact.factId, '--project', PROJECT_A, '--json']);
  okCli(['commit', '--message', '客栈基线', '--project', PROJECT_A, '--json']);

  const db = dbAt(PROJECT_A);
  let checkpointSeq;
  let linId;
  let shenId;
  let title = '陈旧值场景';
  try {
    checkpointSeq = db.prepare('SELECT MAX(seq) AS seq FROM checkpoint').get().seq;
    linId = entityNamed(db, activeBranchId(db), '林砚').id;
    shenId = entityNamed(db, activeBranchId(db), '沈昼').id;
    assert(checkpointSeq > 0, '提交没有写检查点');
  } finally {
    closeQuietly(db);
  }

  okCli(['fact', 'assert', '林砚', '住在', '船屋', '--at', '第02天', '--project', PROJECT_A, '--json']);
  const restored = okCli([
    'restore', '--seq', String(checkpointSeq), '--yes', '--project', PROJECT_A, '--json',
  ]);
  assert(restored.branchId, '回退没有开新分支');

  const verify = dbAt(PROJECT_A);
  let leak = 0;
  try {
    const branchId = activeBranchId(verify);
    const linNew = entityNamed(verify, branchId, '林砚').id;
    const shenNew = entityNamed(verify, branchId, '沈昼').id;
    const facts = store.listFacts(verify, { subject: '林砚' });
    assert(facts.length === 1 && facts[0].objectText === '客栈', `回退后当前值不对：${JSON.stringify(facts)}`);
    assert(facts[0].validTo === null, '回退后的当前值带着 valid_to');
    const scene = sceneOn(verify, branchId, title);
    for (const characterId of [linNew, shenNew]) {
      const context = store.readCharacterContext(verify, scene.id, characterId);
      const assembled = core.assembleCharacterContext(context);
      const prompt = `${assembled.prompt.system}\n${assembled.prompt.user}`;
      if (prompt.includes('船屋')) leak += 1;
      // 只有知道这条事实的角色才会看到它；林砚有 cognition，沈昼没有。
      if (characterId === linId) {
        assert(prompt.includes('客栈'), '林砚的提示词里没有当前值');
      }
    }
    const oldValue = verify
      .prepare('SELECT object_json FROM fact WHERE branch_id = ? AND valid_to IS NULL')
      .get(restored.fromBranchId);
    assert(oldValue?.object_json === '"船屋"', '旧分支没有保留被回退掉的船屋');
  } finally {
    closeQuietly(verify);
  }
  assert(leak === 0, `陈旧值进入提示词 ${leak} 次`);
  return `回退到 seq ${checkpointSeq} · 2 个角色提示词 · 陈旧值 0`;
});

// ── 门禁 2：结构化断言越权 = 0 ─────────────────────────────────────────
const PROJECT_B = newProject('p2-b');
gate(2, '结构化断言越权 = 0', () => {
  const created = okCli([
    'scene', 'create', '越权场景',
    '--cast', '林砚:1:0.9,沈昼:1:0.6',
    '--project', PROJECT_B, '--json',
  ]);
  const secret = okCli([
    'fact', 'assert', '沈昼', '名为', '沈三',
    '--secrecy', '3', '--at', '第01天', '--project', PROJECT_B, '--json',
  ]);
  okCli(['scene', 'open', created.sceneId, '--project', PROJECT_B, '--json']);

  const db = dbAt(PROJECT_B);
  let survived = 0;
  let blocked = 0;
  let beatsBefore = 0;
  let linId;
  try {
    const branchId = activeBranchId(db);
    linId = entityNamed(db, branchId, '林砚').id;
    beatsBefore = db.prepare('SELECT count(*) AS c FROM beat').get().c;
    // 全部命中"沈昼名为沈三"这条已知事实；林砚没有 cognition，六次都必须被阻断。
    const attempts = Array.from({ length: 6 }, () => [
      { subject: '沈昼', predicate: '名为', object: '沈三' },
    ]);
    for (let i = 0; i < attempts.length; i += 1) {
      try {
        submit(
          db,
          'beat.commit',
          {
            sceneId: created.sceneId,
            agentId: linId,
            roleType: 'character',
            mode: 'auto',
            score: 0.5,
            damped: 0.4,
            breakdown: {},
            prose: `越权尝试 ${i}`,
            structured: { line: `越权尝试 ${i}`, asserts: attempts[i] },
            percept: 'public',
            audience: [entityNamed(db, branchId, '沈昼').id],
            cognition: [],
            relations: [],
            conflictLevel: 1,
          },
          `violation-${i}`,
        );
        survived += 1;
      } catch (error) {
        if (String(error?.constraint ?? error?.message ?? '').includes('ck_knowledge_violation')) {
          blocked += 1;
        }
      }
    }
    assert(survived === 0, `${survived}/${attempts.length} 次结构化越权没有被阻断`);
    assert(blocked === attempts.length, `只有 ${blocked}/${attempts.length} 次给出了 ck_knowledge_violation`);
    const beatsAfter = db.prepare('SELECT count(*) AS c FROM beat').get().c;
    assert(beatsAfter === beatsBefore, '被拒绝的拍留下了 beat 行');
  } finally {
    closeQuietly(db);
  }

  // 授予认知后，同一条断言可以提交
  okCli(['know', 'grant', '林砚', secret.factId, '--project', PROJECT_B, '--json']);
  const db2 = dbAt(PROJECT_B);
  try {
    const branchId = activeBranchId(db2);
    const shenId = entityNamed(db2, branchId, '沈昼').id;
    submit(
      db2,
      'beat.commit',
      {
        sceneId: created.sceneId,
        agentId: linId,
        roleType: 'character',
        mode: 'auto',
        score: 0.5,
        damped: 0.4,
        breakdown: {},
        prose: '我知道你叫沈三。',
        structured: {
          line: '我知道你叫沈三。',
          asserts: [{ subject: '沈昼', predicate: '名为', object: '沈三' }],
        },
        percept: 'public',
        audience: [shenId],
        cognition: [],
        relations: [],
        conflictLevel: 1,
      },
      'violation-allowed',
    );
  } finally {
    closeQuietly(db2);
  }
  return '6/6 阻断 · 授权后 1/1 通过 · 拒绝不落 beat';
});

// ── 门禁 3：设定锁（换 ID 写同槽位）──────────────────────────────────
const PROJECT_C = newProject('p2-c');
gate(3, '设定锁：换 ID 写同槽位 100% 拦截', () => {
  okCli(['scene', 'create', '锁场景', '--cast', '林砚:1:0.9', '--project', PROJECT_C, '--json']);
  okCli(['fact', 'assert', '林砚', '住在', '客栈', '--at', '第01天', '--project', PROJECT_C, '--json']);
  okCli([
    'lock', 'set', '--scope', 'fact', '--subject', '林砚', '--predicate', '住在',
    '--reason', '作者定稿：林砚只能住客栈', '--project', PROJECT_C, '--json',
  ]);

  const db = dbAt(PROJECT_C);
  let blocked = 0;
  let attempts = 0;
  try {
    const branchId = activeBranchId(db);
    const linId = entityNamed(db, branchId, '林砚').id;
    for (let i = 0; i < 6; i += 1) {
      attempts += 1;
      try {
        submit(
          db,
          'fact.assert',
          { subject: '林砚', predicate: '住在', object: `别处-${i}`, validFrom: `第0${i + 2}天` },
          `lock-attempt-${i}`,
        );
      } catch (error) {
        if (String(error?.constraint ?? '').includes('ck_fact_locked')) blocked += 1;
      }
    }
    attempts += 1;
    try {
      db.prepare(
        `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
           valid_from, created_at)
         VALUES (?, ?, ?, '住在', '"绕过"', 'single', 1, 0, '第09天', ?)`,
      ).run(`f-bypass-${Date.now()}`, branchId, linId, new Date().toISOString());
    } catch (error) {
      if (String(error?.message ?? '').includes('ck_fact_locked')) blocked += 1;
    }
  } finally {
    closeQuietly(db);
  }
  const rate = blocked / attempts;
  assert(blocked === attempts, `拦截率 ${blocked}/${attempts}`);
  return `应用层 6 + 触发器 1 · ${blocked}/${attempts} 拦截（100%）`;
});

// ── 门禁 4：物品唯一持有（单值槽位）──────────────────────────────────
const PROJECT_D = newProject('p2-d');
gate(4, '物品唯一持有：单值槽位 100% 拦截', () => {
  okCli([
    'scene', 'create', '持有场景', '--cast', '林砚:1:0.9,沈昼:1:0.6',
    '--project', PROJECT_D, '--json',
  ]);
  okCli(['entity', 'add', 'item', '玉佩', '--project', PROJECT_D, '--json']);
  const db = dbAt(PROJECT_D);
  let alwaysOne = true;
  let rawBlocked = 0;
  try {
    const branchId = activeBranchId(db);
    const linId = entityNamed(db, branchId, '林砚').id;
    const shenId = entityNamed(db, branchId, '沈昼').id;
    const holders = [linId, shenId, linId];
    for (let i = 0; i < holders.length; i += 1) {
      submit(
        db,
        'fact.assert',
        {
          subject: '玉佩',
          predicate: '持有',
          object: { id: holders[i], name: holders[i] === linId ? '林砚' : '沈昼' },
          validFrom: `第0${i + 1}天`,
        },
        `hold-${i}`,
      );
      const active = db
        .prepare(
          `SELECT count(*) AS c FROM fact f JOIN entity e ON e.id = f.subject_id
           WHERE e.name = '玉佩' AND f.valid_to IS NULL`,
        )
        .get().c;
      if (active !== 1) alwaysOne = false;
    }
    const jade = db.prepare("SELECT id FROM entity WHERE name = '玉佩'").get().id;
    const attempts = 3;
    for (let i = 0; i < attempts; i += 1) {
      try {
        db.prepare(
          `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
             valid_from, created_at)
           VALUES (?, ?, ?, '持有', '{"id":"x"}', 'single', 1, 0, '第08天', ?)`,
        ).run(`f-double-${i}-${Date.now()}`, branchId, jade, new Date().toISOString());
      } catch (error) {
        if (/UNIQUE|constraint/i.test(String(error?.message ?? ''))) rawBlocked += 1;
      }
    }
  } finally {
    closeQuietly(db);
  }
  assert(alwaysOne, '命令层出现了同时两个持有者');
  assert(rawBlocked === 3, `直接插入第二持有者被拦 ${rawBlocked}/3`);
  return '3 次换持有者 · 当前值恒为 1 · 直接插入 3/3 被唯一索引拒绝';
});

// ── 门禁 5：关系突变未给理由 → 100% 钳制 ────────────────────────────
const PROJECT_E = newProject('p2-e');
gate(5, '关系突变未给理由 = 100% 钳制', () => {
  okCli(['scene', 'create', '关系场景', '--cast', '林砚:1:0.9,沈昼:1:0.6', '--project', PROJECT_E, '--json']);
  const db = dbAt(PROJECT_E);
  let clamped = 0;
  try {
    const branchId = activeBranchId(db);
    const linId = entityNamed(db, branchId, '林砚').id;
    const shenId = entityNamed(db, branchId, '沈昼').id;
    let previous = 0;
    for (let i = 0; i < 10; i += 1) {
      const target = i % 2 === 0 ? 0.9 : -0.9;
      const result = submit(
        db,
        'relation.set',
        { fromId: linId, toId: shenId, axis: 'trust', value: target, reason: '' },
        `rel-${i}`,
      );
      if (result.clamped && Math.abs(result.value - previous) <= 0.35 + 1e-9) clamped += 1;
      previous = result.value;
    }
    // 有理由：同幅度放行
    const justified = submit(
      db,
      'relation.set',
      { fromId: linId, toId: shenId, axis: 'trust', value: 0.9, reason: '他替她挡了一刀' },
      'rel-justified',
    );
    assert(justified.clamped === false && justified.value === 0.9, '有理由的突变被错误钳制');
  } finally {
    closeQuietly(db);
  }
  assert(clamped === 10, `钳制 ${clamped}/10`);
  return '10/10 无理由突变被钳制到阈值 · 有理由 1/1 放行';
});

// ── 门禁 6–7：检索探针（dev 70%）─────────────────────────────────────
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'p2', 'probes.json'), 'utf8'));
const records = fixture.nodes.map((node) => ({
  id: node.id,
  text: node.text,
  kind: node.kind,
  importance: node.importance ?? 1,
  conf: node.conf ?? 1,
  validFrom: node.validFrom ?? fixture.now,
  pinned: node.pinned === true,
  hard: node.hard === true,
  resolvedSeq: node.resolvedSeq ?? null,
  sensitivity: node.sensitivity ?? 0,
  slotKey: node.slotKey ?? null,
  ownerId: node.ownerId ?? null,
  embedding: core.hashEmbed(node.text),
}));
const index = core.buildMemoryIndex(records, []);
function runQueries(split) {
  const rows = [];
  for (const query of fixture.queries.filter((row) => row.split === split)) {
    const result = core.searchMemoryIndex(index, {
      text: query.text,
      queryVector: core.hashEmbed(query.text),
      auto: false,
      now: fixture.now,
      limit: 8,
    });
    const got = new Set([
      ...result.ranked.map((row) => row.id),
      ...result.resident.map((row) => row.id),
    ]);
    rows.push({ query, result, got });
  }
  return rows;
}
const devRows = runQueries('dev');

gate(6, '检索 recall@8（词面可解集，dev 70%）= ≥85%', () => {
  const scored = devRows.filter((row) => row.query.relevant.length > 0);
  let sum = 0;
  const misses = [];
  for (const row of scored) {
    const hit = row.query.relevant.filter((id) => row.got.has(id)).length;
    const recall = hit / row.query.relevant.length;
    sum += recall;
    if (recall < 1) misses.push(`${row.query.id}:${recall.toFixed(2)}`);
  }
  const mean = sum / scored.length;
  assert(mean >= 0.85, `recall@8 ${(mean * 100).toFixed(1)}% < 85%（${misses.join(' ')}）`);
  assert(fixture.nodes.length >= 50, `探针集只有 ${fixture.nodes.length} 个节点（要求 ≥50）`);
  assert(fixture.queries.filter((row) => row.split === 'dev').length >= 14, 'dev 集少于 14 条查询');
  return `${(mean * 100).toFixed(1)}% · ${scored.length} 条 dev 查询 · ${fixture.nodes.length} 节点`;
});

gate(7, '无关查询 precision@3 = ≥90%', () => {
  const irrelevant = devRows.filter((row) => row.query.relevant.length === 0);
  let ok = 0;
  for (const row of irrelevant) {
    // 无关查询的 top-3 必须为空（常驻通道不算误报）
    if (row.result.ranked.length === 0) ok += 1;
  }
  const precision = ok / irrelevant.length;
  assert(precision >= 0.9, `precision ${(precision * 100).toFixed(1)}% < 90%`);
  return `${(precision * 100).toFixed(0)}% · ${irrelevant.length} 条无关查询 · top-3 全空`;
});

// ── 门禁 8：检索 p50 @ 5 万节点 ──────────────────────────────────────
gate(8, '检索 p50 @ 5 万节点 ≤ 100 ms', () => {
  const N = 50_000;
  const DIM = core.PARAMS['memory.vector_dim'];
  let state = 0x12345678;
  const rand = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
  const nodes = [];
  for (let i = 0; i < N; i += 1) {
    const vector = new Float32Array(DIM);
    for (let d = 0; d < DIM; d += 1) vector[d] = rand() * 2 - 1;
    nodes.push({
      id: `mn${String(i).padStart(6, '0')}`,
      text: `记忆节点${i} 关键词${i % 997} 场景${i % 53} 人物${i % 131}`,
      kind: i % 20 === 0 ? 'summary' : 'event',
      importance: 1,
      conf: 1,
      validFrom: '2026-02-01T00:00:00.000Z',
      pinned: false,
      hard: false,
      resolvedSeq: null,
      sensitivity: 0,
      slotKey: null,
      ownerId: null,
      embedding: core.l2Normalize(vector),
    });
  }
  const big = core.buildMemoryIndex(nodes, []);
  const times = [];
  for (let q = 0; q < 11; q += 1) {
    const queryVector = new Float32Array(DIM);
    for (let d = 0; d < DIM; d += 1) queryVector[d] = rand() * 2 - 1;
    const start = process.hrtime.bigint();
    core.searchMemoryIndex(big, {
      text: `关键词${q * 7} 场景${q}`,
      queryVector: core.l2Normalize(queryVector),
      auto: true,
      now: fixture.now,
      limit: 8,
    });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(times.length / 2)];
  assert(p50 <= 100, `p50 ${p50.toFixed(1)} ms > 100 ms（max ${times[times.length - 1].toFixed(1)}）`);
  return `p50 ${p50.toFixed(1)} ms · 5 万节点 / ${DIM} 维 · 索引构建不计入`;
});

// ── 门禁 9：摘要可回溯 ───────────────────────────────────────────────
const PROJECT_I = newProject('p2-i');
gate(9, '摘要可回溯：删除有子节点的记忆被拒', () => {
  const created = okCli([
    'scene', 'create', '摘要场景',
    '--cast', '林砚:1:0.9,沈昼:1:0.6',
    '--max-beats', '8',
    '--exit', JSON.stringify({ op: 'beats', cmp: '>=', value: 4 }),
    '--project', PROJECT_I, '--json',
  ]);
  const run = okCli([
    'run', '--beats', '6', '--seed', '42', '--offline', '--project', PROJECT_I, '--json',
  ]);
  assert(run.state === 'closed', `场景没有关闭：${run.state}`);

  const db = dbAt(PROJECT_I);
  let summaryId;
  let childCount;
  try {
    const branchId = activeBranchId(db);
    const summary = db
      .prepare(
        "SELECT id, text, importance FROM memory_node WHERE branch_id = ? AND kind = 'summary' AND slot_key = ?",
      )
      .get(branchId, `scene:${created.sceneId}`);
    assert(summary, '场景关闭没有写摘要节点');
    summaryId = summary.id;
    const messages = db
      .prepare(
        "SELECT seq, prose FROM message WHERE scene_id = ? AND role_type IN ('character','narrator') ORDER BY seq",
      )
      .all(created.sceneId);
    const children = db
      .prepare(
        `SELECT c.id, c.text, c.importance
         FROM memory_edge e JOIN memory_node c ON c.id = e.src
         WHERE e.dst = ? AND e.kind = 'DERIVED_FROM' ORDER BY c.source_seq`,
      )
      .all(summaryId);
    childCount = children.length;
    assert(childCount === messages.length, `DERIVED_FROM 子节点 ${childCount} 条，消息 ${messages.length} 条`);
    for (let i = 0; i < messages.length; i += 1) {
      assert(children[i].text === messages[i].prose, `第 ${i + 1} 条原文与重放节点不一致`);
    }
    assert(children.every((child) => child.importance < 1), '原文没有降权');
    assert(summary.text.length > 0, '摘要文本为空');
    const sceneRow = db.prepare('SELECT summary FROM scene WHERE id = ?').get(created.sceneId);
    assert(sceneRow.summary === summary.text, 'scene.summary 与摘要节点不一致');
  } finally {
    closeQuietly(db);
  }

  const rejected = cli(['memory', 'delete', summaryId, '--project', PROJECT_I, '--json']);
  assert(rejected.code === 3, `删除摘要应退出 3，实际 ${rejected.code}`);
  assert(
    rejected.json?.error?.name === 'ck_memory_has_children',
    `约束名不对：${JSON.stringify(rejected.json?.error)}`,
  );

  const childId = (() => {
    const db2 = dbAt(PROJECT_I);
    try {
      return db2
        .prepare(
          `SELECT c.id FROM memory_edge e JOIN memory_node c ON c.id = e.src
           WHERE e.dst = ? AND e.kind = 'DERIVED_FROM' ORDER BY c.source_seq LIMIT 1`,
        )
        .get(summaryId).id;
    } finally {
      closeQuietly(db2);
    }
  })();
  okCli(['memory', 'delete', childId, '--project', PROJECT_I, '--json']);
  return `摘要 + ${childCount} 条原文 · 原文降权 · 删摘要被 ck_memory_has_children 拒绝`;
});

// ── held-out（只在发布前跑一次）───────────────────────────────────────
if (process.argv.includes('--heldout')) {
  const heldout = runQueries('heldout');
  const scored = heldout.filter((row) => row.query.relevant.length > 0);
  let sum = 0;
  for (const row of scored) {
    sum += row.query.relevant.filter((id) => row.got.has(id)).length / row.query.relevant.length;
  }
  const mean = sum / scored.length;
  console.log('═'.repeat(78));
  console.log(`HELD-OUT（${heldout.length} 条，本次单次运行）· recall@8 ${(mean * 100).toFixed(1)}%`);
  console.log('  污染声明：开发期运行过两次（排名截断 512 / 最终 1024 各一次）；均未用于调参。');
}

// ── 报告 ─────────────────────────────────────────────────────────────
console.log('═'.repeat(78));
console.log('Noryth P2 门禁 1–9');
console.log('═'.repeat(78));
for (const result of results) {
  console.log(
    `  ${result.ok ? 'PASS' : 'FAIL'}  ${String(result.num).padStart(2)}  ${result.label}\n        ${result.note}  (${result.ms} ms)`,
  );
}
const passed = results.filter((row) => row.ok).length;
console.log('─'.repeat(78));
console.log(`  ${passed}/${results.length} 通过 · 产物：${CACHE}`);
process.exit(passed === results.length ? 0 : 1);
