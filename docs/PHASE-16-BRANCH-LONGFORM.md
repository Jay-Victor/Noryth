# 阶段 16 · 分支、重开定稿与长篇连续性

> 阶段 16 / 18（M1 第 6 阶段）｜ 依赖：14、15 ｜ 下游：17–18
> 对应：`docs/DEV-PLAN.md` §9.4、§9.6、§7.3、§12.6（M1-13、M1-21、M1-22）
>
> **一句话目标**：定稿不是终点——能重开、能分支对比、能让第 30 章记得第 3 章。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 定稿可重开且旧 final 永久可读 | 重开后 final 保留；新 draft 可编辑 |
| 2 | 分支树能对比任意两版 | 两版清单 join；差异按拍对齐 |
| 3 | 重开再定稿触发记忆重建 | 旧记忆 inactive；新 final 重建 |
| 4 | 异构复检可手动配置且不阻塞 | 审批绑另一家；无第二家时 `degraded` |
| 5 | 章末摘要进 L0 且预算不超 | 30 章连续创作上下文不爆 |

## 2 范围

### 2.1 做

- M1-21：分支树 UI + 重新打开定稿（DEV-PLAN §9.6）。
- M1-22：异构复检（手动切换 + 记录 provider；默认关闭）。
- M1-13：章末摘要 + L0 压缩（长篇漂移）。
- 迁移 `0010_branch_summary.sql`：`revision_branch`、`revision.branch_id`、`chapter_summary`。

### 2.2 不做

