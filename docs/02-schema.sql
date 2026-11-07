-- ══════════════════════════════════════════════════════════════════════════
-- Noryth 数据模型 v1
--
-- 设计原则：
--   1. SQLite 是领域状态的唯一权威；Markdown 章节是受控镜像（outbox 发布）。
--   2. 所有约束命名 ck_*，报错能指到具体规则，而不是 "CHECK constraint failed"。
--   3. 事实永远 supersede（写 valid_to），不覆盖；"当前值"是 valid_to IS NULL 的投影。
--   4. 能力边界（谁可以知道什么）落在 cognition 表：没有行 = 不知道。
--   5. 令牌化状态与正文分离：正文改动产生 revision，不 UPDATE 已有行。
--
-- 运行：sqlite3 project.db < 02-schema.sql
-- 校验：python scripts/check.py --schema
-- ══════════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA user_version = 1;

-- ── 项目与版本线 ─────────────────────────────────────────────────────────

CREATE TABLE project (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  root_path      TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
) STRICT;

CREATE TABLE branch (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES branch(id),
  fork_seq   INTEGER NOT NULL DEFAULT 0 CHECK (fork_seq >= 0),
  head_seq   INTEGER NOT NULL DEFAULT 0 CHECK (head_seq >= 0),
  name       TEXT NOT NULL,
  reason     TEXT NOT NULL,                  -- 开这条分支的理由：回退 / 试验 / 分支剧情
  created_at TEXT NOT NULL,
  CHECK (head_seq >= fork_seq),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;

CREATE INDEX ix_branch_project ON branch(project_id, created_at);

-- 活动指针单独一张表，避免 project ↔ branch 的循环外键
CREATE TABLE project_state (
  project_id       TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  active_branch_id TEXT NOT NULL REFERENCES branch(id),
  active_scene_id  TEXT,
  head_seq         INTEGER NOT NULL DEFAULT 0 CHECK (head_seq >= 0)
) STRICT;

-- 业务检查点：回退的最小单位。每 50 个事件自动一个，场景关闭时强制一个。
CREATE TABLE checkpoint (
  id         TEXT PRIMARY KEY,
  branch_id  TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  label      TEXT NOT NULL,
  trigger    TEXT NOT NULL CHECK (trigger IN ('auto','manual','scene_close','git_commit','restore')),
  created_at TEXT NOT NULL,
  UNIQUE (branch_id, seq)
) STRICT;

CREATE TABLE snapshot (
  id         TEXT PRIMARY KEY,
  branch_id  TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL CHECK (seq >= 0),
  blob       BLOB NOT NULL,
  codec      TEXT NOT NULL CHECK (codec IN ('json','zstd+json')),
  bytes      INTEGER NOT NULL CHECK (bytes >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (branch_id, seq)
) STRICT;

-- ── 事件日志（只追加） ───────────────────────────────────────────────────

CREATE TABLE event (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  branch_id       TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN
                    ('user','character','narrator','planner','writer','reviser','critic','director','system')),
  actor_id        TEXT,
  payload         TEXT NOT NULL CHECK (json_valid(payload)),
  idempotency_key TEXT,
  created_at      TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX ux_event_idem ON event(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_event_branch ON event(branch_id, seq);

-- 幂等收据：同一个键 + 同一个请求哈希 → 返回原结果；同键不同请求 → 拒绝。
CREATE TABLE receipt (
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  command         TEXT NOT NULL,
  request_hash    TEXT NOT NULL CHECK (length(request_hash) = 64),
  result_json     TEXT NOT NULL CHECK (json_valid(result_json)),
  result_seq      INTEGER,
  created_at      TEXT NOT NULL,
  PRIMARY KEY (project_id, idempotency_key)
) STRICT;

-- ── Agent 配置 ───────────────────────────────────────────────────────────

CREATE TABLE agent_config (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  role_type   TEXT NOT NULL CHECK (role_type IN
                ('character','narrator','planner','writer','reviser','critic')),
  name        TEXT NOT NULL CHECK (length(trim(name)) > 0),
  entity_id   TEXT,                       -- 角色 Agent 绑定的实体
  model       TEXT NOT NULL,
  temperature REAL NOT NULL DEFAULT 0.8 CHECK (temperature BETWEEN 0 AND 2),
  card        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(card)),
  permissions TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(permissions)),
  enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  UNIQUE (branch_id, name)
) STRICT;

-- ── 实体与事实 ───────────────────────────────────────────────────────────

CREATE TABLE entity (
  id         TEXT PRIMARY KEY,
  branch_id  TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('character','place','item','org','concept')),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  aliases    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(aliases)),
  card       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(card)),
  status     TEXT NOT NULL DEFAULT 'active'
             CHECK (status IN ('active','dead','missing','destroyed','unknown')),
  created_seq INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_entity_name ON entity(branch_id, kind, name);

