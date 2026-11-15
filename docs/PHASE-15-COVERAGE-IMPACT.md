# 阶段 15 · 覆盖检查、影响分析与伏笔

> 阶段 15 / 18（M1 第 5 阶段）｜ 依赖：12、13 ｜ 下游：16–18
> 对应：`docs/DEV-PLAN.md` §12.5、§12.6（M1-8、M1-10、M1-11）、`docs/PRD.md` §6.3
>
> **一句话目标**：把 M0 的三个占位（覆盖、影响、伏笔）变成可阻断 / 可追溯的真实流程。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 覆盖检查能阻断 G1 | 有阻断时确认禁用；P1 开关可关 |
| 2 | 蓝图变更必须跑影响分析 | 未跑 T29 直接应用 → `invalid_args`，DB 不变 |
| 3 | 影响分析能列出受影响章 / 记忆 / 边 | 改一条主线 → ch3 / ch7 标 `invalidated_at` |
| 4 | 伏笔只报节奏不报逻辑 | 超期只显示距离；不产生阻断 |
| 5 | 跨章标脏不自动改稿 | 只标记 + 提示；作者决定重写 / 忽略 |

## 2 范围

### 2.1 做

- M1-11：覆盖检查（T26 实现 + 规划台 tab + G1 阻断规则）。
- M1-8：影响分析（T29）+ 蓝图变更流程（G1 后变更记录）。
- M1-10：伏笔（T22 实现 + 作者标注 + 列表 / 距离 / 回收）。
- 跨章标脏：`chapter.invalidated_at` / `invalidated_reason`。
- 迁移 `0009_blueprint_ops.sql`：`outline_node.meta_json`、`foreshadow`、`blueprint_change`、`chapter.invalidated_at`。

### 2.2 不做