- 分支合并（M2；M1 只对比 / 切换）。
- 自动选择最佳分支。
- 跨项目分支。
- 模型摘要质量评估与「默认异构复检 + 评分校准」（M2-8）。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 重开定稿 | `src/main/doc/reopen.ts` | final 保留；`write_epoch+1` |
| 分支 | `src/main/doc/branches.ts`、`src/renderer/pages/review/BranchTree.tsx` | 命名 / 对比 / 切换 |
| 异构复检 | `src/main/review/hetero.ts` + 设置项 | 记录 provider；缺失降级 |
| 章末摘要 | `src/main/doc/summary.ts`、`chapter_summary` | final 后生成；L0 引用 |
| 迁移 | `src/main/db/migrations/0010_branch_summary.sql` | 旧 revision `branch_id=NULL` = 主线 |
| 测试 | `tests/unit/doc/*`、`tests/e2e/branch.spec.ts` | `E2E-M1-BRANCH-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M1-21 | 重新打开定稿 | G3、H3 | final 保留；重建入队 |
| M1-21 | 分支树 + 对比 | B3、M1-21 | 对比两版；切换不丢数据 |
| M1-22 | 异构复检（手动） | G1–G4、I2 | 不同 provider 记录；缺失降级 |
| M1-13 | 章末摘要 + L0 | G3、D3 | 摘要 ≤300 tokens；L0 不超预算 |
| M1-21 | 迁移 0010 | B1 | 旧行兼容；`db.verify()` 绿 |

## 5 实现要点

### 5.1 重新打开定稿

- `finalized → revising`：新建 draft revision，`parent = final`；`final_revision_id` 保留；`write_epoch + 1`。
- 允许编辑 / 重生成；再次定稿生成新 final，`final_revision_id` 指向新 final；旧 final 永久可读。
- 首次定稿入队 `memory.extract`；重开后再定稿入队 `memory.rebuild`（G6 已授权），旧 final 来源记忆 `inactive`，不重复入队 `memory.extract`。作者仍可在记忆台手动重跑按章重建。
- G6 仍只在作者侧；重开按钮在审批台 header，确认框说明「旧定稿保留，可用于对比 / 回退」。
- `commitBeat` 对 `finalized` 章仍抛 `already_finalized`；重开后才允许写。

### 5.2 分支

- `revision_branch(id, chapter_id, name, base_revision_id, head_revision_id, status, created_at)`；`revision.branch_id` 可空（`NULL` = 主线）。
- 分支只承载 draft revision；final 不挂 branch（`branch_id=NULL`），切换只允许 draft head；切到 final 走「重新打开定稿」，不是分支切换。
- 迁移顺序：先 `CREATE TABLE revision_branch`，再 `ALTER TABLE revision ADD COLUMN branch_id TEXT REFERENCES revision_branch(id)`（默认 NULL，SQLite 允许）。
- 「开新分支」：从当前 revision 复制清单 → 新 revision + 新 branch；后续 `commitBeat` 写该 branch 的 head。
- 分支树只读展示 parent 链；对比任意两版按 `(scene_ord, beat_ord)` 对齐，差异只读。
- 切换分支：只改 `chapter.current_revision_id` 到该分支 head；不删其他分支；写 `revision_branch` 审计。
- 不做合并；需要合并时作者手动重跑，避免「自动合并」制造不可审计正文。
- `db.verify()` 增：branch head 必须属于该 chapter 且 `kind='draft'`；`current_revision_id` 必在 branch 链内。

### 5.3 异构复检

- 设置 `review.hetero`：`off | prefer`；M1 默认 `off`，作者显式开启。
- `prefer`：审批 job 开始时，若审批与生成 provider 相同且存在已验证的第二家，自动改用第二家；报告记录 `model` + `provider`。
- 不静默换模型：只在 job 开始时解析；job 内不变（§7.7）。
- 缺失第二家 → `degraded='hetero_unavailable'`，不阻断报告；不伪造「已异构」。
- 「默认开启 + 评分校准」留 M2-8；M1 只证明「手动可异构且留痕」。

### 5.4 章末摘要与 L0

- `finalize` 同事务写 `chapter_summary`：抽取式摘要（首拍 + 末拍 + 本章关键事实 ≤5 条），`source='extractive'`；不额外调模型。
- 表：`chapter_summary(revision_id PRIMARY KEY, chapter_id, project_id, summary, key_facts_json, tokens, source, created_at)`；旧 final 的摘要保留。
- 装配：当前章的上一章摘要作为 L0 块 `summary.prev`（priority 高；裁剪顺序在最近拍之后、pinned 之前），不塞进 system 提示词。
- 上一章无摘要（旧项目 / 未定稿）→ 跳过该块，不阻塞；不拿正文临时代替。
- 预算：L0 仍 ≤900；摘要挤占章纲时先裁摘要到 150 tokens，再按 §7.3 顺序；仍超 → `context_overflow`。
- 摘要不参与 hash、不影响 `content_hash`；不写 `beat.body`。
- M1 不做模型摘要；如果后续接入，必须用新 revision 重算并保留 `source` 区分。

## 6 验收清单

- [ ] `E2E-M1-BRANCH-01`：定稿 → 重开 → 改一拍 → 再定稿；旧 final 可读；新 final 指向新 revision；`db.verify()` 绿。
- [ ] 分支：开新分支 → 写 2 拍 → 对比两版差异按拍对齐；切回主线不丢分支。
- [ ] 重开再定稿后自动入队 `memory.rebuild`；旧记忆 inactive（与阶段 14 联动），不重复入队 `memory.extract`。
- [ ] 异构复检 `prefer` 自动换第二家；无第二家 `degraded='hetero_unavailable'`，不阻断。
- [ ] 摘要 ≤300 tokens；L0 总 tokens ≤900；30 章链不 `context_overflow`。
- [ ] 0010 迁移旧项目：`branch_id=NULL`；摘要表空；`db.verify()` 绿。
- [ ] 分支 / 重开不产生第二写入口；正文仍只由 `commitBeat` / `patch` / `finalize` 写。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 重开破坏 final | 旧快照被改 | final 只读；复制清单；审计 |
| 分支切换丢正文 | `current_revision` 指错 | 只在事务内切；verify 清单完整 |
| 异构复检成本 | 双份费用 | 默认 `off`；`prefer` 显式；报告记录 |
| 摘要质量差 | 长篇漂移 | 抽取式兜底；关键事实 pinned；M2 再评估 |
| 摘要挤爆预算 | `context_overflow` | 摘要 ≤300；超预算先裁摘要 |

## 8 进入下一阶段的条件

1. 重开 / 再定稿链路通过，旧 final 可读。
2. 分支对比可用，切换不丢数据。
3. 异构复检有 provider 记录与缺失降级。
4. 摘要进 L0 且预算不超；30 章链无 overflow。
5. 迁移 0010 与 `db.verify()` 全绿。