-- 谓词的"值数"必须显式维护：单值谓词换宾语 = 冲突；多值谓词换宾语 = 并存。
-- 别靠谓语字符串猜——把「同谓语不同宾语」一律判冲突，用户每多一个爱好就被打成争议。
CREATE TABLE predicate_spec (
  predicate   TEXT PRIMARY KEY,
  cardinality TEXT NOT NULL CHECK (cardinality IN ('single','multi')),
  description TEXT NOT NULL DEFAULT '',
  builtin     INTEGER NOT NULL DEFAULT 1 CHECK (builtin IN (0,1))
) STRICT;

INSERT INTO predicate_spec(predicate, cardinality, description, builtin) VALUES
  ('住在',   'single', '常住地，单值', 1),
  ('名为',   'single', '真名/本名，单值', 1),
  ('身份',   'single', '社会身份，单值', 1),
  ('持有',   'single', '物品当前持有者，单值；同一物品只有一个持有者', 1),
  ('位于',   'single', '物品/地点的当前位置，单值', 1),
  ('状态',   'single', '生死/完好状态，单值', 1),
  ('知道',   'multi',  '主观认知，多值', 1),
  ('隐瞒',   'multi',  '主动隐瞒某事，多值', 1),
  ('约定',   'multi',  '承诺与约定，多值', 1),
  ('去过',   'multi',  '到访记录，多值', 1),
  ('目睹',   'multi',  '目击记录，多值', 1),
  ('厌恶',   'multi',  '负向偏好，多值', 1),
  ('偏好',   'multi',  '正向偏好，多值', 1);

CREATE TABLE fact (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  predicate   TEXT NOT NULL REFERENCES predicate_spec(predicate),
  object_json TEXT NOT NULL CHECK (json_valid(object_json)),
  -- 冗余自 predicate_spec，因为生成列只能引用同一行的列
  card        TEXT NOT NULL CHECK (card IN ('single','multi')),
  slot_key    TEXT GENERATED ALWAYS AS (
                CASE WHEN card = 'single'
                     THEN subject_id || '|' || predicate || '|'
                     ELSE subject_id || '|' || predicate || '|'
                          || COALESCE(json_extract(object_json, '$.id'), '') END
              ) STORED,
  truth       INTEGER NOT NULL DEFAULT 1 CHECK (truth IN (-1,0,1)),  -- 1 真 / 0 未知 / -1 假（谎言）
  secrecy     INTEGER NOT NULL DEFAULT 0 CHECK (secrecy BETWEEN 0 AND 3),
  valid_from  TEXT NOT NULL,
  valid_to    TEXT,
  source_seq  INTEGER,
  created_at  TEXT NOT NULL,
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  CHECK (card = 'single' OR json_extract(object_json, '$.id') IS NOT NULL)
) STRICT;

-- 单值槽位：同一分支同一实体同一谓词，只能有一个"当前值"
CREATE UNIQUE INDEX ux_fact_slot ON fact(branch_id, slot_key) WHERE valid_to IS NULL;
CREATE INDEX ix_fact_subject ON fact(branch_id, subject_id, predicate);
CREATE INDEX ix_fact_valid ON fact(branch_id, valid_to);

