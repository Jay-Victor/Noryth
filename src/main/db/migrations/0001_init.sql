-- name: init
-- 0001_init.sql：全量关系表 + FTS5 + sqlite-vec 虚拟表（DEV-PLAN §5.5 / §5.6）
-- 迁移只前进不回滚；改动本文件即 checksum 变化，启动会拒绝。
-- 注意：_migration 由 migrator 在迁移前创建，本文件不重复建表。

CREATE TABLE project (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  genre           TEXT NOT NULL DEFAULT '',
  pov             TEXT NOT NULL CHECK (pov IN ('first','third_limited','third_omniscient')),
  target_words    INTEGER,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  setup_state     TEXT NOT NULL DEFAULT 'pending' CHECK (setup_state IN ('pending','complete','failed')),
  embedding_model TEXT NOT NULL,
  embedding_dim   INTEGER NOT NULL,
  default_preset  TEXT NOT NULL CHECK (default_preset IN ('openai','deepseek','tongyi')),
  seq_head        INTEGER NOT NULL DEFAULT 0,
  write_epoch     INTEGER NOT NULL DEFAULT 0,
  schema_version  INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE outline_node (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES outline_node(id) ON DELETE RESTRICT,
  kind       TEXT NOT NULL CHECK (kind IN ('main','volume','chapter')),
  ord        INTEGER NOT NULL,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','locked')),
  version    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX outline_root_ord  ON outline_node(project_id, ord) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX outline_child_ord ON outline_node(parent_id, ord) WHERE parent_id IS NOT NULL;

CREATE TABLE character (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  card_json    TEXT NOT NULL,
  card_version INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE chapter (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  outline_node_id     TEXT NOT NULL UNIQUE REFERENCES outline_node(id),
  ord                 INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
                        'planned','storyboard_ready','drafting','draft_complete',
                        'under_review','revising','approved','finalized','paused','abandoned')),
  covered_until_seq   INTEGER NOT NULL DEFAULT 0,
  current_revision_id TEXT,
  final_revision_id   TEXT,
  opened_at           TEXT,
  finalized_at        TEXT,
  UNIQUE (project_id, ord)
);

CREATE TABLE scene (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  ord               INTEGER NOT NULL,
  location          TEXT NOT NULL,
  participants_json TEXT NOT NULL,
  goal              TEXT NOT NULL,
  entry             TEXT NOT NULL DEFAULT '',
  exit_json         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('planned','open','closing','closed','paused')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE chapter_scene (
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  scene_id   TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,
  PRIMARY KEY (chapter_id, ord),
  UNIQUE (chapter_id, scene_id)
);

CREATE TABLE revision (
  id                 TEXT PRIMARY KEY,
  chapter_id         TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  parent_revision_id TEXT REFERENCES revision(id),
  kind               TEXT NOT NULL CHECK (kind IN ('draft','final')),
  content_hash       TEXT NOT NULL,
  created_by         TEXT NOT NULL CHECK (created_by IN ('author','doc_controller','reviewer')),
  note               TEXT,
  created_at         TEXT NOT NULL
);

CREATE TABLE beat (
  id                  TEXT PRIMARY KEY,
  chapter_id          TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  scene_id            TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  ord                 INTEGER NOT NULL,
  seq                 INTEGER,
  speaker_type        TEXT NOT NULL CHECK (speaker_type IN ('character','narrator')),
  speaker_id          TEXT NOT NULL,
  intent              TEXT NOT NULL DEFAULT '',
  body                TEXT NOT NULL DEFAULT '',
  grounding_json      TEXT NOT NULL DEFAULT '[]',
  trace_ref           TEXT,
  status              TEXT NOT NULL CHECK (status IN (
                        'proposed','generating','draft','waiting_for_human','confirmed',
                        'regenerating','rejected','author_edited','stale','superseded','interrupted')),
  supersedes_id       TEXT REFERENCES beat(id),
  created_revision_id TEXT NOT NULL,
  max_words           INTEGER,
  word_count          INTEGER NOT NULL DEFAULT 0,
  author_edited       INTEGER NOT NULL DEFAULT 0,
  decided_by          TEXT CHECK (decided_by IN ('author','auto')),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE UNIQUE INDEX beat_ord_live      ON beat(scene_id, ord) WHERE status <> 'superseded';
CREATE UNIQUE INDEX beat_supersedes_once ON beat(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX beat_by_chapter           ON beat(chapter_id, scene_id, ord);

CREATE TABLE revision_beat (
  revision_id TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  beat_id     TEXT NOT NULL REFERENCES beat(id),
  scene_ord   INTEGER NOT NULL,
  beat_ord    INTEGER NOT NULL,
  PRIMARY KEY (revision_id, scene_ord, beat_ord),
  UNIQUE (revision_id, beat_id)
);

CREATE TABLE patch (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  proposal_id       TEXT NOT NULL,
  revision_id       TEXT NOT NULL REFERENCES revision(id),
  beat_id           TEXT NOT NULL REFERENCES beat(id),
  before            TEXT NOT NULL,
  after             TEXT NOT NULL,
  reason            TEXT NOT NULL,
  issue_ref         TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected','applied','superseded')),
  applied_revision_id TEXT,
  created_at        TEXT NOT NULL,
  decided_at        TEXT
);

CREATE TABLE memory_entry (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL REFERENCES character(id),
  kind              TEXT NOT NULL CHECK (kind IN ('experience','fact','relationship','cognition')),
  text              TEXT NOT NULL,
  learned_seq       INTEGER NOT NULL,
  source_chapter_id TEXT NOT NULL REFERENCES chapter(id),
  source_revision_id TEXT NOT NULL REFERENCES revision(id),
  source_beat_id    TEXT REFERENCES beat(id),
  importance        REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  pinned            INTEGER NOT NULL DEFAULT 0,
  valid_from_seq    INTEGER,
  valid_to_seq      INTEGER,
  supersedes_id     TEXT REFERENCES memory_entry(id),
  embedding_model   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','superseded')),
  created_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX memory_supersedes_once ON memory_entry(supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX memory_own ON memory_entry(character_id, status, learned_seq);

CREATE TABLE world_fact (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject        TEXT NOT NULL,
  predicate      TEXT NOT NULL,
  object         TEXT NOT NULL,
  single_value   INTEGER NOT NULL DEFAULT 1,
  truth          TEXT NOT NULL CHECK (truth IN ('objective','claim')),
  visibility     TEXT NOT NULL CHECK (visibility IN ('public','secret')),
  known_by_json  TEXT NOT NULL DEFAULT '[]',
  reveal_seq     INTEGER,
  valid_from_seq INTEGER NOT NULL,
  valid_to_seq   INTEGER,
  source_type    TEXT NOT NULL CHECK (source_type IN ('author','event','memory')),
  source_id      TEXT,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX world_single_value
  ON world_fact(project_id, subject, predicate)
  WHERE valid_to_seq IS NULL AND single_value = 1 AND truth = 'objective';
CREATE INDEX world_asof ON world_fact(project_id, valid_from_seq, valid_to_seq);

CREATE TABLE character_belief (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_id  TEXT NOT NULL REFERENCES character(id),
  fact_id       TEXT REFERENCES world_fact(id),
  belief_text   TEXT NOT NULL,
  confidence    REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  learned_seq   INTEGER NOT NULL,
  source_type   TEXT NOT NULL CHECK (source_type IN ('dialogue','narration','inference','author')),
  source_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','inactive')),
  created_at    TEXT NOT NULL
);

CREATE TABLE relationship_edge (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  from_id       TEXT NOT NULL REFERENCES character(id),
  to_id         TEXT NOT NULL REFERENCES character(id),
  axis          TEXT NOT NULL CHECK (axis IN ('trust','intimacy','tension')),
  value         REAL NOT NULL CHECK (value BETWEEN -1 AND 1),
  since_seq     INTEGER NOT NULL,
  valid_to_seq  INTEGER,
  source_type   TEXT NOT NULL CHECK (source_type IN ('event','memory','author')),
  source_id     TEXT,
  supersedes_id TEXT REFERENCES relationship_edge(id),
  CHECK (from_id <> to_id)
);
CREATE UNIQUE INDEX rel_one_active
  ON relationship_edge(from_id, to_id, axis) WHERE valid_to_seq IS NULL;

CREATE TABLE approval_report (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id    TEXT NOT NULL REFERENCES chapter(id),
  revision_id   TEXT NOT NULL REFERENCES revision(id),
  round         INTEGER NOT NULL,
  verdict       TEXT NOT NULL CHECK (verdict IN ('pass','pass_with_notes','fail')),
  blocking_json TEXT NOT NULL DEFAULT '[]',
  suggestions_json TEXT NOT NULL DEFAULT '[]',
  dimensions_json  TEXT NOT NULL DEFAULT '{}',
  degraded      TEXT,
  model         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE gate_record (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  gate_id     TEXT NOT NULL CHECK (gate_id IN ('G0','G1','G2','G3','G4','G5','G6','G7','author_confirm')),
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approve','reject','edit')),
  actor       TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  token_hash  TEXT,
  expires_at  TEXT,
  consumed_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX gate_token ON gate_record(token_hash) WHERE token_hash IS NOT NULL;

CREATE TABLE job (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK (type IN (
                       'beat.generate','review.run','patch.propose','memory.extract',
                       'memory.apply','memory.rebuild','export.run','index.rebuild','backup.create')),
  status             TEXT NOT NULL CHECK (status IN ('queued','running','paused','succeeded','failed','cancelled','interrupted')),
  expected_revision  TEXT,
  epoch              INTEGER NOT NULL,
  idempotency_key    TEXT NOT NULL,
  payload_json       TEXT NOT NULL,
  result_json        TEXT,
  error_code         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX job_idem ON job(project_id, idempotency_key);

CREATE TABLE tool_call (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id           TEXT NOT NULL,
  turn_id          TEXT NOT NULL,
  tool             TEXT NOT NULL,
  tool_version     TEXT NOT NULL,
  actor_id         TEXT NOT NULL,
  scope_json       TEXT NOT NULL,
  args_hash        TEXT NOT NULL,
  result_ids_json  TEXT NOT NULL DEFAULT '[]',
  result_json      TEXT,
  status           TEXT NOT NULL CHECK (status IN ('ok','error')),
  error_code       TEXT,
  latency_ms       INTEGER NOT NULL,
  degraded         TEXT,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX tool_idem ON tool_call(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX tool_by_turn ON tool_call(turn_id);

CREATE TABLE model_binding (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_key   TEXT NOT NULL,
  provider    TEXT NOT NULL CHECK (provider IN ('openai','deepseek','tongyi')),
  model       TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL,
  UNIQUE (project_id, agent_key)
);

CREATE TABLE model_binding_audit (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_key  TEXT NOT NULL,
  old_json   TEXT,
  new_json   TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('manuscript_md')),
  path          TEXT NOT NULL,
  expected_hash TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  published_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE turn_metric (
  turn_id        TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id         TEXT NOT NULL,
  beat_id        TEXT,
  agent_key      TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  binding_version INTEGER NOT NULL,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_cny       REAL,
  latency_ms     INTEGER,
  first_token_ms INTEGER,
  context_json   TEXT NOT NULL,
  degraded_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

CREATE TABLE memory_proposal_item (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('experience','fact','relationship','cognition','world_fact','belief')),
  character_id      TEXT REFERENCES character(id),
  text              TEXT NOT NULL,
  payload_json      TEXT NOT NULL DEFAULT '{}',
  source_chapter_id TEXT NOT NULL REFERENCES chapter(id),
  source_revision_id TEXT NOT NULL REFERENCES revision(id),
  source_beat_id    TEXT REFERENCES beat(id),
  importance        REAL NOT NULL DEFAULT 0.5,
  pinned            INTEGER NOT NULL DEFAULT 0,
  decision          TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending','accept','edit','reject')),
  edited_text       TEXT,
  decided_at        TEXT
);
CREATE INDEX proposal_by_job ON memory_proposal_item(job_id, decision);

CREATE VIRTUAL TABLE memory_fts USING fts5(
  memory_id UNINDEXED,
  character_id UNINDEXED,
  bigrams,
  tokenize = 'ascii'
);

CREATE VIRTUAL TABLE memory_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding FLOAT[512]
);

CREATE INDEX chapter_by_project ON chapter(project_id, ord);
CREATE INDEX scene_by_project  ON scene(project_id, ord);
CREATE INDEX outline_by_project ON outline_node(project_id, kind, ord);
CREATE INDEX memory_by_source ON memory_entry(source_chapter_id, status);
