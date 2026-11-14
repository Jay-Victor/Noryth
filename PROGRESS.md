# PROGRESS

> 跨会话记忆。每个任务完成或阶段结束时更新；只写状态、决策、阻塞、交接，不写流水账。

## 阶段状态

| 阶段 | 文档 | 状态 | 已完成 | 验收 | 已知问题 |
|---:|---|---|---|---|---|
| 01 | `docs/PHASE-01-SKELETON.md` | todo | — | — | — |
| 02 | `docs/PHASE-02-DATA.md` | todo | — | — | — |
| 03 | `docs/PHASE-03-TOOLS.md` | todo | — | — | — |
| 04 | `docs/PHASE-04-RUNTIME.md` | todo | — | — | — |
| 05 | `docs/PHASE-05-SLICE.md` | todo | — | — | 硬门：未通过不得进入 06 |
| 06 | `docs/PHASE-06-PLANNING.md` | todo | — | — | — |
| 07 | `docs/PHASE-07-WRITING.md` | todo | — | — | — |
| 08 | `docs/PHASE-08-REVIEW.md` | todo | — | — | — |
| 09 | `docs/PHASE-09-MEMORY.md` | todo | — | — | — |
| 10 | `docs/PHASE-10-DELIVERY.md` | todo | — | — | — |

状态：`todo` / `in_progress` / `blocked` / `done`。

## 当前可运行命令

代码尚未初始化，暂无。初始化后填在这里：

- `pnpm dev`
- `pnpm test:unit`
- `pnpm test:contract`
- `pnpm test:e2e`

## 关键决策

| 决策 | 结论 | 记录 |
|---|---|---|
| 向量检索 | 待 S1 决定 sqlite-vec / BLOB | `docs/adr/0001-vector.md` |
| 编辑器 | 待 S2 决定 CM6 / textarea | `docs/adr/0002-editor.md` |
| 供应商 | M0 两家预设 | `docs/adr/0003-providers.md` |

## 当前阻塞

- 无。从 `docs/PHASE-01-SKELETON.md` 开始。

## 下一阶段交接

- 尚未开工。
- 开工前确认：`docs/` 已入库、`AGENTS.md` 可读、`PROMPTS.md` 可用。

## 更新规则

1. 完成一个任务：更新对应阶段的「已完成」。
2. 阶段结束：填「验收」与「已知问题」，状态改 `done`。
3. 出现阻塞：状态改 `blocked`，写清缺什么、等什么。
4. 新会话开始：先读本文件，再读阶段文档。
5. 不把「写了代码」写成 `done`；只有验收清单全绿才是 `done`。