-- ── 认知：谁知道了什么（能力边界） ───────────────────────────────────────
-- 没有行 = 不知道。这是唯一的判定方式，不接受"同场即可感知"。
CREATE TABLE cognition (
  branch_id         TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  character_id      TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  fact_id           TEXT NOT NULL REFERENCES fact(id) ON DELETE CASCADE,
  attitude          TEXT NOT NULL CHECK (attitude IN
                      ('knows','believes','suspects','doubts','falsely_believes')),
  certainty         REAL NOT NULL DEFAULT 1.0 CHECK (certainty BETWEEN 0 AND 1),
  learned_seq       INTEGER NOT NULL,
  source_message_id TEXT REFERENCES message(id),   -- 前向引用，SQLite 允许
  percept           TEXT NOT NULL CHECK (percept IN
                      ('witness','told','reported','inferred','discovered')),
  PRIMARY KEY (branch_id, character_id, fact_id)
) STRICT;

CREATE INDEX ix_cog_fact ON cognition(fact_id);
CREATE INDEX ix_cog_char ON cognition(branch_id, character_id, learned_seq);

CREATE TABLE relation (
  branch_id   TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  from_id     TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  to_id       TEXT NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
  axis        TEXT NOT NULL CHECK (axis IN ('trust','affection','fear','debt','power')),
  value       REAL NOT NULL CHECK (value BETWEEN -1 AND 1),
  updated_seq INTEGER NOT NULL,
  reason      TEXT,
  PRIMARY KEY (branch_id, from_id, to_id, axis),
  CHECK (from_id <> to_id)
) STRICT;

-- ── 记忆节点（检索材料，不是事实权威） ───────────────────────────────────

CREATE TABLE memory_node (
  id              TEXT PRIMARY KEY,
  branch_id       TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('event','summary','fact','preference','relationship','clue','world')),
  text            TEXT NOT NULL CHECK (length(text) > 0),
  importance      REAL NOT NULL DEFAULT 1.0 CHECK (importance BETWEEN 0.05 AND 3),
  stability       REAL NOT NULL DEFAULT 21 CHECK (stability > 0),   -- R 降到 0.9 的天数
  conf            REAL NOT NULL DEFAULT 1.0 CHECK (conf BETWEEN 0 AND 1),
  valid_from      TEXT NOT NULL,
  last_access     TEXT,
  access_count    INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  pinned          INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  hard            INTEGER NOT NULL DEFAULT 0 CHECK (hard IN (0,1)),
  sensitivity     INTEGER NOT NULL DEFAULT 0 CHECK (sensitivity BETWEEN 0 AND 3),
  owner_id        TEXT REFERENCES entity(id),
  slot_key        TEXT,
  source_seq      INTEGER,
  -- 悬念回收：指向"把它兑现掉"的那个事件。只为 clue 填，NULL = 仍未回收。
  resolved_seq    INTEGER,
  embedding       BLOB,
  embedding_model TEXT,
  embedding_dim   INTEGER,
  CHECK (hard = 0 OR pinned = 1),                                   -- 禁忌必然常驻
  CHECK (resolved_seq IS NULL OR kind = 'clue'),                    -- 只有线索能被"回收"
  CHECK ((embedding IS NULL) = (embedding_model IS NULL)),
  CHECK (embedding IS NULL OR embedding_dim = length(embedding) / 4)
) STRICT;

CREATE INDEX ix_mem_kind ON memory_node(branch_id, kind, importance);
CREATE INDEX ix_mem_pin ON memory_node(branch_id, pinned) WHERE pinned = 1;
CREATE INDEX ix_mem_owner ON memory_node(branch_id, owner_id);

CREATE TABLE memory_edge (
  src    TEXT NOT NULL REFERENCES memory_node(id) ON DELETE CASCADE,
  dst    TEXT NOT NULL REFERENCES memory_node(id) ON DELETE CASCADE,
  kind   TEXT NOT NULL CHECK (kind IN
           ('CAUSES','SUPERSEDES','DERIVED_FROM','SIMILAR','CO_OCCURS')),
  weight REAL NOT NULL DEFAULT 1.0 CHECK (weight BETWEEN 0 AND 1),
  PRIMARY KEY (src, dst, kind),
  CHECK (src <> dst)
) STRICT;

CREATE INDEX ix_edge_dst ON memory_edge(dst, kind);

-- ── 场景 / 节拍 / 消息 ───────────────────────────────────────────────────

