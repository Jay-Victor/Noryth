-- name: planning
-- 0003_planning.sql：规划台（PHASE-06 E1–E4）
-- - 项目增加蓝图版本 / 锁定时间 / 元数据（isolation_verified）
-- - 规划会话与消息、角色卡草案、世界观初值草案
-- - Agent 提案（T31/T32/T33 持久化，替代 tool_call.result_json 暂存）
-- - 记忆命名空间（5 私有 + 1 公共，隔离自检结果）

ALTER TABLE project ADD COLUMN blueprint_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project ADD COLUMN blueprint_locked_at TEXT;
ALTER TABLE project ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE plan_session (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_message_at TEXT
);
CREATE INDEX plan_session_by_project ON plan_session(project_id, status, last_message_at);

CREATE TABLE plan_message (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES plan_session(id) ON DELETE CASCADE,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('author','planner','system')),
  kind        TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','draft','coverage','g1','error')),
  body        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('streaming','done','stopped','failed')),
  meta_json   TEXT NOT NULL DEFAULT '{}',
  attempt     INTEGER NOT NULL DEFAULT 1,
  retry_of    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX plan_message_by_session ON plan_message(session_id, created_at);

CREATE TABLE plan_character (
  id                      TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name                    TEXT NOT NULL,
  card_json               TEXT NOT NULL,
  card_version            INTEGER NOT NULL DEFAULT 1,
  ord                     INTEGER NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','registered')),
  registered_character_id TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE plan_fact (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  predicate   TEXT NOT NULL,
  object      TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','secret')),
  ord         INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX plan_fact_by_project ON plan_fact(project_id, ord);

CREATE TABLE agent_proposal (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('blueprint_patch','character_card','roster')),
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','applied','rejected')),
  job_id        TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  summary_json  TEXT NOT NULL DEFAULT '{}',
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  applied_at    TEXT
);
CREATE INDEX agent_proposal_by_project ON agent_proposal(project_id, status, created_at);

CREATE TABLE memory_namespace (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  character_id       TEXT REFERENCES character(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('private','public')),
  name               TEXT NOT NULL,
  isolation_verified INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  UNIQUE (project_id, name)
);
CREATE UNIQUE INDEX memory_namespace_private
  ON memory_namespace(project_id, character_id) WHERE kind = 'private';
CREATE UNIQUE INDEX memory_namespace_public
  ON memory_namespace(project_id) WHERE kind = 'public';
