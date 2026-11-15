-- name: settings
-- 阶段 10 I2：绑定变更按批记录，并支持「回滚上一套绑定」（PRD §5.6 / UI-DESIGN §8.4）。
-- 一次保存 = 一批；回滚只针对最近一批未被回滚过的变更，且回滚本身也写审计。

ALTER TABLE model_binding_audit ADD COLUMN batch_id TEXT;

CREATE INDEX model_binding_audit_batch ON model_binding_audit(project_id, batch_id);

CREATE TABLE binding_rollback (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  batch_id       TEXT NOT NULL,
  audit_batch_id TEXT NOT NULL,
  actor          TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- 同一批只允许回滚一次：重复点击不会把「上一套」来回覆盖。
CREATE UNIQUE INDEX binding_rollback_once ON binding_rollback(batch_id);