CREATE TABLE scene (
  id              TEXT PRIMARY KEY,
  branch_id       TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  arc_id          TEXT,
  -- 叙事顺序由 idx 决定（同分支内唯一）；story_* 描述故事内时间。两者必须分开：
  -- 早先把两者合成一个 story_time，结果"闪回"被判成时间线矛盾——而闪回是最基本的叙事手法。
  idx             INTEGER NOT NULL CHECK (idx >= 0),
  title           TEXT NOT NULL CHECK (length(trim(title)) > 0),
  location_id     TEXT REFERENCES entity(id),
  story_start     TEXT NOT NULL,
  story_end       TEXT,
  timeline        TEXT NOT NULL DEFAULT 'main',
  present         TEXT NOT NULL CHECK (json_valid(present) AND json_array_length(present) >= 1),
  goal            TEXT NOT NULL CHECK (json_valid(goal)),
  conflict_level  REAL NOT NULL DEFAULT 1.0 CHECK (conflict_level BETWEEN 0 AND 4),
  max_beats       INTEGER NOT NULL DEFAULT 40 CHECK (max_beats BETWEEN 1 AND 400),
  beats           INTEGER NOT NULL DEFAULT 0 CHECK (beats >= 0),
  state           TEXT NOT NULL CHECK (state IN
                    ('planned','open','paused','closing','closed','abandoned')),
  exit_conditions TEXT NOT NULL CHECK (json_valid(exit_conditions)),
  summary         TEXT,
  opened_seq      INTEGER,
  closed_seq      INTEGER,
  CHECK (beats <= max_beats),                                        -- 绝不静默超拍
  CHECK (story_end IS NULL OR story_end >= story_start)
) STRICT;

CREATE UNIQUE INDEX ux_scene_idx ON scene(branch_id, idx);
CREATE INDEX ix_scene_state ON scene(branch_id, state);

-- 同一时间线内故事时间不得倒退。"闪回"必须显式声明成另一条 timeline，
-- 而不是把时间倒着填进 main —— 否则审批分不清"叙事技巧"和"时间线矛盾"。
CREATE TRIGGER trg_scene_time_order BEFORE INSERT ON scene
WHEN EXISTS (
  SELECT 1 FROM scene p
  WHERE p.branch_id = NEW.branch_id
    AND p.timeline  = NEW.timeline
    AND p.idx       < NEW.idx
    AND p.story_start > NEW.story_start
)
BEGIN SELECT RAISE(ABORT, 'ck_scene_time_regression: 同一时间线内故事时间倒退，闪回请用独立 timeline'); END;

-- 调度审计：为什么这一拍是它说话
CREATE TABLE beat (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  scene_id    TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  agent_id    TEXT NOT NULL,
  score       REAL NOT NULL,                 -- 阻尼前
  damped      REAL,                          -- 阻尼后
  breakdown   TEXT NOT NULL CHECK (json_valid(breakdown)),
  mode        TEXT NOT NULL CHECK (mode IN
                ('auto','user_pick','forced_narrator','user_acted','arbitrated')),
  -- "仅替换"重写会把后续拍标 stale：它们仍在，但针对的是一句已不存在的台词
  stale       INTEGER NOT NULL DEFAULT 0 CHECK (stale IN (0,1)),
  stale_reason TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (scene_id, seq)
) STRICT;

CREATE TABLE message (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  scene_id    TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  beat_id     TEXT REFERENCES beat(id),
  agent_id    TEXT NOT NULL,
  role_type   TEXT NOT NULL CHECK (role_type IN
                ('character','narrator','director','user','system')),
  prose       TEXT NOT NULL DEFAULT '',
  structured  TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(structured)),
  -- 受众是"这一条消息被谁感知"，不是"这一场有谁"
  audience    TEXT NOT NULL CHECK (json_valid(audience)),
  percept     TEXT NOT NULL CHECK (percept IN
                ('public','whisper','soliloquy','narrator_reader','director','system')),
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  token_est   INTEGER NOT NULL DEFAULT 0 CHECK (token_est >= 0),
  created_at  TEXT NOT NULL,
  -- "重写"的"仅替换"分支：新消息指向被它替换掉的旧消息，旧消息保留可追溯
  supersedes_id TEXT REFERENCES message(id),
  CHECK (length(prose) > 0 OR json_extract(structured, '$.line') IS NOT NULL),
  CHECK (percept <> 'whisper' OR json_array_length(audience) >= 1),
  CHECK (percept NOT IN ('soliloquy','narrator_reader') OR json_array_length(audience) = 0)
) STRICT;