- 自动语义识别伏笔（M2）。
- 覆盖检查的模型判断（M1 只做确定性规则）。
- 蓝图变更自动重写下游正文（作者决定）。
- 分支树 / 版本对比（阶段 16）。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 覆盖检查 | `src/main/plan/coverage.ts`、`src/renderer/pages/plan/CoveragePanel.tsx` | 4 类规则；定位到章 / 卡 |
| 影响分析 | `src/main/plan/impact.ts` | 章 / 记忆 / 边；写变更记录 |
| 变更流程 | `src/main/plan/change.ts` | 提案 → 影响 → 确认 → 应用 |
| 伏笔 | `src/main/world/foreshadow.ts`、`src/renderer/pages/memory/ForeshadowPanel.tsx` | 标注 / 列表 / 距离 / 回收 |
| 迁移 | `src/main/db/migrations/0009_blueprint_ops.sql` | 旧行默认；`LATEST_SCHEMA_VERSION = 9` |
| 测试 | `tests/unit/verify/*`、`tests/e2e/blueprint.spec.ts` | `E2E-M1-BLUEPRINT-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-11 | 覆盖检查 4 类规则 | E5、E2 | 阻断项可定位；建议项只计数 |
| M1-8 | 影响分析 + 变更流程 | M1-11、C5 | 未跑影响分析拒绝应用 |
| M1-10 | 伏笔标注 + T22 | B2、M1-12 | 伏笔 CRUD；T22 只读 |
| 跨章标脏 | `invalidated_at` + UI 提示 | M1-8、F2 | 受影响章标脏；G2/G4 提示 |
| T22/T26/T29 启用 | 白名单 + 生成物 | C1、C2 | allowlist 更新；`gen:check` 0 diff |

## 5 实现要点

### 5.1 覆盖检查

M1 只做确定性四类：

1. 卷纲关键事件无章落点：`outline_node.meta_json.key_events[]` 每项需有 `chapter_node_id`。
2. 主要角色无出场动机：卷节点 `meta_json.character_ids[]` 中每个角色，至少在一个章节点 `meta_json.character_ids[]` 出现；不解析自然语言 `goal`。
3. 主线推进间隔：`mainline=true` 的章节点间隔 >5 章 → 建议。
4. 章纲与角色卡冲突：章纲 `pov_character_id` 不在角色表 / 已归档 → 阻断。

- 阻断项才禁 G1；建议项只计数（PRD §6.3）。
- `meta_json` 的 Zod 形状固定为：
  `{ key_events?: [{ id, text, chapter_node_id? }], character_ids?: string[], pov_character_id?: string, mainline?: boolean }`；未知字段丢弃，不写库。
- `coverage.check` 输出 `gaps[{code, severity, node_id, message}]`；这是契约变更：先写 PRD 变更记录，再升 T26 manifest 1.1.0 并重生成 `docs/tools/*.json`。不先在 PRD 立项就实现，视为契约漂移。
- 蓝图变更后覆盖检查重跑；旧结果失效，不缓存。
- `meta_json` 空 → 只给「未标注」建议，不阻断；避免旧项目一升级就被卡。

### 5.2 影响分析与变更流程

```
G1 后改蓝图
  → T31 提案（agent_proposal kind=blueprint_patch）
  → T29 影响分析（必须）
  → 写 blueprint_change（ops / impact / status=proposed）
  → 作者确认 → 应用 outline / 角色卡（version+1）
  → 受影响章 invalidated_at=now；写 write_message 系统提示
```

- 影响面：outline 子树 → 章 → final revision → `memory_entry.source_chapter_id`；角色卡 → 该角色发言的拍 → 章 / 记忆。
- 结果进 `blueprint_change.impact_json`；UI 显示章 / 记忆 / 边计数与列表。
- 未跑 T29 或结果为空 → `invalid_args`（不能「假装没影响」）。
- 应用变更不自动改正文；已定稿章也不改，只标 `invalidated_at`。
- T31 需要扩展 ops：`key_events` / `character_ids` / `mainline` / `pov_character_id`；契约变更先写 PRD 变更记录，再升 manifest 版本并重新生成 `docs/tools/*.json`。

### 5.3 伏笔

- 作者在章纲 / 场景面板标注伏笔：`text`、`planted_chapter_id`、`planned_payoff_chapter_id`（可空）、`status open|closed`。
- T22 返回 open 列表 + 埋设章 + 当前章距离；超期只标「已 N 章未回收」。
- 回收：作者标记 `closed` + `payoff_chapter_id`；不自动判定。
- 伏笔不设时间衰减（PRD §5.4）；不进记忆检索；不产生审批阻断。

### 5.4 迁移 0009

```sql
ALTER TABLE outline_node ADD COLUMN meta_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE chapter ADD COLUMN invalidated_at TEXT;
ALTER TABLE chapter ADD COLUMN invalidated_reason TEXT;

CREATE TABLE foreshadow (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  planted_chapter_id TEXT REFERENCES chapter(id),
  payoff_chapter_id TEXT REFERENCES chapter(id),
  planned_payoff_chapter_id TEXT REFERENCES chapter(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE blueprint_change (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  proposal_id TEXT,
  ops_json TEXT NOT NULL,
  impact_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected')),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
```

- `meta_json` 旧行默认 `{}`；`invalidated_at` 不改变章状态，只在 G2/G4 前提示。
- `blueprint_change` 一条变更一行；`impact_json` 保存章 / 记忆 / 边 ID；应用后写 `applied_at`。
- 索引：`foreshadow(project_id, status)`、`blueprint_change(project_id, created_at)`。

## 6 验收清单

- [ ] 覆盖检查 4 类规则各有通过 / 失败用例；阻断项让 G1 禁用并显示第一条原因。
- [ ] `E2E-M1-BLUEPRINT-01`：G1 后改主线 → T29 列出受影响章 / 记忆 → 确认应用 → ch3 / ch7 `invalidated_at` 非空 → G2/G4 提示 → 作者忽略后继续。
- [ ] 未跑 T29 直接应用变更 → `invalid_args`，DB 不变。
- [ ] 伏笔：标注 3 条 → T22 返回 open 3；回收 1 → 2；距离正确；无阻断。
- [ ] 0009 迁移旧项目：`meta_json='{}'`；coverage 不阻断；`db.verify()` 绿。
- [ ] T22/T26/T29 allowlist 与 PRD 一致；`gen:check` 0 diff。
- [ ] 跨章标脏不改正文、不自动重跑；已定稿章也保留。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 覆盖规则误阻断 | 作者被卡 | 只有明确冲突才阻断；其余建议；开关可关 |
| 影响分析漏章 | 下游未标 | outline 子树 + 角色发言双路径；测试覆盖 |
| 变更流程被绕开 | 直接改草案 | G1 后字段只读；应用只走 change |
| 伏笔范围蔓延 | 做成自动追踪 | M1 作者标注；自动识别 M2 |
| `meta_json` 漂移 | 规则失效 | Zod schema + 迁移默认；契约测试 |

## 8 进入下一阶段的条件

1. 覆盖检查可阻断 G1，且有开关与定位。
2. 蓝图变更必须过影响分析，变更记录可追溯。
3. 伏笔列表 / 回收 / 距离可用，且不产生逻辑阻断。
4. 跨章标脏不自动改稿，UI 可忽略 / 重写。
5. 0009 迁移与 `db.verify()` 全绿。
