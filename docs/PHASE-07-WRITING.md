# 阶段 07 · 创作台与调度器

> 阶段 7 / 10 ｜ 依赖：06 ｜ 下游：08–10
> 对应：`docs/DEV-PLAN.md` §5.2、§6.2、§6.5、§8、§12.3（F1–F7）
>
> **一句话目标**：一章按分镜演完：逐拍确认、重生成、编辑、自动模式都能在出口条件处正确收束，并且不产生孤儿拍。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 分镜冲突能在开演前拦住 | T27 硬冲突拒绝 G2 |
| 2 | 出口 DSL 是机器可判定的 | 自然语言出口被拒；纯 beats 告警 |
| 3 | 11 个拍状态迁移没有非法路径 | 状态机全迁移测试 |
| 4 | 重生成不产生双活拍/孤儿 | 连续重生成 + 失败回滚 |
| 5 | 自动模式只在出口/预算/拒演/耗尽处停 | 4 类停止条件各测一次 |

## 2 范围

### 2.1 做

- F1：分镜编辑器、`storyboard.validate`、G2。
- F2：调度器循环、拍/场景/章状态机、暂停/恢复/取消。
- F3：出口 DSL 解析、校验、求值。
- F4：生成 → 校验 → 落盘 → 确认/重生成/编辑。
- F5：正文视图、拍卡、流式、拍级编辑器。
- F6：自动模式预检 + 预算暂停。
- F7：拒演、分镜耗尽、模型错误、离线状态面。
- 编排 Agent 提示词与分镜提案。

### 2.2 不做

- 审批报告/patch → 阶段 08。
- 记忆抽取/应用 → 阶段 09。
- 关系图、伏笔、覆盖检查 → M1/P1。
- 跨章影响分析；M0 只标同章 stale，UI 明示限制。
- 分支树 UI；M0 用线性 revision + 旧版可读。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 分镜页 | `src/renderer/pages/write/StoryboardTable.tsx` | 冲突行内提示；拖拽排序 |
| 调度器 | `src/main/scheduler/loop.ts`、`transitions.ts` | 循环可在拍边界暂停 |
| DSL | `src/main/scheduler/dsl.ts` | 6 种节点 + 校验 + 求值 |
| 拍循环 | `src/main/scheduler/beat.ts`、`src/main/doc/commit-beat.ts` | 重生成无孤儿 |
| 正文/拍卡 | `ProseView.tsx`、`BeatCard.tsx`、`ConfirmBar.tsx` | Enter 确认；stale 徽标 |
| 自动模式 | `src/main/scheduler/auto.ts` | 预检 + 4 类停止 |
| 测试 | `tests/e2e/write.spec.ts`、`tests/unit/scheduler/*` | `E2E-WRITE-01/02` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| F1 | 分镜编辑器 + `storyboard.validate` + G2 | B2、C6 | 冲突 0 才能开演 |
| F2 | 调度器循环、状态机、暂停/恢复/取消 | B3、C3 | 11 个拍状态迁移全覆盖 |
| F3 | 出口 DSL：解析、校验、求值 | B2 | 自然语言拒绝；纯 beats 告警 |
| F4 | 生成 → 校验 → 落盘 → 确认/重生成/编辑 | F2、D4、B4 | 重生成无孤儿；补偿正确 |
| F5 | 正文视图、拍卡、流式、拍级编辑器 | A4、F4 | Enter 确认；IME 正常；stale 徽标 |
| F6 | 自动模式预检 + 预算暂停 | F4、D6 | 超预算必停；出口满足即停 |
| F7 | 拒演、耗尽、模型错误、离线状态面 | F4 | 四类暂停原因可见且可恢复 |

## 5 实现要点

### 5.1 调度循环

```
while job.running:
  beat = nextActionableBeat()
  if !beat: exitSatisfied ? closeScene : pause('storyboard_exhausted')
  if auto && sceneBeatCount >= maxBeats: closeScene('WARN')
  if budget.exceeded: pause('budget_exceeded')
  runTurn(beat)
  if refusal: pause('character_refusal')
  if failed: pause(code)
  if mode == 'beat': waitForHuman(); break
```

- 一次只发一拍；同项目写串行；跨项目可并行读。
- 暂停只在拍边界；取消停止读流，迟到结果由 `expected_revision` 拒绝。

### 5.2 状态机

- 拍：`proposed → generating → draft`；逐拍 `draft → waiting_for_human`；确认/重生成/编辑；`confirmed → stale/superseded`；`generating → interrupted`。
- 重生成：旧拍进 `regenerating` 并保持唯一活行；成功同事务插入新 `draft`，旧拍 `superseded`；失败回 `waiting_for_human`，不产生新行。
- 章/场景/任务沿用 PRD §6.5；代码里三张迁移表，测试逐条覆盖。

### 5.3 出口 DSL

- 只接受 `fact / rel / beats / all / any / not` 的 JSON AST。
- 校验：深度 ≤5、节点 ≤20、实体/谓词已登记、`rel` 在场者、`beats ≤ max_beats`。
- 求值只查事实、关系边、拍数；不调模型。
- 自然语言出口直接拒绝；纯 `beats` 出口标 `beats_only` 告警。

### 5.4 正文与确认

- 连续正文，不按拍分块；gutter `bt_012`；当前拍 2px accent；stale 虚线徽标。
- 流式 32ms 批量，只更新当前拍；确认后 150ms 出现下一拍占位。
- 编辑以拍为单位；保存后下游已确认拍标 stale，三选一（默认开新分支）。
- 跨章不自动标脏，UI 明示「M1 提供影响分析」。

### 5.5 自动模式

- 开跑前显示：剩余 N 拍、预估费用区间、`max_beats`、预算余额。
- 运行中只在拍边界暂停；出口满足、预算、拒演、耗尽、模型错误任一触发即停。
- 分镜耗尽不即兴续写，标 `storyboard_exhausted`，给「补分镜」。

## 6 验收清单

- [ ] `E2E-WRITE-01`：3 场 24 拍，前 6 拍 4 确认 2 重生成，跑完 `draft_complete`。
- [ ] `E2E-WRITE-02`：自动模式在出口条件处停；不超 `max_beats`。
- [ ] 分镜有冲突时 G2 禁用并给第一条原因；冲突 0 才能开演。
- [ ] 11 个拍状态迁移全覆盖；非法迁移抛错。
- [ ] 连续重生成 3 次，旧拍全是 `superseded`，无孤儿、无双活。
- [ ] 编辑已确认拍 → 下游标 stale → 三选一对话框默认「开新分支」。
- [ ] 拒演暂停场景，保留理由；不提供「强制继续」。
- [ ] 分镜耗尽 → `storyboard_exhausted`，不续写。
- [ ] 中文 IME 连续输入 200 字不丢字、不误提交。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 状态机补偿写错 | 双活/孤儿 | 回滚到 `waiting_for_human`；先修迁移表 |
| 出口 DSL 判错 | 提前/延迟收束 | 只信 DSL；先补测试再改 |
| 流式重排 | 正文跳动 | 冻结已确认 key，只更新当前 turn |
| IME 误提交 | 输入回车触发确认 | composition 守卫；焦点不在编辑器才确认 |
| 自动模式烧钱 | 预算未拦 | 每拍检查预算；超预算立即暂停 |

## 8 进入下一阶段的条件

1. 一章 24 拍能到 `draft_complete`，无手工改库。
2. 自动模式四类停止条件都验证过。
3. 重生成/编辑/确认三条路径无孤儿。
4. 正文、拍卡、依据 chips、trace 折叠可用。
5. 阶段 05 的 `commitBeat` 未被改签名。