CREATE UNIQUE INDEX ux_msg_seq ON message(branch_id, seq);
CREATE INDEX ix_msg_scene ON message(scene_id, seq);
CREATE INDEX ix_msg_agent ON message(branch_id, agent_id, seq);
-- 一条旧消息只能被替换一次：否则追溯链会分叉，UI 无法判断哪个才是"现行版本"
CREATE UNIQUE INDEX ux_msg_supersede ON message(supersedes_id) WHERE supersedes_id IS NOT NULL;

-- ── 事件卡 ───────────────────────────────────────────────────────────────

CREATE TABLE event_card (
  id           TEXT PRIMARY KEY,
  branch_id    TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json)),
  min_level    INTEGER NOT NULL DEFAULT 0 CHECK (min_level BETWEEN 0 AND 4),
  weight       REAL NOT NULL DEFAULT 1.0 CHECK (weight > 0),
  one_shot     INTEGER NOT NULL DEFAULT 0 CHECK (one_shot IN (0,1)),
  consumed_seq INTEGER,
  CHECK (consumed_seq IS NULL OR one_shot = 1)   -- 只有一次性卡会被永久消耗
) STRICT;

-- ── 正文、修订、审批 ─────────────────────────────────────────────────────

CREATE TABLE chapter (
  id           TEXT PRIMARY KEY,
  branch_id    TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  arc_id       TEXT,
  idx          INTEGER NOT NULL CHECK (idx >= 0),
  title        TEXT NOT NULL CHECK (length(trim(title)) > 0),
  file_path    TEXT NOT NULL,                   -- 相对项目根，禁止绝对路径
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  word_count   INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  -- 这一章的正文覆盖到哪个事件 seq。审批第 3 章时必须用"截至此刻"的认知，
  -- 否则会把第 20 章才揭晓的事判成第 3 章知识越界（假阳性）。
  covered_until_seq INTEGER CHECK (covered_until_seq IS NULL OR covered_until_seq >= 0),
  status       TEXT NOT NULL DEFAULT 'draft'
               CHECK (status IN ('draft','review','final')),
  current_rev  INTEGER NOT NULL DEFAULT 1 CHECK (current_rev >= 1),
  updated_seq  INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_chapter_idx ON chapter(branch_id, idx);
CREATE UNIQUE INDEX ux_chapter_path ON chapter(branch_id, file_path);

-- 一章通常由 2–5 个场景拼成。没有这张表，写作 Agent 不知道该把哪些拍写进哪一章。
CREATE TABLE chapter_scene (
  chapter_id TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  scene_id   TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL CHECK (ord >= 0),
  PRIMARY KEY (chapter_id, scene_id),
  UNIQUE (chapter_id, ord)
) STRICT;

CREATE INDEX ix_chapter_scene_scene ON chapter_scene(scene_id);

CREATE TABLE revision (
  id           TEXT PRIMARY KEY,
  chapter_id   TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  rev          INTEGER NOT NULL CHECK (rev >= 1),
  parent_rev   INTEGER,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
  author       TEXT NOT NULL CHECK (author IN ('user','writer','reviser')),
  reason       TEXT,
  issue_ids    TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(issue_ids)),
  created_at   TEXT NOT NULL,
  UNIQUE (chapter_id, rev),
  CHECK (parent_rev IS NULL OR parent_rev < rev)
) STRICT;

CREATE TABLE issue (
  id          TEXT PRIMARY KEY,
  branch_id   TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  chapter_id  TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  rev         INTEGER NOT NULL CHECK (rev >= 1),
  kind        TEXT NOT NULL CHECK (kind IN
                ('world','character','timeline','logic','style','pacing','knowledge')),
  severity    TEXT NOT NULL CHECK (severity IN ('blocker','major','minor','nit')),
  locator     TEXT,                              -- 段落号 / 引文
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  evidence    TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence)),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','sent_to_reviser','fixed','wontfix','duplicate')),
  round       INTEGER NOT NULL DEFAULT 1 CHECK (round BETWEEN 1 AND 99),
  created_at  TEXT NOT NULL
) STRICT;

