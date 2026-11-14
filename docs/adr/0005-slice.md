# ADR 0005 · 阶段 05 垂直切片

- 状态：accepted
- 日期：2026-11-14
- 阶段：05（垂直切片）
- 关联：`docs/PHASE-05-SLICE.md`、`DEV-PLAN.md` §7.1/§9.1–9.2、`PRD.md` §4.5–4.7/§6.5–6.6/§9.4

> PHASE-05 §3 写的路径是 `docs/adr/0004-slice.md`，但 0004 已被
> `0004-embedding.md` 占用；本文件按实际编号落为 `0005-slice.md`，不影响契约。

## 1 目的

在写六个页面之前，用假模型 + 一个固定场景 + 两拍，把

```
fixture → 装配 → 生成 → 校验 → commitBeat（revision + outbox） → 确认/重生成/编辑 → 强杀重启
```

整条链路跑通。切片只证明集成，不新增产品范围：没有调度器、分镜编辑器、G2、
自动模式、审批报告、记忆抽取。

## 2 冻结的接口

### 2.1 `commitBeat`

`src/main/doc/commit-beat.ts`：

```ts
commitBeat(db, repos, {
  chapterId, expectedRevision, epoch,
  sceneId, ord, speakerType, speakerId, body,
  intent?, grounding?, traceRef?, supersedesId?,
  status?, maxWords?, authorEdited?, createdBy?
}) → { beatId, revisionId, seq, contentHash, mirrorHash }
```

- 与 DEV-PLAN §9.1 的 `(chapterId, beat, expectedRevision, epoch)` 同义；`beat` 以扁平字段传入，
  避免多一层与 DB 行同形的中间结构。
- 只 INSERT `revision` / `revision_beat` / `beat`，旧拍只 `superseded`；`content_hash` 在插入前算好。
- 事务内校验 `epoch` 与 `current_revision_id`，任一不匹配 `stale_revision`，不写任何行。
- 阶段 07 的 DocController 直接调用本函数；只加状态机与 patch 应用，不改签名。

### 2.2 `runTurn` 的落盘回调

阶段 04 的 `runTurn` 只校验、不落盘。阶段 05 增加可选 `deps.commit`：

```
校验通过 → deps.commit(envelope, job 快照) → job succeeded（result_json 含 revision/hash）
```

- 不注入 `commit` 时保持阶段 04 行为（DB 集成测试继续证明「不写正文」）。
- 注入后 commit 失败 → 事务回滚 + `job.failed`，不会出现「job 成功但正文没落盘」。
- `trace` 由 commit 回调先写 `logs/trace/<jobId>/<turnId>.json`，路径进 `beat.trace_ref`；
  trace 文件**不复制 body**，正文只有 DB 一份真相。

### 2.3 重试与幂等

`beatJobIdempotencyKey` 增加可选 `attempt`：同一拍、同一 revision、同一绑定的重复点击仍是
同一个 job；强杀后的重试必须换 `attempt`，否则会命中旧的 `interrupted` job。默认不传，
保持阶段 04 的「同键重放」语义。

## 3 实现选择

| 选择 | 理由 |
|---|---|
| fixture 唯一真源 `tests/fixtures/slice/project.json` | PHASE-05 指定路径；主进程只在未打包构建按 `appPath/tests/...` 读取，生产包不含数据 |
| 假适配器实现在 `src/main/slice/fake-adapter.ts`，`tests/fixtures/slice/fake-adapter.ts` 仅 re-export | 主进程不能反向依赖 `tests/`；同时保留文档指定入口给测试 |
| 假适配器严格走 `ChatAdapter` + 完整 `Envelope` | 简化信封会让切片失去证明力（PHASE-05 §7 风险） |
| 假适配器按「本拍意图」匹配脚本，而不是 `beatId` | 提示词稳定前缀里不出现 beatId（DEV-PLAN §7.9）；按意图匹配才不会为了测试破坏提示词契约 |
| 种子拍 `status=proposed` 且 `seq=NULL` | 分镜占位不是叙事事件；生成时由 commitBeat 替换并分配 seq，`verify` 不会误报 seq 非单调 |
| 生成/重生成都 supersede 槽位上的现行拍 | 正文 append-only；`(scene_id, ord)` 部分唯一索引靠 supersede 释放 |
| trace 与正文分离 | PRD §4.6 / DEV-PLAN §7.2；trace 可单独归档与清理 |
| 打开项目时 `running→interrupted`、补发 outbox | PRD §9.4 / §6.6；强杀重启的验收点 |
| 切片 IPC 只在 `!app.isPackaged && NORYTH_SLICE !== '0'` 注册 | 生产包调用返回 `invalid_args`；导航不出现切片入口 |
| 状态文案集中在 `shared/schema/slice.ts` | 「状态矩阵 fixture」= `tests/unit/slice/status-matrix.test.ts` 全量覆盖 11 个状态 |
| 确认按钮乐观更新 | PHASE-05 §5.3 要求 150ms 内出现下一拍占位，不等 IPC 往返 |

