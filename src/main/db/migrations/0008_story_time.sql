-- name: story_time
-- 0008_story_time.sql：场景与时间三轴（PHASE-12 M1-2 / DEV-PLAN §5.17）
-- - story_start / story_end：故事内时间，自由文本（「民国二十三年 三月初七 夜」），M1 只展示不比较
-- - timeline：main | flashback | dream；闪回与梦境单独分组，永不参与故事时间先后判定
-- - idx（叙事顺序）不新增列：取 chapter.ord，由章序派生
-- 旧项目回填：timeline 默认 'main'，两轴为 NULL（未标注）。

ALTER TABLE scene ADD COLUMN story_start TEXT;
ALTER TABLE scene ADD COLUMN story_end TEXT;
ALTER TABLE scene ADD COLUMN timeline TEXT NOT NULL DEFAULT 'main'
  CHECK (timeline IN ('main', 'flashback', 'dream'));

CREATE INDEX scene_timeline ON scene(project_id, timeline, ord);