CREATE INDEX ix_issue_chapter ON issue(chapter_id, status);
CREATE INDEX ix_issue_open ON issue(branch_id, status) WHERE status = 'open';

-- ── 设定锁 ───────────────────────────────────────────────────────────────

CREATE TABLE lock (
  branch_id  TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  scope      TEXT NOT NULL CHECK (scope IN ('fact','relation','entity','world','timeline')),
  slot_key   TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (length(trim(reason)) > 0),   -- 强制写理由
  locked_by  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (branch_id, scope, slot_key)
) STRICT;

-- ── 文件发布与后台任务 ───────────────────────────────────────────────────

CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  branch_id     TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  chapter_id    TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  rev           INTEGER NOT NULL CHECK (rev >= 1),
  target_path   TEXT NOT NULL,
  expected_hash TEXT,
  applied_rev   INTEGER,
  status        TEXT NOT NULL CHECK (status IN ('pending','applied','failed','skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error    TEXT,
  CHECK (status <> 'applied' OR applied_rev IS NOT NULL)
) STRICT;

CREATE INDEX ix_outbox_pending ON outbox(branch_id, status) WHERE status = 'pending';

CREATE TABLE job (
  id            TEXT PRIMARY KEY,
  branch_id     TEXT NOT NULL REFERENCES branch(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('summarize','embed','extract','index')),
  target_id     TEXT,
  expected_seq  INTEGER NOT NULL CHECK (expected_seq >= 0),
  generation    INTEGER NOT NULL CHECK (generation >= 0),
  status        TEXT NOT NULL CHECK (status IN
                  ('queued','running','done','failed','discarded')),
  payload       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX ix_job_queue ON job(status, created_at) WHERE status IN ('queued','running');

-- ══════════════════════════════════════════════════════════════════════════
-- 触发器：把"只能靠应用层记得"的规则变成数据库拒绝
-- ══════════════════════════════════════════════════════════════════════════

-- 1. 事件日志只追加
CREATE TRIGGER trg_event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'ck_event_immutable: 事件日志只追加，不修改'); END;

CREATE TRIGGER trg_event_no_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'ck_event_immutable: 事件日志只追加，不删除'); END;

-- 2. 消息内容不可原地改写：修改必须产生新的消息 + supersedes 关系
CREATE TRIGGER trg_message_immutable
BEFORE UPDATE OF prose, structured, audience, percept ON message
WHEN NEW.prose IS NOT OLD.prose
  OR NEW.structured IS NOT OLD.structured
  OR NEW.audience IS NOT OLD.audience
  OR NEW.percept IS NOT OLD.percept
BEGIN SELECT RAISE(ABORT, 'ck_message_immutable: 改写消息会破坏既有获知记录'); END;

-- 3. fact.card 必须与 predicate_spec 一致（生成列无法跨表，只能触发器守）
CREATE TRIGGER trg_fact_card BEFORE INSERT ON fact
WHEN COALESCE((SELECT cardinality FROM predicate_spec WHERE predicate = NEW.predicate), '__none__')
     <> NEW.card
BEGIN SELECT RAISE(ABORT, 'ck_fact_card_mismatch: fact.card 与 predicate_spec 不一致'); END;

-- 4. 设定锁：锁住的槽位不接受新版本（换 ID 也绕不过去）
CREATE TRIGGER trg_fact_locked_insert BEFORE INSERT ON fact
WHEN EXISTS (SELECT 1 FROM lock l
             WHERE l.branch_id = NEW.branch_id AND l.scope = 'fact'
               AND l.slot_key = NEW.slot_key)
BEGIN SELECT RAISE(ABORT, 'ck_fact_locked: 该槽位已被作者锁定'); END;

