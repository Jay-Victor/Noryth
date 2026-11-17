-- name: branch_summary
-- 阶段 16（PHASE-16 §5.2 / §5.4，M1-13 / M1-21 / M1-22）
--
-- 1) revision_branch：分支只承载 draft revision；final 永远 branch_id=NULL（主线）。
--    分支是「bookkeeping 行」，head 会随提交移动，因此只有它可 UPDATE；
--    revision 本身仍然只 INSERT（DEV-PLAN §9.1）。
-- 2) revision.branch_id：NULL = 主线。先建表再加列，SQLite 允许带 REFERENCES 的
--    ADD COLUMN（默认 NULL）。
-- 3) chapter_summary：定稿同事务写入的抽取式摘要（首拍 + 末拍 + 关键事实），
--    按 revision 主键保存，旧 final 的摘要永久保留。
-- 4) approval_report.provider：异构复检留痕（model 已有，provider 区分「哪一家」）。

CREATE TABLE revision_branch (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id        TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  base_revision_id  TEXT NOT NULL REFERENCES revision(id),
  head_revision_id  TEXT NOT NULL REFERENCES revision(id),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'merged', 'archived')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (chapter_id, name)
);
CREATE INDEX revision_branch_by_chapter ON revision_branch(chapter_id, created_at);

ALTER TABLE revision ADD COLUMN branch_id TEXT REFERENCES revision_branch(id);
CREATE INDEX revision_by_branch ON revision(branch_id);

CREATE TABLE chapter_summary (
  revision_id    TEXT PRIMARY KEY REFERENCES revision(id) ON DELETE CASCADE,
  chapter_id     TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  project_id     TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  summary        TEXT NOT NULL,
  key_facts_json TEXT NOT NULL DEFAULT '[]',
  tokens         INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT 'extractive' CHECK (source IN ('extractive', 'model')),
  created_at     TEXT NOT NULL
);
CREATE INDEX chapter_summary_by_chapter ON chapter_summary(chapter_id, created_at);

ALTER TABLE approval_report ADD COLUMN provider TEXT;
