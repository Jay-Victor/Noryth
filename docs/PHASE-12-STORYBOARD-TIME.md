# 阶段 12 · 分镜、场景库与时间三轴

> 阶段 12 / 18（M1 第 2 阶段）｜ 依赖：11 ｜ 下游：13–18
> 对应：`docs/DEV-PLAN.md` §5.5（scene / chapter_scene）、§6.9（T23）、§12.6（M1-1、M1-2）
>
> **一句话目标**：让「章 ↔ 场景」真的多对多，让时间拆成三条轴；闪回不再被当成时间线矛盾。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 同一场景可在多章之间规划引用；演出前 fork，正文不跨章共享 | 两章链接同一空 scene 不报错；给演出章链接已有正文的场景 → 要求 fork |
| 2 | 引用章只读，改写必须 fork | 在引用章 `commitBeat` → `invalid_args`；fork 后新章可写 |
| 3 | 三轴分开返回 | T23 输出 `story_start/end`、`idx`、`timeline` |
| 4 | 闪回不误报时间线 | `E2E-M1-TIME-01`：第 3 章闪回时间早于第 1 章，审批不报 timeline |
| 5 | 旧项目迁移可回退 | 0008 后旧 scene 默认 `timeline='main'`，全部测试绿 |

## 2 范围

### 2.1 做

- M1-1：章↔场景多对多 UI + 场景管理（场景库、链接/解链、排序、fork）。
- M1-2：时间三轴（`story_start` / `story_end` / `timeline`；`idx` 由章序派生）。
- T23 `timeline.query`：实现并从 `enabled=false` 打开（M1 开关）。
- `db.verify()` 扩展场景/拍归属检查（现有 `beat_scene_unlinked` 之上）。
- 迁移 `0008_story_time.sql`。

### 2.2 不做

- 自动推断故事时间（M2；M1 由作者填）。
- 跨章连续场景的自动拆分（作者显式 fork）。
- 世界时间线 UI（阶段 13）；本阶段只有数据与工具。
- 场景模板库、按题材生成场景（P2）。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 场景库 | `src/renderer/pages/write/SceneLibrary.tsx` | 列表、搜索、链接到章、fork |
| 分镜表 | `src/renderer/pages/write/StoryboardTable.tsx` | 每场显示时间轴与时间；引用场标「只读引用」 |
| 时间字段 | `src/main/db/repos/scene.ts` | 读写三轴；旧行默认 main |
| T23 | `src/main/tools/manifests/knowledge.ts`、`src/main/tools/support/timeline.ts` | 三轴分开；as_of 截断 |
| 校验 | `src/main/db/verify.ts` | 扩展 `beat_scene_unlinked`；演出场景只能属于一个章 |
| 迁移 | `src/main/db/migrations/0008_story_time.sql` | `LATEST_SCHEMA_VERSION = 8` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-1 | 场景库 + 链接/解链/排序/fork | B2、F1 | 空场景可多章规划；演出前必须 fork |
| M1-2 | 时间三轴 + 迁移 0008 | B1、F1 | 旧项目默认 main；闪回可标 |
| T23 | `timeline.query` 实现 | M1-2、C2 | 三轴分开；as_of 不越水位；空返回 `empty` |
| T23 注册 | 白名单 + 生成物 | C1、C2 | orchestrator / reviewer / memory 各 +1；`gen:check` 0 diff |
| verify | 归属与演出唯一检查 | M1-1 | 演出场景只属一章；引用章 commit 拒绝 |

## 5 实现要点

### 5.1 场景库与多对多语义

- `scene` 是项目级；`chapter_scene` 是章内顺序的唯一真相（C1）。
- **规划期允许多对多**：一个空场景（无 live 拍）可链接多章，用于比较/复用；此时不产生正文。
- **演出期只允许一个演出章**：`beat.chapter_id` 是演出章；一旦场景有 live 拍，`chapter_scene` 只能保留该演出章，其他章链接必须解链或 fork。
- 引用章只读：不能 `commitBeat / editBeat / generate` 该场景的拍；`revision_beat` 只包含 `beat.chapter_id = 本章` 的拍（现有 `loadLiveManifest` 语义不变），引用场不进本章正文与 hash。
- 要在新章演出同一场景 → `scene.fork`：复制 scene + beats（新 id，保留 `supersedes` 链），新章持有自己的拍；旧章正文与 revision 不变。
- 解链不删 scene；删除场景仅在无 live 拍且未被引用时允许，否则 `invalid_args`。
- `db.verify()` 扩展现有 `beat_scene_unlinked`：`(beat.chapter_id, beat.scene_id)` 必在 `chapter_scene` 中；同一 scene 的 live 拍跨章 → `scene_cross_chapter_beats`。
- 需要新增 `sceneRepo.listChaptersByScene(sceneId)` 供演出唯一性检查；repo 只做查询，判定在 `scheduler/storyboard.ts`。
- 这套语义保住两条不变量：revision 清单不可变（不共享可变正文）、正文只有一个写入者（fork 后才由 `commitBeat` 写新拍）。
- 不在 M1 做「共享正文的场景」；共享会让一章改稿静默改掉另一章的 final，违反 R5。

