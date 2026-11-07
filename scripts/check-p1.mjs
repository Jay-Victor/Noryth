#!/usr/bin/env node
/**
 * P1 门禁 1–14 的机器判定。
 *
 * 1–4：解析 design/probe/noryth_proto.py --demo 的实测行（500 拍仿真）。
 * 5–6：真 SQLite + 真装配函数，12 场景 × 6 角色 = 72 次装配。
 * 7–14：真 CLI（init / scene create / run / commit / restore）+ 真数据库断言。
 * 13 是 restore --from-commit 的端到端：场景关闭提交 → 删库 → 从提交恢复 8 域。
 * 14 是手动提交：未关闭场景 → commit → 删库 → 恢复后继续跑。
 *
 * 用法：node scripts/check-p1.mjs   （需要先 pnpm build）
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'noryth-p1-gate');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'main.js');

const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));
const store = require(path.join(ROOT, 'packages', 'store', 'dist', 'index.js'));

const results = [];
function gate(num, label, fn) {
  try {
    const note = fn();
    results.push({ num, ok: true, label, note: note ?? 'ok' });
  } catch (error) {
    results.push({
      num,
      ok: false,
      label,
      note: error instanceof Error ? error.message : String(error),
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
  assert(result.json.ok === true, `CLI 失败：${JSON.stringify(result.json)}`);
  return result.json.data;
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
function newProject(name) {
  const dir = path.join(CACHE, name);
  okCli(['init', dir, '--name', name, '--json']);
  return dir;
}
function cast(weights) {
  return weights.map(([name, goal, initiative]) => `${name}:${goal}:${initiative}`).join(',');
}
function namesOf(log) {
  return log.map((beat) => beat.speaker);
}
function sha(text) {
  return core.sha256Hex(text);
}

rmSync(CACHE, { recursive: true, force: true });
mkdirSync(CACHE, { recursive: true });

// ── 门禁 1–4：探针 500 拍仿真 ─────────────────────────────────────────────
const probeStats = (() => {
  const demo = execFileSync('python', ['-B', 'design/probe/noryth_proto.py', '--demo'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const row = demo.split(/\r?\n/).find((line) => line.startsWith('阻尼+硬上限'));
  assert(row, 'demo 输出里找不到「阻尼+硬上限」行');
  const nums = row.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  assert(nums.length >= 8, `无法解析 demo 行：${row}`);
  return {
    streakLow: nums[0],
    streakHigh: nums[1],
    narrLow: nums[2],
    narrHigh: nums[3],
    shareLow: nums[4],
    shareHigh: nums[5],
    arbLow: nums[6],
    arbHigh: nums[7],
  };
})();

gate(1, '探针 500 拍 · 最长连任 ≤ 3', () => {
  assert(probeStats.streakHigh <= 3, `最长连任 ${probeStats.streakHigh} > 3`);
  return `连任 ${probeStats.streakLow}–${probeStats.streakHigh}`;
});

gate(2, '单人最高占比 ≤ 40%', () => {
  assert(probeStats.shareHigh <= 40, `单人最高占比 ${probeStats.shareHigh}% > 40%`);
  return `${probeStats.shareLow}–${probeStats.shareHigh}%`;
});

gate(3, '旁白占比 15%–25%', () => {
  assert(
    probeStats.narrLow >= 15 && probeStats.narrHigh <= 25,
    `旁白占比 ${probeStats.narrLow}–${probeStats.narrHigh}% 越界（15–25%）`,
  );
  return `${probeStats.narrLow}–${probeStats.narrHigh}%`;
});

gate(4, '仲裁触发率 ≤ 18%', () => {
  assert(probeStats.arbHigh <= 18, `仲裁触发率 ${probeStats.arbHigh}% > 18%`);
  return `${probeStats.arbLow}–${probeStats.arbHigh}%`;
});

// ── 门禁 5–6：72 次真实装配 ───────────────────────────────────────────────
const ASSEMBLE_DB = path.join(CACHE, 'assemble.db');
const CHARS = [
  ['e_lin', '林砚'],
  ['e_shen', '沈昼'],
  ['e_qi', '祁昭'],
  ['e_lu', '陆微'],
  ['e_wen', '温故'],
  ['e_zhou', '周决'],
];
const facts = [];
const cognition = [];
gate(5, '装配上下文 ≤ 预算（72 次），不截断半句', () => {
  const db = store.openDatabase(ASSEMBLE_DB);
  try {
    store.migrate(db);
    store.createProject(db, { name: '装配门禁', rootPath: CACHE });
    const branch = store.getActiveBranch(db);
    const now = new Date().toISOString();
    const insertEntity = db.prepare(
      "INSERT INTO entity(id, branch_id, kind, name) VALUES (?, ?, 'character', ?)",
    );
    for (const [id, name] of CHARS) insertEntity.run(id, branch.id, name);
    const insertFact = db.prepare(
      `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
         valid_from, source_seq, created_at)
       VALUES (?, ?, ?, '知道', ?, 'multi', 1, ?, '第01天', ?, ?)`,
    );
    const insertCog = db.prepare(
      `INSERT INTO cognition(branch_id, character_id, fact_id, attitude, certainty, learned_seq,
         source_message_id, percept)
       VALUES (?, ?, ?, 'knows', 1, ?, NULL, 'witness')`,
    );
    for (let i = 0; i < 204; i += 1) {
      const [charId, charName] = CHARS[i % CHARS.length];
      const factId = `f${i}`;
      const object = JSON.stringify({ id: `o${i}` });
      insertFact.run(factId, branch.id, charId, object, i % 5 === 0 ? 3 : 1, i, now);
      insertCog.run(branch.id, charId, factId, i);
      facts.push({
        id: factId,
        subjectId: charId,
        subjectName: charName,
        predicate: '知道',
        objectText: `物件-${i}`,
        truth: 1,
        secrecy: i % 5 === 0 ? 3 : 1,
        source: `事件 ${i + 1}`,
        marker: `MARK-${i}-7f3a`,
        observable: i % 5 !== 0,
      });
      cognition.push({
        characterId: charId,
        factId,
        attitude: 'knows',
        certainty: 1,
        percept: 'witness',
      });
    }
  } finally {
    closeQuietly(db);
  }

  let maxTokens = 0;
  let leaked = 0;
  for (let sceneIndex = 0; sceneIndex < 12; sceneIndex += 1) {
    const recent = Array.from({ length: 12 }, (_, i) => ({
      seq: sceneIndex * 12 + i + 1,
      speaker: CHARS[i % 3][1],
      roleType: 'character',
      prose: `第${sceneIndex}场第${i + 1}拍的第一句。第二句跟着落下。`,
    }));
    for (let c = 0; c < CHARS.length; c += 1) {
      const [characterId, name] = CHARS[c];
      const result = core.assembleCharacterContext({
        characterId,
        agent: {
          name,
          identity: `${name}的身份`,
          personality: '克制。',
          speechStyle: '短句。',
          values: '活下去。',
          want: '拿回账本。',
        },
        scene: {
          title: '雨夜·账本',
          location: '客栈',
          storyStart: '第01天',
          timeline: 'main',
          presentNames: CHARS.map(([, n]) => n),
          goal: '夺回账本',
          conflictLevel: 2.1,
          situation: '灯快尽了。',
        },
        recent,
        facts,
        cognition,
        relations: [{ toName: '沈昼', axis: 'trust', value: -0.4 }],
        clues: [{ id: 'c1', text: '账本第七页被撕掉了。' }],
      });
      maxTokens = Math.max(maxTokens, result.tokens);
      assert(result.tokens <= result.budget, `装配 ${result.tokens} > 预算 ${result.budget}`);
      const audit = core.countLeakedFacts(result.prompt, facts, cognition, characterId);
      leaked += audit.count;
      for (const entry of result.packed.kept) {
        assert(entry.item.full.length > 0, '出现空条目');
      }
    }
  }
  assert(leaked === 0, `累计越权 ${leaked} 条`);
  return `72 次装配 · 单次最高 ${maxTokens} tok · 越权 0`;
});

gate(6, '越权事实进入提示词 = 0（72 次累计）', () => {
  let leaked = 0;
  for (let sceneIndex = 0; sceneIndex < 12; sceneIndex += 1) {
    for (const [characterId] of CHARS) {
      const result = core.assembleCharacterContext({
        characterId,
        agent: {
          name: '测试',
          identity: '身份',
          personality: '性格',
          speechStyle: '说话',
          values: '在意',
          want: '想要',
        },
        scene: {
          title: '场景',
          location: '地点',
          storyStart: '第01天',
          timeline: 'main',
          presentNames: CHARS.map(([, n]) => n),
          goal: '目标',
          conflictLevel: 1,
          situation: '',
        },
        recent: [],
        facts,
        cognition,
        relations: [],
        clues: [],
      });
      leaked += core.countLeakedFacts(result.prompt, facts, cognition, characterId).count;
    }
  }
  assert(leaked === 0, `累计越权 ${leaked} 条`);
  return '72 次装配 · 越权 0';
});

// ── 门禁 7：40 拍场景端到端 ───────────────────────────────────────────────
const PROJECT_A = newProject('p1-a');
let sceneA = '';
gate(7, '40 拍场景端到端 · exit 或 WARN 二者之一', () => {
  const created = okCli([
    'scene', 'create', '雨夜·账本',
    '--cast', cast([['林砚', 1, 0.9], ['沈昼', 1, 0.6], ['祁昭', 0.5, 0.3]]),
    '--goal', '夺回账本',
    '--project', PROJECT_A,
    '--max-beats', '40',
    '--exit', JSON.stringify({ op: 'beats', cmp: '>=', value: 40 }),
    '--json',
  ]);
  sceneA = created.sceneId;
  const run = okCli([
    'run', '--project', PROJECT_A, '--scene', sceneA,
    '--beats', '40', '--seed', '42', '--offline', '--json',
  ]);
  assert(run.produced === 40, `只跑了 ${run.produced} 拍`);
  assert(run.state === 'closed', `场景状态 ${run.state}，期望 closed`);
  assert(run.exitSatisfied === true || run.warned === true, '既没收束也没 WARN');
  assert(run.tokens.max <= run.tokens.budget, '单拍上下文超预算');
  const why = okCli(['beat', 'why', '5', '--project', PROJECT_A, '--scene', sceneA, '--json']);
  assert(why.breakdown.parts, 'beat.why 缺少分值明细');
  return `40 拍 · ${run.state} · exit=${run.exitSatisfied} · 单拍最高 ${run.tokens.max} tok`;
});

// ── 门禁 8：回退 8 域逐域计数/值 ──────────────────────────────────────────
const PROJECT_B = newProject('p1-b');
gate(8, '回退 8 域 · 每域回到目标 seq 的值', () => {
  const created = okCli([
    'scene', 'create', '八域回退',
    '--cast', cast([['林砚', 1, 0.9], ['沈昼', 1, 0.6], ['祁昭', 0.5, 0.3]]),
    '--project', PROJECT_B,
    '--max-beats', '20',
    '--exit', JSON.stringify({ op: 'beats', cmp: '>=', value: 20 }),
    '--cards', JSON.stringify([{ title: '不速之客', minLevel: 0, weight: 1, oneShot: true }]),
    '--json',
  ]);
  const sceneId = created.sceneId;
  okCli(['run', '--project', PROJECT_B, '--scene', sceneId, '--beats', '8', '--seed', '9', '--offline', '--json']);

  const db = dbAt(PROJECT_B);
  let target;
  let baseline;
  let branchId;
  let lin;
  let shen;
  try {
    const branch = store.getActiveBranch(db);
    branchId = branch.id;
    target = branch.headSeq;
    store.createCheckpointWithSnapshot(db, {
      branchId,
      seq: target,
      label: '门禁 8 目标',
      trigger: 'manual',
    });
    baseline = store.domainFingerprint(db, branchId);
    const present = JSON.parse(
      db.prepare('SELECT present FROM scene WHERE id = ?').get(sceneId).present,
    );
    lin = present[0];
    shen = present[1];
  } finally {
    closeQuietly(db);
  }

  // 目标之后把 8 个域全部改掉
  okCli(['run', '--project', PROJECT_B, '--scene', sceneId, '--beats', '3', '--seed', '9', '--offline', '--json']);
  const mutate = dbAt(PROJECT_B);
  try {
    const afterSeq = headOf(mutate);
    const now = new Date().toISOString();
    const factId = 'f-gate8';
    mutate.prepare(
      `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
         valid_from, source_seq, created_at)
       VALUES (?, ?, ?, '住在', '"客栈"', 'single', 1, 1, '第01天', ?, ?)`,
    ).run(factId, branchId, lin, afterSeq, now);
    mutate.prepare(
      `INSERT INTO cognition(branch_id, character_id, fact_id, attitude, certainty, learned_seq,
         source_message_id, percept)
       VALUES (?, ?, ?, 'knows', 1, ?, NULL, 'witness')`,
    ).run(branchId, shen, factId, afterSeq);
    mutate.prepare(
      `INSERT INTO relation(branch_id, from_id, to_id, axis, value, updated_seq, reason)
       VALUES (?, ?, ?, 'trust', 0.5, ?, '门禁 8 目标之后')
       ON CONFLICT(branch_id, from_id, to_id, axis)
       DO UPDATE SET value = excluded.value, updated_seq = excluded.updated_seq`,
    ).run(branchId, lin, shen, afterSeq);
    mutate.prepare(
      `INSERT INTO chapter(id, branch_id, idx, title, file_path, content_hash, word_count,
         covered_until_seq, status, current_rev, updated_seq)
       VALUES ('ch-gate8', ?, 0, '第一章', 'chapters/01.md', ?, 10, ?, 'draft', 1, ?)`,
    ).run(branchId, 'a'.repeat(64), afterSeq, afterSeq);
    mutate.prepare(
      `INSERT INTO revision(id, chapter_id, rev, parent_rev, content, content_hash, author,
         reason, issue_ids, created_at)
       VALUES ('rv-gate8', 'ch-gate8', 1, NULL, '正文', ?, 'user', NULL, '[]', ?)`,
    ).run('b'.repeat(64), now);
    mutate.prepare(
      `INSERT INTO memory_node(id, branch_id, kind, text, valid_from, source_seq)
       VALUES ('mn-sum-gate8', ?, 'summary', '这一场的摘要。', '第01天', ?)`,
    ).run(branchId, afterSeq);
    mutate.prepare(
      `INSERT INTO memory_node(id, branch_id, kind, text, valid_from, source_seq, embedding,
         embedding_model, embedding_dim)
       VALUES ('mn-vec-gate8', ?, 'event', '带向量的一拍。', '第01天', ?, ?, 'gate', 4)`,
    ).run(branchId, afterSeq, Buffer.alloc(16, 1));
    mutate.prepare('UPDATE event_card SET consumed_seq = ? WHERE one_shot = 1').run(afterSeq);
    mutate.prepare(
      `INSERT INTO event_card(id, branch_id, title, trigger_json, min_level, weight, one_shot,
         consumed_seq)
       VALUES ('ec-gate8-after', ?, '后加的牌', 'null', 0, 1, 1, ?)`,
    ).run(branchId, afterSeq);
  } finally {
    closeQuietly(mutate);
  }

  const restored = okCli(['restore', '--project', PROJECT_B, '--seq', String(target), '--yes', '--json']);
  const verify = dbAt(PROJECT_B);
  try {
    const fp = store.domainFingerprint(verify, restored.branchId);
    for (const domain of Object.keys(baseline)) {
      assert(
        JSON.stringify(fp[domain]) === JSON.stringify(baseline[domain]),
        `域 ${domain} 未回到目标值`,
      );
    }
    const expected = {
      messages: baseline.messages.length,
      facts: baseline.facts.length,
      cognition: baseline.cognition.length,
      relations: baseline.relations.length,
      chapters: baseline.chapters.length,
      cards: baseline.cards.length,
      summaries: baseline.summaries.length,
      vectors: baseline.vectors.length,
    };
    for (const [domain, count] of Object.entries(expected)) {
      assert(restored.counts[domain] === count, `${domain} 计数 ${restored.counts[domain]} != ${count}`);
    }
    const oldCount = verify
      .prepare('SELECT count(*) AS c FROM message WHERE branch_id = ?')
      .get(branchId).c;
    assert(
      oldCount > baseline.messages.length,
      `旧分支消息 ${oldCount} 未保留（基线 ${baseline.messages.length}）`,
    );
    const active = store.getActiveBranch(verify).id;
    assert(active === restored.branchId, '活动分支没有切到新分支');
  } finally {
    closeQuietly(verify);
  }
  return '8 域一致 · 旧分支保留 · 活动指针已切换';
});

// ── 门禁 9：回退后重放一致 ────────────────────────────────────────────────
const PROJECT_C = newProject('p1-c');
gate(9, '回退后重放一致 · 同 seed 同上下文 → 同一 beat 序列', () => {
  const created = okCli([
    'scene', 'create', '重放一致',
    '--cast', cast([['林砚', 1, 0.9], ['沈昼', 1, 0.6], ['祁昭', 0.5, 0.3]]),
    '--project', PROJECT_C,
    '--max-beats', '20',
    '--exit', JSON.stringify({ op: 'beats', cmp: '>=', value: 20 }),
    '--json',
  ]);
  const sceneId = created.sceneId;
  const first = okCli([
    'run', '--project', PROJECT_C, '--scene', sceneId,
    '--beats', '10', '--seed', '77', '--offline', '--json',
  ]);
  const second = okCli([
    'run', '--project', PROJECT_C, '--scene', sceneId,
    '--beats', '10', '--seed', '77', '--offline', '--json',
  ]);
  const originalTail = namesOf(second.log);

  const db = dbAt(PROJECT_C);
  let eventSeq;
  let oldBranch;
  try {
    const row = db
      .prepare("SELECT json_extract(breakdown, '$.eventSeq') AS ev FROM beat WHERE scene_id = ? AND seq = 10")
      .get(sceneId);
    eventSeq = row.ev;
    oldBranch = store.getActiveBranch(db).id;
  } finally {
    closeQuietly(db);
  }

  okCli(['restore', '--project', PROJECT_C, '--seq', String(eventSeq), '--yes', '--json']);
  const replay = okCli([
    'run', '--project', PROJECT_C,
    '--beats', '10', '--seed', '77', '--offline', '--json',
  ]);
  const replayTail = namesOf(replay.log);
  assert(first.produced === 10 && second.produced === 10, '前 20 拍没有跑满');
  assert(
    JSON.stringify(originalTail) === JSON.stringify(replayTail),
    `重放序列不同：${originalTail.join('|')} vs ${replayTail.join('|')}`,
  );
  const db2 = dbAt(PROJECT_C);
  try {
    const newBranch = store.getActiveBranch(db2).id;
    const oldBeats = db2
      .prepare(
        `SELECT b.seq, COALESCE(e.name, b.agent_id) AS agent, b.mode
         FROM beat b LEFT JOIN entity e ON e.id = b.agent_id
         WHERE b.branch_id = ? ORDER BY b.seq`,
      )
      .all(oldBranch)
      .map((row) => [row.seq, row.agent, row.mode]);
    const newBeats = db2
      .prepare(
        `SELECT b.seq, COALESCE(e.name, b.agent_id) AS agent, b.mode
         FROM beat b LEFT JOIN entity e ON e.id = b.agent_id
         WHERE b.branch_id = ? ORDER BY b.seq`,
      )
      .all(newBranch)
      .map((row) => [row.seq, row.agent, row.mode]);
    assert(
      sha(JSON.stringify(oldBeats.slice(10))) === sha(JSON.stringify(newBeats.slice(10))),
      '两次运行的 beat hash 不相等',
    );
    return `11–20 拍一致 · ${sha(JSON.stringify(newBeats.slice(10))).slice(0, 12)}`;
  } finally {
    closeQuietly(db2);
  }
});

// ── 门禁 10：到 max_beats 未收束必须 WARN ─────────────────────────────────
const PROJECT_D = newProject('p1-d');
gate(10, '到 max_beats 未收束 · 写 WARN exit_conditions_unsatisfied', () => {
  const created = okCli([
    'scene', 'create', '跑不出去',
    '--cast', cast([['林砚', 1, 0.9], ['沈昼', 1, 0.6]]),
    '--project', PROJECT_D,
    '--max-beats', '6',
    '--exit', JSON.stringify({ op: 'beats', cmp: '>=', value: 99 }),
    '--json',
  ]);
  const run = okCli([
    'run', '--project', PROJECT_D, '--scene', created.sceneId,
    '--beats', '6', '--seed', '5', '--offline', '--json',
  ]);
  assert(run.warned === true, '没有标记 warned');
  assert(run.state === 'closed', `场景状态 ${run.state}，期望 closed`);
  assert(run.beats === 6, `beats=${run.beats}，期望 6（不静默截断）`);
  const db = dbAt(PROJECT_D);
  try {
    const row = db
      .prepare(
        "SELECT json_extract(payload, '$.code') AS code FROM event WHERE kind = 'system.warned'",
      )
      .get();
    assert(row && row.code === 'exit_conditions_unsatisfied', 'WARN 事件缺失或代码不对');
  } finally {
    closeQuietly(db);
  }
  return 'WARN 已写 · beats=6 · closed';
});

// ── 门禁 11：闪回不触发时间线错误 ─────────────────────────────────────────
const PROJECT_E = newProject('p1-e');
gate(11, '闪回 · 同 timeline 倒退被拒，换 timeline 通过', () => {
  okCli([
    'scene', 'create', '第一天',
    '--cast', '林砚:1:0.9', '--story-start', '第01天', '--project', PROJECT_E, '--json',
  ]);
  okCli([
    'scene', 'create', '第十天',
    '--cast', '林砚:1:0.9', '--story-start', '第10天', '--project', PROJECT_E, '--json',
  ]);
  const rejected = cli([
    'scene', 'create', '倒退',
    '--cast', '林砚:1:0.9', '--story-start', '第05天', '--project', PROJECT_E, '--json',
  ]);
  assert(rejected.code === 3, `同 timeline 倒退应退出 3，实际 ${rejected.code}`);
  assert(
    rejected.json?.error?.name === 'ck_scene_time_regression',
    `约束名不对：${JSON.stringify(rejected.json?.error)}`,
  );
  const flashback = okCli([
    'scene', 'create', '闪回',
    '--cast', '林砚:1:0.9', '--story-start', '第05天', '--timeline', 'flashback-a',
    '--project', PROJECT_E, '--json',
  ]);
  assert(flashback.sceneId, '闪回场景没有建成');
  return 'main 倒退 → ck_scene_time_regression · flashback-a 通过';
});

// ── 门禁 12：跨章认知快照 ─────────────────────────────────────────────────
const PROJECT_F = newProject('p1-f');
gate(12, '跨章认知快照 · 第 3 章看不到第 20 章才有的认知', () => {
  const created = okCli([
    'scene', 'create', '认知快照',
    '--cast', cast([['林砚', 1, 0.9], ['沈昼', 1, 0.6]]),
    '--project', PROJECT_F,
    '--json',
  ]);
  const db = dbAt(PROJECT_F);
  try {
    const branch = store.getActiveBranch(db);
    const present = JSON.parse(
      db.prepare('SELECT present FROM scene WHERE id = ?').get(created.sceneId).present,
    );
    const earlySeq = 2;
    const lateSeq = 20;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
         valid_from, source_seq, created_at)
       VALUES ('f-early', ?, ?, '住在', '"客栈"', 'single', 1, 1, '第01天', ?, ?)`,
    ).run(branch.id, present[0], earlySeq, now);
    db.prepare(
      `INSERT INTO fact(id, branch_id, subject_id, predicate, object_json, card, truth, secrecy,
         valid_from, source_seq, created_at)
       VALUES ('f-late', ?, ?, '住在', '"船屋"', 'single', 1, 1, '第20天', ?, ?)`,
    ).run(branch.id, present[1], lateSeq, now);
    db.prepare(
      `INSERT INTO cognition(branch_id, character_id, fact_id, attitude, certainty, learned_seq,
         source_message_id, percept)
       VALUES (?, ?, 'f-early', 'knows', 1, ?, NULL, 'witness')`,
    ).run(branch.id, present[0], earlySeq);
    db.prepare(
      `INSERT INTO cognition(branch_id, character_id, fact_id, attitude, certainty, learned_seq,
         source_message_id, percept)
       VALUES (?, ?, 'f-late', 'knows', 1, ?, NULL, 'witness')`,
    ).run(branch.id, present[1], lateSeq);
    db.prepare(
      `INSERT INTO chapter(id, branch_id, idx, title, file_path, content_hash, word_count,
         covered_until_seq, status, current_rev, updated_seq)
       VALUES ('ch-3', ?, 2, '第三章', 'chapters/03.md', ?, 100, 5, 'draft', 1, ?)`,
    ).run(branch.id, 'c'.repeat(64), earlySeq);
    const rows = db
      .prepare('SELECT fact_id FROM v_knowledge_by_chapter WHERE chapter_id = ? ORDER BY fact_id')
      .all('ch-3')
      .map((row) => row.fact_id);
    assert(rows.includes('f-early'), '第 3 章看不到早期认知');
    assert(!rows.includes('f-late'), '第 3 章看到了第 20 章才有的认知');
    return `第 3 章可见 ${rows.length} 条 · f-late 不可见`;
  } finally {
    closeQuietly(db);
  }
});

// ── 门禁 13：Git 状态包恢复（restore --from-commit）──────────────────────
const PROJECT_G = newProject('p1-g');
gate(13, 'Git 状态包 · 删库后从提交恢复 8 域', () => {
  const created = okCli([
    'scene', 'create', '雨夜·账本',
    '--cast', cast([['林砚', 1, 0.9], ['沈昼', 1, 0.6], ['祁昭', 0, 0.3]]),
    '--goal', '夺回账本', '--max-beats', '20',
    '--project', PROJECT_G, '--json',
  ]);
  const run = okCli([
    'run', '--beats', '20', '--seed', '42', '--offline',
    '--project', PROJECT_G, '--json',
  ]);
  assert(run.state === 'closed', `场景未关闭：${run.state}`);
  assert(
    typeof run.commit === 'string' && run.commit.length >= 7,
    `场景关闭没有 Git 提交：${JSON.stringify(run.commit)}`,
  );
  assert(
    existsSync(path.join(PROJECT_G, '.noryth', 'state.json.zst')),
    '场景关闭没有写 .noryth/state.json.zst',
  );

  const before = (() => {
    const db = dbAt(PROJECT_G);
    try {
      const project = db.prepare('SELECT id FROM project').get();
      const branch = store.getActiveBranch(db);
      const scene = db
        .prepare('SELECT id, title, state, beats FROM scene WHERE id = ?')
        .get(created.sceneId);
      return {
        projectId: project.id,
        branchName: branch.name,
        scene,
        counts: store.domainCounts(db, branch.id),
        fingerprint: store.domainFingerprint(db, branch.id),
      };
    } finally {
      closeQuietly(db);
    }
  })();

  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(path.join(PROJECT_G, '.noryth', `project.db${suffix}`), { force: true });
  }

  const restored = okCli([
    'restore', '--from-commit', run.commit, '--yes',
    '--project', PROJECT_G, '--json',
  ]);
  assert(restored.fromCommit === run.commit, `返回的提交不对：${restored.fromCommit}`);
  assert(restored.branchName !== before.branchName, '恢复没有开新分支');
  assert(restored.headSeq > restored.packageSeq, '新 head 没有越过包内 seq');

  const after = dbAt(PROJECT_G);
  try {
    const project = after.prepare('SELECT id FROM project').get();
    const branch = store.getActiveBranch(after);
    const scene = after
      .prepare('SELECT id, title, state, beats FROM scene WHERE branch_id = ? AND title = ?')
      .get(branch.id, before.scene.title);
    assert(project.id === before.projectId, '恢复后 projectId 变了');
    assert(branch.name === restored.branchName, '活动分支不是恢复分支');
    assert(
      scene &&
        scene.title === before.scene.title &&
        scene.state === 'closed' &&
        scene.beats === before.scene.beats,
      `恢复后场景不一致：${JSON.stringify(scene)}`,
    );
    assert(
      JSON.stringify(store.domainFingerprint(after, branch.id)) ===
        JSON.stringify(before.fingerprint),
      '恢复后 8 域指纹不一致',
    );
  } finally {
    closeQuietly(after);
  }

  const log = execFileSync('git', ['log', '-1', '--format=%B'], {
    cwd: PROJECT_G,
    encoding: 'utf8',
  });
  assert(log.includes('Noryth-Checkpoint:'), '场景关闭的提交缺少 Noryth-Checkpoint trailer');

  // 反例：init 提交里没有状态包，必须明确拒绝，而不是恢复出一个空项目。
  const initCommit = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], {
    cwd: PROJECT_G,
    encoding: 'utf8',
  }).trim();
  const missing = cli([
    'restore', '--from-commit', initCommit, '--yes',
    '--project', PROJECT_G, '--json',
  ]);
  assert(missing.code === 2, `无状态包的提交应退出 2，实际 ${missing.code}`);
  assert(
    String(missing.json?.error?.message ?? '').includes('state.json.zst'),
    `错误信息没有指出缺失的状态包：${JSON.stringify(missing.json?.error)}`,
  );

  return `删库后从 ${run.commit.slice(0, 7)} 恢复 · ${before.counts.messages} 消息 · 8 域指纹一致`;
});

// ── 门禁 14：手动提交 · 未关闭场景 ──────────────────────────────────────
const PROJECT_H = newProject('p1-h');
gate(14, '手动提交 · 未关闭场景可从提交恢复并继续跑', () => {
  const created = okCli([
    'scene', 'create', '未关闭的场',
    '--cast', cast([['林砚', 1, 0.9], ['沈昼', 1, 0.6]]),
    '--max-beats', '20',
    '--project', PROJECT_H, '--json',
  ]);
  const first = okCli([
    'run', '--beats', '3', '--seed', '7', '--offline',
    '--project', PROJECT_H, '--json',
  ]);
  assert(first.state === 'open', `3 拍不应关闭场景：${first.state}`);
  const committed = okCli([
    'commit', '--message', '试验落点',
    '--project', PROJECT_H, '--json',
  ]);
  assert(
    typeof committed.commit === 'string' && committed.commit.length >= 7,
    `手动提交没有 Git sha：${JSON.stringify(committed)}`,
  );
  assert(committed.checkpointId, '手动提交没有写检查点');

  const before = (() => {
    const db = dbAt(PROJECT_H);
    try {
      const scene = db
        .prepare('SELECT state, beats FROM scene WHERE id = ?')
        .get(created.sceneId);
      const messages = db
        .prepare('SELECT count(*) AS c, COALESCE(MAX(seq), 0) AS maxSeq FROM message')
        .get();
      return { scene, messages };
    } finally {
      closeQuietly(db);
    }
  })();
  assert(before.scene.state === 'open' && before.scene.beats === 3, '提交前场景状态不对');

  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(path.join(PROJECT_H, '.noryth', `project.db${suffix}`), { force: true });
  }

  const restored = okCli([
    'restore', '--from-commit', committed.commit, '--yes',
    '--project', PROJECT_H, '--json',
  ]);
  assert(restored.activeSceneId, '未关闭场景的活动指针没有恢复');

  const after = dbAt(PROJECT_H);
  try {
    const scene = after
      .prepare('SELECT state, beats FROM scene WHERE id = ?')
      .get(restored.activeSceneId);
    assert(scene.state === 'open' && scene.beats === 3, `恢复后场景不对：${JSON.stringify(scene)}`);
    const messages = after
      .prepare('SELECT count(*) AS c, COALESCE(MAX(seq), 0) AS maxSeq FROM message')
      .get();
    assert(messages.c === before.messages.c, '恢复后消息数不一致');
    assert(messages.maxSeq === before.messages.maxSeq, '恢复后消息 seq 不一致');
  } finally {
    closeQuietly(after);
  }

  const next = okCli([
    'run', '--beats', '1', '--seed', '7', '--offline',
    '--project', PROJECT_H, '--json',
  ]);
  assert(next.state === 'open' && next.beats === 4, `恢复后无法继续：${JSON.stringify(next)}`);
  return `未关闭场景恢复 · 3 拍 → 继续到 4 拍 · ${committed.commit.slice(0, 7)}`;
});

// ── 报告 ─────────────────────────────────────────────────────────────────
console.log('═'.repeat(78));
console.log('Noryth P1 门禁 1–14');
console.log('═'.repeat(78));
for (const result of results) {
  console.log(
    `  ${result.ok ? 'PASS' : 'FAIL'}  ${String(result.num).padStart(2)}  ${result.label}${result.ok ? `\n        ${result.note}` : `\n        ${result.note}`}`,
  );
}
const passed = results.filter((r) => r.ok).length;
console.log('─'.repeat(78));
console.log(`  ${passed}/${results.length} 通过 · 产物：${CACHE}`);
process.exit(passed === results.length ? 0 : 1);