## 4 切片发现的问题（后续修正）

| # | 现象 | 影响 | 处理 |
|---:|---|---|---|
| 1 | `db/verify.ts` 的 `seq_not_monotonic` 按 `(scene_ord, beat_ord)` 检查「章内 seq 不减」。**重生成/编辑较早的拍**会分配更大的 seq，若后面的拍已确认，检查会报错 | 阶段 07 允许改任意拍时会误报；切片只重生成最后一拍，所以本阶段验收不受影响 | **阶段 07 必修**：改为检查「seq 唯一 + `project.seq_head >= max(seq)` + 同一槽位 seq 单调」，不要求阅读顺序单调。DEV-PLAN §5.3 第 5 条只要求 as_of 单调，并未要求按拍序单调 |
| 2 | 阶段 04 的 job 幂等键不区分「同一任务重放」与「失败后重试」 | 强杀后重试会命中 `interrupted` job | 已加可选 `attempt`；阶段 07 的调度器必须传重试序号 |
| 3 | `character.get_own_card` / `world.get_limited` 的假模型脚本不需要额外调用；真实模型可能调用多次 | 只影响成本，不影响契约 | 阶段 06/07 用真实模型观察调用分布，必要时调 `maxCallsPerTurn` |
| 4 | 切片页只验证状态，没有键盘路径与 200% 缩放布局 | 非本阶段范围 | 阶段 07 正式创作台补 UI-DESIGN §5.4 的键盘与栅格验收 |

## 5 验收映射

| PHASE-05 §6 | 证据 |
|---|---|
| `E2E-SLICE-01` | `tests/e2e/slice.spec.ts` 第 1 条：seed → 生成 2 拍 → 确认 1 → 重生成 1 → 编辑 1 → 重启 |
| 2 拍各一个 revision、清单正确、hash 可复算 | 同上 DB 断言（5 个 revision、每个 2 行、逐条复算）；`tests/unit/doc/commit-beat.test.ts` |
| 依据 chips / 伪造 ref 拒绝 | `tests/integration/slice.spec.ts`（伪造 → `grounding_not_returned`，不落正文）；E2E 点开 chip 看到原文 |
| 流式只更新当前拍 | E2E 在第二拍流式期间断言第一拍正文不变；store 只按 `beatId` 写增量 |
| 强杀重启 | E2E 第 2 条：`taskkill /F /T` → 重开；已确认拍仍在，第二拍 `interrupted`，重试成功，无孤儿 `revision_beat` |
| 入口不进导航 / 生产可移除 | E2E 断言 `[data-nav="slice"]` 为 0；main 只在未打包构建注册切片服务与通道 |

## 6 后续阶段的交接

- 阶段 06 的草案持久化（T31/T33/T34）不受本 ADR 影响；切片没有新增表/迁移。
- 阶段 07 复用 `commitBeat` 与 `markGenerating/confirmBeat/editBeat`；调度器只替换切片服务里的
  「单拍编排」和假适配器。`commitBeat` 签名冻结。
- 阶段 09 的 `MemoryExecutor` 不经过切片服务；`runTurn` 的 commit 回调是正文的唯一入口，
  记忆应用仍是独立事务。
- 阶段 10 打包时确认 `app.isPackaged === true` 的构建中 `slice.*` 通道全部未注册。
