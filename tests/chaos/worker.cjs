// 混沌测试的「被杀进程」。
// 用法：node tests/chaos/worker.cjs <dbPath> <mode> <chapterId>
//   tx      在事务里写半条 revision，打印 ready 后不提交，等被杀
//   committed  提交一条 revision 后打印 ready，等被杀（模拟落盘后、镜像前的崩溃）
//   memory  在事务里写半条 memory_entry，等被杀
// 只写表、不调应用代码：目的是让 SQLite 在一个真实的事务中被强杀。
const Database = require('better-sqlite3')

const [dbPath, mode, chapterId] = process.argv.slice(2)
if (!dbPath || !mode) {
  console.error('usage: worker.cjs <dbPath> <mode> <chapterId>')
  process.exit(2)
}

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.pragma('synchronous = NORMAL')

const now = new Date().toISOString()
const revId = `rev_chaos_${Date.now().toString(36)}`

try {
  if (mode === 'tx') {
    db.exec('BEGIN IMMEDIATE')
    db.prepare(
      "INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at) VALUES (?, ?, NULL, 'draft', 'chaos-hash', 'doc_controller', NULL, ?)"
    ).run(revId, chapterId, now)
    db.prepare(
      "INSERT INTO outbox (id, project_id, kind, path, expected_hash, attempts, last_error, published_at, created_at) VALUES (?, (SELECT project_id FROM chapter WHERE id = ?), 'manuscript_md', 'manuscript/chaos.md', 'chaos-hash', 0, NULL, NULL, ?)"
    ).run(`ob_chaos_${Date.now().toString(36)}`, chapterId, now)
  } else if (mode === 'committed') {
    db.exec('BEGIN IMMEDIATE')
    db.prepare(
      "INSERT INTO revision (id, chapter_id, parent_revision_id, kind, content_hash, created_by, note, created_at) VALUES (?, ?, NULL, 'draft', 'chaos-committed', 'doc_controller', NULL, ?)"
    ).run(revId, chapterId, now)
    db.exec('COMMIT')
  } else if (mode === 'memory') {
    const project = db.prepare('SELECT id FROM project LIMIT 1').get()
    const character = db.prepare('SELECT id FROM character LIMIT 1').get()
    const chapter = db.prepare('SELECT id, project_id FROM chapter WHERE id = ?').get(chapterId)
    const revision = db.prepare('SELECT id FROM revision WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1').get(chapterId)
    db.exec('BEGIN IMMEDIATE')
    db.prepare(
      `INSERT INTO memory_entry (id, project_id, character_id, kind, text, learned_seq, source_chapter_id, source_revision_id, source_beat_id, importance, pinned, valid_from_seq, valid_to_seq, supersedes_id, embedding_model, status, created_at)
       VALUES (?, ?, ?, 'experience', '混沌写入', 1, ?, ?, NULL, 0.5, 0, NULL, NULL, NULL, 'hash-bigram-v1', 'active', ?)`
    ).run(`mem_chaos_${Date.now().toString(36)}`, project.id, character.id, chapter.id, revision.id, now)
  } else {
    throw new Error(`unknown mode: ${mode}`)
  }
} catch (error) {
  console.error('worker failed', error)
  process.exit(1)
}

process.stdout.write('ready\n')
// 等父进程强杀；留足时间，正常退出走不到这里。
setTimeout(() => {
  db.close()
  process.exit(0)
}, 60_000)
