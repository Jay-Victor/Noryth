# 阶段 05 · 垂直切片：一拍跑通

> 阶段 5 / 10 ｜ 依赖：01–04（03/04 只需最小子集）｜ 下游：06–10
> 对应：`docs/DEV-PLAN.md` §7.1、§9.1、§13.4；这是集成检查点，不新增功能范围
>
> **一句话目标**：在写六个页面之前，用假模型 + 一个场景 + 两拍，把「装配 → 生成 → 校验 → 落盘 → 确认 → 重启不丢」整条链路跑通。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 阶段 02 的 revision 与阶段 04 的信封能接上 | 一次 `commitBeat` 生成新 revision |
| 2 | IPC 流式能把 delta 送到 renderer，且不破坏已确认段落 | 假模型逐字流，UI 只更新当前拍 |
| 3 | 4 个只读工具足以支撑一拍 | `storyboard.get_beat`、`character.get_own_card`、`memory.retrieve_own`、`world.get_limited` |
| 4 | 确认/重生成/编辑的状态迁移没有孤儿 | 2 拍 + 1 次重生成 |
| 5 | 强杀重启后已确认拍不丢 | 杀进程后重开，比对 hash |

## 2 范围

### 2.1 做

- 固定 fixture：1 项目、1 章、1 场景、2 拍（旁白 + 角色），5 角色卡。
- 一个**仅开发环境**的入口（`scripts/dev-slice.ts` 或 `#/dev/slice`），不进入正式导航。
- 假模型适配器：按 `beatId` 返回固定信封，可注入一次工具调用。
- 4 个只读工具的真实实现（可直接复用阶段 03 的成果）。
- 最小 `commitBeat`：接口与 §9.1 一致，阶段 07 直接复用，不换实现。
- 最小 UI：正文两段、拍状态、依据 chips、确认按钮、trace 折叠。
- E2E：`E2E-SLICE-01`。

### 2.2 不做

- 分镜编辑器、G2、自动模式 → 阶段 07。
- 审批报告、patch → 阶段 08。
- 记忆抽取/应用 → 阶段 09。
- 完整视觉与键盘路径；切片 UI 只验证状态，不追求好看。
- 真实 API；全部用假模型。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| fixture | `tests/fixtures/slice/project.json` | 1 项目 1 章 1 场景 2 拍 5 角色 |
| 假适配器 | `tests/fixtures/slice/fake-adapter.ts` | 固定信封 + 可注入工具调用 |
| 切片入口 | `scripts/dev-slice.ts` 或 `src/renderer/app/dev/Slice.tsx` | 仅 dev 构建可见 |
| 最小 commit | `src/main/doc/commit-beat.ts` | 走 revision 清单，hash 可复算 |
| E2E | `tests/e2e/slice.spec.ts` | 5 条断言全绿 |
| 记录 | `docs/adr/0004-slice.md` | 发现的问题与后续修正 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| V1 | fixture + 建项目/章/场景/拍 + 角色卡 | 02 | 一条命令可重建；`db.verify()` 绿 |
| V2 | 假适配器 + 4 工具 + 最小 `commitBeat` + dev 入口 | 03、04 | 一拍能生成、校验、落盘 |
| V3 | E2E：确认、重生成、编辑、强杀重启 | V2 | `E2E-SLICE-01` 全绿 |

## 5 实现要点

### 5.1 切片数据流

```
seed fixture
  → scheduler.nextBeat（本轮只取 2 拍，不写完整调度器）
  → context.assemble（L0/L1/L2 最小块）
  → fakeAdapter.stream（固定信封 + 1 次工具调用）
  → validate（schema + speaker + grounding）
  → doc.commitBeat（revision 清单 + outbox）
  → UI 显示正文/依据/trace
  → 作者确认 → 下一拍
```

### 5.2 最小 `commitBeat`

- 与 §9.1 同签名：`(chapterId, beat, expectedRevision, epoch)`。
- 事务内：校验 `expected_revision` → 分配 seq → 插 beat → 建 revision 清单 → 算 hash → 更新 chapter → 写 outbox。
- 不在这里做 patch/定稿；阶段 07 只加状态机，不改这个接口。

### 5.3 最小 UI

- 只做正文、拍状态、依据 chips、确认按钮、trace 折叠。
- 流式 32ms 批量；只更新当前拍；不重排上一拍。
- 确认后 150ms 内出现下一拍占位；无二次确认。

### 5.4 强杀测试

- 生成第 2 拍时 `taskkill /F`；重开项目。
- 断言：第 1 拍 `confirmed` 仍在；第 2 拍 `interrupted`；`revision` 链无孤儿；outbox 可重试。

## 6 验收清单

- [ ] `E2E-SLICE-01`：seed → 生成 2 拍 → 确认 1 拍 → 重生成 1 拍 → 编辑 1 次 → 重启 → 状态一致。
- [ ] 2 拍各生成一个 revision；`revision_beat` 行数正确；hash 可复算。
- [ ] 依据 chips 只能点开本轮工具返回过的 ref；伪造 ref 被拒绝。
- [ ] 流式只更新当前拍；已确认段落不重排。
- [ ] 强杀重启后已确认拍零丢失；生成中的拍 `interrupted` 可重试。
- [ ] 切片入口在正式导航不可见；生产构建可移除。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 阶段 03/04 的接口不够用 | 切片要改工具签名 | 先改契约再加临时适配，不改阶段 03 的公开 schema |
| IPC 流式重排 | 上一拍文本跳动 | 冻结已确认拍的渲染 key，只更新当前 turnId |
| 假模型与真模型信封不一致 | 真模型跑不通 | 假模型严格走 `Envelope` schema，不用简化版 |
| 切片 UI 被误当正式 UI | 有人开始加功能 | 入口仅 dev；ADR 写明「一次性验证」 |

## 8 进入下一阶段的条件

1. `E2E-SLICE-01` 全绿。
2. `commitBeat` 接口冻结，阶段 07 不再改签名。
3. 切片发现的契约问题已回写到阶段 03/04 的测试。
4. 强杀重启演练通过。
5. 如果切片失败，**停止进入阶段 06**，先修集成问题。