### 5.2 三轴定义

- `story_start` / `story_end`：自由文本（「民国二十三年 三月初七 夜」），作者填；M1 只展示，不参与比较。
- `idx`：叙事顺序，取 `chapter.ord`（全书统一编号）；不新增列。`chapter_id` 缺省 = 当前章，`idx` 取该章 `ord`。
- `timeline`：`main | flashback | dream`，scene 级，默认 `main`。
- 闪回判定：M1 **不做故事时间先后判定**；`timeline` 只用于分组、展示与 T23 返回。任何后续比较必须只比较 `main` 场景，flashback / dream 永不参与。
- 现有 `consistency.check` 的 `timeline_non_monotonic` 检查的是 `beat.seq`（叙事序），与 `story_start` 无关；本阶段不改该检查，也不新增故事时间硬检查。
- T23 输出：`story_start/end` 取章内第一个 main 场景的范围；`timeline` 数组按 `beat.seq` 返回 `{seq, story_time}`，`story_time` 取所属场景 `story_start`（无则 `null`）。
- `as_of` 由运行时水位约束；超过章 `covered_until_seq` 的请求返回 `stale_revision`，不返回未来拍。

### 5.3 迁移 0008

```sql
ALTER TABLE scene ADD COLUMN story_start TEXT;
ALTER TABLE scene ADD COLUMN story_end TEXT;
ALTER TABLE scene ADD COLUMN timeline TEXT NOT NULL DEFAULT 'main'
  CHECK (timeline IN ('main', 'flashback', 'dream'));
CREATE INDEX scene_timeline ON scene(project_id, timeline, ord);
```

- SQLite `ALTER TABLE ADD COLUMN` 带 CHECK 允许；默认值回填旧行。
- 迁移测试覆盖 0001→0008；旧 fixture 的 `db.verify()` 必须全绿。
- 回退不用 `DROP COLUMN`；阶段回退用新迁移，不改已应用文件（checksum 规则）。

### 5.4 分镜 UI

- 每场头部：地点 / 在场者 / 目标 + 三轴字段；`timeline != main` 显示徽标。
- 引用场：表头「只读引用（第 N 章）」+ [fork 到本章]；拍卡不可编辑/重生成。
- 拖拽排序只改 `chapter_scene.ord`，不改 `scene.ord`（场景库顺序）。
- G2 只物化本章链接的场景；引用场不重复建 beat；草案里删掉引用场只解链，不删 scene。
- G2 物化前检查：场景已有 live 拍且属于其他章 → `invalid_args`，提示 fork；不允许把别的章的演出拍搬进本章。
- 时间轴为空时提示「未标注」，不阻塞 G2；闪回场景不因时间早于前章被 G2 拒绝。

## 6 验收清单

- [ ] 两章链接同一空场景：不报错、不产生 beat；给演出章链接已有正文的场景 → 要求 fork。
- [ ] 引用章的 revision 清单与 hash 不含该场拍（不共享正文）；在引用章生成/编辑 → `invalid_args`。
- [ ] fork 后新章可写；原章 revision 与正文不变；`db.verify()` 无 `scene_cross_chapter_beats`。
- [ ] 0008 迁移旧项目：所有 scene `timeline='main'`；`db.verify()` 绿。
- [ ] T23 三轴分开；`as_of` 超过章水位被拒绝。
- [ ] `E2E-M1-TIME-01`：第 3 章标 flashback（`story_start` 早于第 1 章）→ T23 返回 `timeline='flashback'`；审批报告无 `timeline_non_monotonic` 或 timeline 阻断，`consistency.check` 不报。
- [ ] allowlist 快照：orchestrator / reviewer / memory 各 +T23；`gen:check` 0 diff。
- [ ] `python docs/scripts/check_tool_spec.py` 仍 PASS。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 规划链接被当成演出 | 两章共享同一拍 | 引用只读 + 演出前 fork；verify 拦截；UI 徽标 |
| 时间字段自由文本 | 无法比较 | M1 只展示；比较与格式校验 M2 |
| 闪回误报 | 审批阻断 | 只有 main 参与时序；回归用例 |
| 迁移 CHECK 失败 | 旧库打不开 | SQLite 允许 ADD COLUMN CHECK；迁移测试覆盖 |
| 场景库范围蔓延 | 做成大纲工具 | 只做链接/排序/fork；模板后置 |

## 8 进入下一阶段的条件

1. 0008 在旧 fixture 上升级成功，`db.verify()` 绿。
2. 规划链接 / fork 两条路径有测试，跨章共享正文拍 = 0。
3. T23 注册且 allowlist 快照与 PRD 一致。
4. 闪回回归 `E2E-M1-TIME-01` 通过。
5. 场景库不写正文，唯一写入者仍是 `commitBeat`。
