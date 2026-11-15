-- name: memory
-- 0006_memory.sql：记忆台与 G7（PHASE-09 H1–H5）
-- - memory_proposal_item.evidence_quote：证据必须是来源拍正文的连续子串（DEV-PLAN §10.1）；
--   原文单独成列，payload_json 只放结构化字段（三元组/关系轴/置信度）
-- - memory_audit：每条记忆可追溯到定稿章/拍，标记错误与重建都留痕（PRD §5.4）
-- - memory_message：记忆台对话（追问来源/为什么重要）；讨论永不写库，
--   与审批台的 review_message 分开，避免两条审计流混淆
-- - 提案按章索引：记忆台按章浏览「待处理 / 历史固化」

ALTER TABLE memory_proposal_item ADD COLUMN evidence_quote TEXT;
CREATE INDEX proposal_by_chapter ON memory_proposal_item(project_id, source_chapter_id, decision);

CREATE TABLE memory_audit (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id      TEXT,
  action      TEXT NOT NULL CHECK (action IN ('extract','apply','invalidate','rebuild','supersede','evidence_mismatch')),
  actor       TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('memory_entry','world_fact','belief','relationship','proposal')),
  entity_id   TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
CREATE INDEX memory_audit_by_entity ON memory_audit(entity_id, created_at);
CREATE INDEX memory_audit_by_project ON memory_audit(project_id, created_at);

CREATE TABLE memory_message (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id TEXT REFERENCES chapter(id) ON DELETE CASCADE,
  job_id     TEXT,
  role       TEXT NOT NULL CHECK (role IN ('author','memory','system')),
  kind       TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','proposal','apply','pause')),
  body       TEXT NOT NULL DEFAULT '',
  meta_json  TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX memory_message_by_chapter ON memory_message(chapter_id, created_at);
