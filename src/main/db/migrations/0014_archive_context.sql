-- name: archive_context
-- 阶段 22（PHASE-22 §5.4，M2-7 / M2-9）
--
-- memory_entry.archived_at / archive_reason：非事实类记忆的软归档。
--   status 不变（active 仍是 active），检索默认排除；审计与记忆浏览器仍能看见，可恢复。
-- turn_metric.cached_tokens：供应商报告的前缀缓存命中 token；NULL = 未报告，不是 0。
-- memory_audit.action 的 CHECK 需要 archive / restore：SQLite 不能直接改 CHECK，
--   新建同构表 → 逐列复制（id 不变）→ 删旧表 → 改名 → 重建索引。

ALTER TABLE memory_entry ADD COLUMN archived_at TEXT;
ALTER TABLE memory_entry ADD COLUMN archive_reason TEXT;
CREATE INDEX memory_entry_archive
  ON memory_entry(project_id, kind, status, archived_at);

ALTER TABLE turn_metric ADD COLUMN cached_tokens INTEGER;

CREATE TABLE memory_audit_new (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_id      TEXT,
  action      TEXT NOT NULL CHECK (action IN ('extract','apply','invalidate','rebuild','supersede','evidence_mismatch','archive','restore')),
  actor       TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('memory_entry','world_fact','belief','relationship','proposal')),
  entity_id   TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);

INSERT INTO memory_audit_new (id, project_id, job_id, action, actor, entity_type, entity_id, detail_json, created_at)
  SELECT id, project_id, job_id, action, actor, entity_type, entity_id, detail_json, created_at
    FROM memory_audit;

DROP TABLE memory_audit;
ALTER TABLE memory_audit_new RENAME TO memory_audit;
CREATE INDEX memory_audit_by_entity ON memory_audit(entity_id, created_at);
CREATE INDEX memory_audit_by_project ON memory_audit(project_id, created_at);