CREATE TRIGGER trg_fact_locked_update
BEFORE UPDATE OF subject_id, predicate, object_json ON fact
WHEN EXISTS (SELECT 1 FROM lock l
             WHERE l.branch_id = OLD.branch_id AND l.scope = 'fact'
               AND l.slot_key = OLD.slot_key)
BEGIN SELECT RAISE(ABORT, 'ck_fact_locked: 锁定事实不可原地改写'); END;

-- 5. 有向记忆边必须是 DAG（CAUSES / SUPERSEDES / DERIVED_FROM）
--    对称边 SIMILAR / CO_OCCURS 允许成环——"A 像 B" 与 "B 像 A" 同真，不该被消解。
CREATE TRIGGER trg_edge_dag BEFORE INSERT ON memory_edge
WHEN NEW.kind IN ('CAUSES','SUPERSEDES','DERIVED_FROM')
BEGIN
  SELECT RAISE(ABORT, 'ck_edge_cycle: 有向记忆边成环')
  WHERE NEW.src = NEW.dst OR EXISTS (
    WITH RECURSIVE reach(id) AS (
      SELECT NEW.dst
      UNION
      SELECT e.dst FROM memory_edge e JOIN reach r ON e.src = r.id
      WHERE e.kind IN ('CAUSES','SUPERSEDES','DERIVED_FROM')
    )
    SELECT 1 FROM reach WHERE id = NEW.src
  );
END;

-- 6. 摘要必须可回溯：删掉被引用的原文会让 DERIVED_FROM 悬空（FK 已挡），
--    但"压缩后原文降权而非删除"由命令层执行；这里只禁止物理删除有子节点的节点。
CREATE TRIGGER trg_memory_no_delete_with_children BEFORE DELETE ON memory_node
WHEN EXISTS (SELECT 1 FROM memory_edge e WHERE e.dst = OLD.id AND e.kind = 'DERIVED_FROM')
BEGIN SELECT RAISE(ABORT, 'ck_memory_has_children: 先解除 DERIVED_FROM 再删除'); END;

-- 7. 章节 rev 必须连续递增，跳号说明有事务被部分提交
CREATE TRIGGER trg_revision_contiguous BEFORE INSERT ON revision
WHEN NEW.rev <> COALESCE((SELECT MAX(rev) FROM revision WHERE chapter_id = NEW.chapter_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'ck_revision_gap: 修订号必须连续'); END;

-- ══════════════════════════════════════════════════════════════════════════
-- 视图
-- ══════════════════════════════════════════════════════════════════════════

CREATE VIEW v_active_fact AS
SELECT * FROM fact WHERE valid_to IS NULL;

CREATE VIEW v_open_scene AS
SELECT * FROM scene WHERE state IN ('open','paused','closing');

CREATE VIEW v_open_issue AS
SELECT * FROM issue WHERE status IN ('open','sent_to_reviser');

-- 一个角色实际能"看见"的事实：cognition 里有行 + 事实当前有效
CREATE VIEW v_character_knowledge AS
SELECT c.branch_id, c.character_id, f.id AS fact_id, f.subject_id, f.predicate,
       f.object_json, f.truth, f.secrecy, c.attitude, c.certainty, c.percept
FROM cognition c
JOIN fact f ON f.id = c.fact_id
WHERE f.valid_to IS NULL;

-- 跨章认知快照：某角色"到第 N 章为止"知道什么。
-- 装配、审批、重读旧稿都必须用它，而不是 v_character_knowledge（那是"现在"）。
-- SQLite 视图不能带参数，所以把 (章节 × 角色 × 事实) 全部展开，查询时按 chapter_id 过滤。
CREATE VIEW v_knowledge_by_chapter AS
SELECT ch.id AS chapter_id, ch.branch_id, c.character_id, c.fact_id,
       c.attitude, c.certainty, c.learned_seq, c.percept
FROM chapter ch
JOIN cognition c
  ON c.branch_id = ch.branch_id
 AND c.learned_seq <= COALESCE(ch.covered_until_seq, 0);

-- 未回收的悬念。审批 Agent 每卷据此输出"埋了没收"的清单。
CREATE VIEW v_open_clue AS
SELECT id, branch_id, text, importance, valid_from, source_seq
FROM memory_node
WHERE kind = 'clue' AND resolved_seq IS NULL;
