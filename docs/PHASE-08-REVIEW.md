# 阶段 08 · 审批台与定稿

> 阶段 8 / 10 ｜ 依赖：07 ｜ 下游：09–10
> 对应：`docs/DEV-PLAN.md` §5.3、§6.3、§9.3、§9.5、§12.3（G1–G5）
>
> **一句话目标**：把「这章能不能用」变成一份可定位、可讨论、可逐条执行的报告；作者授权后改草稿，定稿只能由作者点击。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 报告每条阻断都有 beat 与证据 | schema 校验 + 无证据降级为建议 |
| 2 | 审批不改稿，只有 G5 后才出 patch | 讨论阶段 DB 不变 |
| 3 | patch 只改草稿区已有拍，且 `before` 必须匹配 | 冲突 patch 不套用 |
| 4 | 定稿只能由作者触发，审批没有定稿权 | 无 G6 令牌调用 finalize 被拒 |
| 5 | 定稿后正文不可改，旧 final 可读 | 写 final 的 beat 被拒 |

## 2 范围

### 2.1 做

- G1：审批报告 schema、运行、展示、维度分、issue 定位。
- G2：patch 提案、diff 三视图、逐条接受/拒绝、新 revision。
- G3：G5 授权、G6 定稿、未复检勾选、final 快照。
- G4：复检维度映射、3 轮上限。
- G5：版本列表与只读对比。
- 审批 Agent 提示词与报告降级（schema 失败转纯文本）。

### 2.2 不做

- 记忆抽取/应用 → 阶段 09；本阶段定稿只把 `memory.extract` job 置为 `queued`，不执行。
- 异构模型复检 → M1；M0 只允许手动把审批绑到另一家。
- 审批历史对比、评分校准 → M1/M2。
- 在初稿里直接改字；修订只走 patch。
- 加戏/加场景；patch 不新增拍。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 报告 schema | `src/shared/schema/report.ts` | 阻断必须有 beat + evidence |
| 审批运行 | `src/main/review/run.ts` | 只读初稿/纲要/卡/记忆 |
| 报告页 | `src/renderer/pages/review/ReportView.tsx` | 结论/维度/阻断/建议 |
| patch | `src/main/review/patch.ts` | 需 G5；只改已有拍 |
| diff | `src/renderer/pages/review/DiffView.tsx` | 并排/内联/仅问题 |
| 定稿 | `src/main/doc/finalize.ts` | G6 + 快照 + 不可变 |
| 版本 | `VersionList.tsx` | 只读；不可回退 |
| 测试 | `tests/e2e/review.spec.ts` | `E2E-REVIEW-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| G1 | 审批报告 schema + 运行 + 展示 | F4、D5 | 每条 issue 有 beat + 证据 |
| G2 | patch 提案 + diff + 逐条接受/拒绝 | G1、B2 | `before` 不匹配不套用 |
| G3 | G5/G6、定稿、未复检勾选 | G2 | 定稿仅作者；无快捷键 |
| G4 | 复检维度映射 + 3 轮上限 | G2 | 只跑受影响维度 |
| G5 | 版本列表与只读对比 | B3 | 定稿不可回退 |

## 5 实现要点

### 5.1 报告

- `verdict`：`pass / pass_with_notes / fail`。
- 阻断项：知识越界、越权发言、章纲关键事件缺失/冲突、人物硬冲突、时间线、连续性、引用不存在。
- 每条必须有 `issue_id`、`type`、`beat_id`、`evidence`、`why`、`suggestion`；无证据降级为建议。
- 维度分 1–5，只用于趋势，不用于自动放行。
- schema 失败 → 纯文本报告 + `degraded`；阻断项仍需定位。

### 5.2 patch

- `patch.propose` 需 G5 令牌；只改草稿区已有拍；不加拍、不加场景。
- `before` 归一化后必须与当前正文一致；不一致 → `patch_conflict`，不套用。
- 接受 → 写草稿 + 新 revision；拒绝 → 保留记录，不删 patch。
- 同一 `issue_ref` 再提案必须带新 `reason`，否则报告标「上轮已拒绝」。

### 5.3 定稿

```
G6：
  - 有未确认阻断 → 禁用，显示第一条
  - 有未复检改动 → 列出清单，勾选「我已复核」
  - 写 gate_record(G6)
  - 建 final revision（kind=final）
  - 冻结正文；写 final_revision_id
  - 入队 memory.extract（本阶段只排队，阶段 09 执行）
```

- 定稿按钮只在审批台预览 header；无快捷键。
- 定稿后写正文被拒；重新打开生成新 draft，旧 final 可读。

### 5.4 复检

- 按 `issue_ref.type` 映射维度：知识越界→人物一致性+剧情；纲要对齐→纲要对齐；时间线→剧情；文笔→文笔；未分类→全维度。
- 最多 3 轮；超限转人工，保留全部报告与 patch。
- 复检只跑受影响维度，结果贴在 patch 卡下。

## 6 验收清单

- [ ] `E2E-REVIEW-01`：`draft_complete` → 报告 fail（2 阻断/3 建议）→ G5 → 3 条 patch → 接受 2 拒绝 1 → 新 revision → 复检 → G6 定稿。
- [ ] 每条阻断有 `beat_id` 与证据原文；无证据条目降级为建议。
- [ ] 讨论阶段作者说「改这里」不直接改稿；只产建议或 patch 提案。
- [ ] patch `before` 不匹配 → `patch_conflict`，原文不变。
- [ ] 定稿按钮不在创作台出现；命令面板定稿走同一确认框。
- [ ] 有阻断时定稿禁用；勾选复核后可越过并留痕。
- [ ] 定稿后写正文被拒；`gate_record(G6)` 可查。
- [ ] 版本列表可对比任意两版；定稿不可在此回退。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 报告 schema 不稳定 | 模型输出缺字段 | 纯文本降级 + 阻断定位；不放弃结构化重试 |
| patch 大面积冲突 | 作者先改了稿 | 以当前 revision 为 base 重新提案；不强行套用 |
| 自评偏置 | 审批对自家稿子宽松 | 阻断必须有证据；M1 做异构复检 |
| 定稿误操作 | 作者点太快 | 确认框 + 无快捷键 + 未复检清单 |

## 8 进入下一阶段的条件

1. 报告 → patch → 新 revision → 定稿全链路可重复。
2. final 不可变；写 final 被拒。
3. G6 记录与 `final_revision_id` 一致。
4. 3 轮上限与转人工状态可演示。
5. 定稿后的 `memory.extract` job 已入队（状态 `queued`），等待阶段 09。
