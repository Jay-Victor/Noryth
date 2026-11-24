# AGENTS.md

Noryth 是一个 Electron 桌面端多 Agent 小说创作工作台：作者定蓝图与分镜，角色与旁白按拍演出，审批与记忆固化把「这一章」变成「下一章的资产」。Windows 10/11 x64 首发，单人开发，范围 M0–M2。

## 当前状态

- 阶段 01 已 `done`（2026-11-14）：A1–A6、B1、B6、S1–S4、42+8 工具清单外壳完成；本地门禁与 Windows CI 全绿；标签 `phase-01-done` → `ab778c4`。
- 阶段 02 已 `done`（2026-11-14）：B2–B5、13 类 repos（Kysely + better-sqlite3 同步执行）、seq/hash/revision、outbox/mirror、backup、verify、fixture；新增 `0002_outbox_meta.sql`（`LATEST_SCHEMA_VERSION = 2`）。本地门禁与 Windows CI 全绿；标签 `phase-02-done` → `37e6eed`。
- 阶段 03 已 `done`：42 manifest / 36 实现 / 6 开关、授权解析、九步流水线、闸门/幂等/审计、36×6 契约 harness；标签 `phase-03-done`。
- 阶段 04 已 `done`：SSE/OpenAI 兼容适配器与重试、能力探测、L0–L3 装配与预算、信封/grounding 校验、六角色提示词、绑定快照；标签 `phase-04-done` → `cc46c10`。
- 阶段 05 已 `done`（2026-11-14）：`commitBeat`（唯一正文写入者）、trace 归档、拍状态迁移、启动恢复、开发切片（fixture + 假适配器 + `#/dev/slice`）、`E2E-SLICE-01` 与强杀重启；见 `docs/adr/0005-slice.md`。本地门禁全绿。
- 阶段 06 已 `done`（2026-11-14）：规划会话/流式/停止/重试、T42 作者选择、蓝图与角色卡草案、提案表 `agent_proposal`、G1 注册 + 5 私有/1 公共命名空间 + 隔离自检、覆盖检查占位；新增 `0003_planning.sql`（`LATEST_SCHEMA_VERSION = 3`）；`E2E-PLAN-01/02`。CI run `43603698391` 全绿；标签 `phase-06-done` → `bbea9df`。真实规划模型需 `NORYTH_PLAN_API_KEY`（设置页 Key 在阶段 10）。
- 阶段 09 已 `done`（2026-11-15）：`memory/extract|apply|retrieve`、`MemoryExecutor`（单事务 + 向量 + 审计 + G7）、记忆台四分区与软失效；新增 `0006_memory.sql`（`LATEST_SCHEMA_VERSION = 6`）；`E2E-MEMORY-01`。CI run `43681891589` 全绿；标签 `phase-09-done` → `4fca40c`。
- 阶段 10 已 `done`（2026-11-15）：I1–I4 设置中心（safeStorage Key、逐 Agent 绑定 + 批次审计 + 回滚、测试连接、外观）、J1–J6（fixture 假服务器、`E2E-M0-A` 14 步、`E2E-M0-PROVIDER`、`CHAOS-01..08`、NSIS + 安装冒烟 + 更新检查、PERF-01、安全/无障碍/200% 缩放）、导出 Markdown/TXT；新增 `0007_settings.sql`（`LATEST_SCHEMA_VERSION = 7`）；M0 验收报告 `docs/M0-ACCEPTANCE.md`。
- M1 阶段文档已建（2026-11-15）：`docs/PHASE-11-SCALE.md` 至 `docs/PHASE-18-DELIVERY-M1.md`；阶段 11–18 均已 `done`（M1 收口，标签 `phase-18-done`）；阶段顺序与任务 ID 见 `docs/DEV-PLAN.md` §12.4 / §12.6。
- 阶段 19 已 `done`（2026-11-21）：M2-1 声音指标（T25 逐角色 + 两两分项 + `threshold`，1.1.0，审批白名单 19→20）、`zh-v1` 夹具语料校准（0.252；FPR 2.0% / TPR 97.5%，ADR-0007）、迁移 0012 `voice_metric`、`voice.scene` 只读 IPC；M2-2 创作台场景头徽标 + 审批台 `VoicePanel` + 报告运行时 `voice` 建议（只建议，不阻断 G6）；`scripts/calibrate-voice.mjs` / `scripts/m2-baseline.mjs` / `docs/M2-METRICS-BASELINE.md`；`E2E-M2-VOICE-01`、`E2E-M2-METRICS-01`。本地门禁全绿（unit 827 / integration 48 / e2e 34 / chaos 8 / perf 2）；CI run `44914033792` 全绿（verify + e2e 两片）；标签 `phase-19-done` → `eed3ef1`；`LATEST_SCHEMA_VERSION = 12`。
- 阶段 20 已 `done`（2026-11-21）：M2-3 章预算（token + ¥，出口优先，暂停/恢复不丢已确认拍，`job.result_json.budget`）+ 费用预测（最近 5 拍中位数、0.7–1.3 区间、无计价 null）；M2-5 全链路计量（`turn_metric.chapter_id`：写拍/审批/记忆/讨论，规划为 NULL）+ `report.cost` + `CostReportDialog` + 状态栏预算段；迁移 0013（`chapter.budget_cny`、`turn_metric.chapter_id`、两个索引）+ `docs/M2-COST-BASELINE.md`；`E2E-M2-BUDGET-01`、`E2E-M2-COST-01`。本地门禁全绿（unit 840 / integration 58 / e2e 36 / chaos 8 / perf 2）；`LATEST_SCHEMA_VERSION = 13`。
- 阶段 21 已 `done`（2026-11-21）：M2-4 显式故障切换（`routing` 设置 + `model/router.ts` + 内存熔断 `model/health.ts` + 状态栏徽标；auth/内容过滤/协议错误不切换，同一拍不中途换模型）+ M2-8 异构默认值校准（`review/calibration.ts` + `scripts/m2-calibration.mjs` + `docs/M2-HETERO-CALIBRATION.md`；D4 判定保持 `off`，ADR-0008/0009）；新增错误码 `routing_exhausted` 与只读 IPC `routing.status` / `review.calibration`；无迁移（`LATEST_SCHEMA_VERSION = 13`）；`E2E-M2-ROUTING-01`、`E2E-M2-CALIBRATION-01`；本地门禁全绿（unit 857 / integration 61 / e2e 38 / chaos 8 / perf 2）；CI run `45384289571` 全绿；标签 `phase-21-done` → `825ea4c`。
- 阶段 22 已 `done`（2026-11-24）：M2-7 非事实类归档（`memory/archive.ts` 候选规则 + `apply.archiveMemoryEntries` 单事务 + `memory_audit` archive/restore + 记忆台「维护」tab + `memory.archive.*` 四个 IPC）+ M2-9 上下文成本（块去重、L3 相关裁、最近拍 4→2 兜底、提示词去重、`cached_tokens` 解析 + 报表/检查器）；迁移 0014（`memory_entry.archived_at/archive_reason` + `turn_metric.cached_tokens` + `memory_audit` CHECK 重建，`LATEST_SCHEMA_VERSION = 14`）；基线 `docs/M2-CONTEXT-COST.md`（180 拍 2,725→2,167，−20.5%）；`E2E-M2-ARCHIVE-01`、`COST-M2-02`；本地门禁全绿（typecheck / lint / depcruise 344 modules / unit 873 / integration 61 / e2e 41 / chaos 8 / perf 2 / build / gen:check / 规格脚本）；CI run `45395894252` / `45398509831` 全绿；标签 `phase-22-done` → `706b62c`。
- M2 阶段文档已建（2026-11-17）：`docs/PHASE-19-VOICE.md` 至 `docs/PHASE-24-DELIVERY-M2.md`；阶段 19–22 已 `done`，23–24 为 `todo`；阶段顺序与任务 ID 见 `docs/DEV-PLAN.md` §12.4 / §12.6，验收口径见 §16.5。
- 阶段 11 已 `done`（2026-11-15）：M1-12 多项目切换（`project.busy` 探针 + `cancelRunning` + 切换确认框 + 事件按 projectId 丢弃）、M1-9 章节摘要 + `VirtualList` + `PERF-M1-01`、M1-16 文件树抽屉（Ctrl B，320 overlay + 焦点陷阱）、M1-24 `openLastProject` + 诊断包 zip；`E2E-M1-SWITCH-01`、`E2E-M1-TREE-01`。未改 schema（`LATEST_SCHEMA_VERSION = 7`）；0008 从阶段 12 开始。CI run `43700004809` 全绿；标签 `phase-11-done` → `c2ef570`。
- 阶段 12 已 `done`（2026-11-15）：M1-1 场景库（链接/解链/排序/fork/删除）、M1-2 时间三轴、T23 `timeline.query`、verify `scene_cross_chapter_beats`；新增 `0008_story_time.sql`（`LATEST_SCHEMA_VERSION = 8`）。标签 `phase-12-done` → `374578b`。
- 阶段 13 已 `done`（2026-11-15）：M1-3 as-of 投影 + 世界时间线、M1-18 作者事实编辑器（`applyAuthorFact`）、M1-17 上下文检查器（`turn_metric.context_json`）、M1-19 审批/检索 as-of 边界（review 用 `covered_until_seq`）；`world.projection` / `world.fact.add` / `world.fact.close` / `write.context`；`E2E-M1-ASOF-01`、`E2E-M1-CONTEXT-01`。未改 schema（`LATEST_SCHEMA_VERSION = 8`）；CI run `43714545719` 全绿，标签 `phase-13-done` → `3f82a16`。
- 阶段 14 已 `done`（2026-11-15）：M1-4 按章重建（`memory/rebuild.ts`、`ApplyInput.rebuild` 同事务清旧、`author_confirm`、T40 打开）、M1-5 关系图（`world/relations.ts` 确定性圆环 + as-of 回放 + 来源，记忆台第五 tab）、M1-20 bge 权重随包（q8 24MB，`pnpm verify:embed` 冷启动 134ms）+ `index.rebuild`（分批 32、可恢复、`author_confirm`）；NSIS 157MB + 安装冒烟 PASS（日志 `source=model`）；新增 `E2E-M1-REBUILD-01`、`CHAOS-09`；未改 schema（`LATEST_SCHEMA_VERSION = 8`）。
- 阶段 15 已 `done`（2026-11-15）：M1-11 覆盖检查（`plan/coverage.ts` 4 类确定性规则 + G1 阻断/开关 + 结构化标注）、M1-8 影响分析与变更流程（T29 写 `blueprint_change`、未分析不可应用、应用只标脏）、M1-10 伏笔（T22 + 记忆台第六 tab）、跨章标脏（`chapter.invalidated_at` + G2/G4 提示 + 忽略）；新增 `0009_blueprint_ops.sql`（`LATEST_SCHEMA_VERSION = 9`）；`E2E-M1-BLUEPRINT-01`、`E2E-M1-FORESHADOW-01`。
- 阶段 16 已 `done`（2026-11-17）：M1-21 重新打开定稿（`doc/reopen.ts`；旧 final 保留、`write_epoch+1`、再定稿入队 `memory.rebuild`）+ 分支树（`doc/branches.ts`、`revision_branch`、`BranchTree.tsx`；只对比/切换，不合并）、M1-22 异构复检（`review/hetero.ts` + `review.hetero` 设置，默认 off；报告记录 `provider`，缺失 `degraded=hetero_unavailable`）、M1-13 章末摘要 + L0 `summary.prev`（`doc/summary.ts`、`chapter_summary`；≤300 tokens，L0 ≤900）；新增 `0010_branch_summary.sql`（`LATEST_SCHEMA_VERSION = 10`）；`E2E-M1-BRANCH-01`。
- 阶段 17 已 `done`（2026-11-17）：M1-6 DOCX（`doc/export-docx.ts`：标题页 / 目录 / 章标题分页 / 场景分隔 / 首行缩进 2 字符；zip 时间戳 + core 时间 + 书签 id 归一化 → 同清单字节可复现；`docx` 运行时按需加载）+ M1-14 选项（`format`/`scope`/`includeNotes`/`toc`/`font`/`fontSize`/`lineSpacing`/`author`）、三档格式统一从 revision 清单渲染（未定稿标「草稿」）、`ExportDialog.tsx`、`E2E-M1-DOCX-01`；依赖 `docx` + `fflate`（纯 JS）；未改 schema（`LATEST_SCHEMA_VERSION = 10`）。CI 全绿 run `44034048165`（`d3ac330`）；标签 `phase-17-done` → `d3ac330`。
- 阶段 18 已 `done`（2026-11-17）：版本 0.2.0；M1-7 更新通道（`dev/beta/stable`、semver 预发布、同 minor 才允许回退、`scripts/update-drill.mjs`）、M1-15 QA（`E2E-M1-SMOKE` 3 章提交门 / `E2E-M1-A` 30 章 3 卷 nightly / `project.verify`）、M1-23 工具审计面板（迁移 0011 `tool_call.chapter_id` + `memory.toolCalls` + `ToolCallList.tsx`）、M1-25 图标（`scripts/gen-icons.mjs` + `resources/icon.ico|png`）；`docs/M1-ACCEPTANCE.md` 记录 PRD M1 五条证据。`LATEST_SCHEMA_VERSION = 11`。作者决定不测 Win10 22H2 安装冒烟与真实第二家 Key（外部依赖）；标签 `phase-18-done`。
- S3 按「DeepSeek 一家」收口（`deepseek-flash` 实测），第二家供应商顺延到阶段 04 D1 前补测；见 `docs/adr/0003-providers.md`。
- `docs/` 已入库，是项目规格的一部分；不要删除、移动或重写。
- 进度与交接写 `PROGRESS.md`；阶段范围与验收以 `docs/PHASE-0X-*.md` 为准。
- 如果 `docs/` 缺失，先向用户确认，不要凭记忆补规格。
- 常用命令：`pnpm dev`、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm depcruise`、`pnpm test:unit`、`pnpm test:e2e`、`pnpm test:e2e:m1a`、`pnpm test:chaos`、`pnpm test:perf`、`pnpm verify:embed`、`node scripts/gen-icons.mjs`、`node scripts/update-drill.mjs`、`node scripts/calibrate-voice.mjs`、`node scripts/m2-baseline.mjs <项目目录>`、`node scripts/m2-cost-baseline.mjs <项目目录>`、`node scripts/m2-calibration.mjs <项目目录>`、`pnpm gen:check`、`pnpm pack`、`pnpm dist`、`node scripts/install-smoke.mjs`。
- 原生依赖：`scripts/prepare-native.mjs` 把 sqlite-vec 的 `vec0.dll` 复制到 `resources/native/`；`pnpm install` 后若该文件缺失，先跑 `node scripts/prepare-native.mjs`。

## Git 策略

- 分支：`dev` 为开发分支；阶段验收全绿后打标签 `phase-0X-done`。
- 提交：一个任务一次提交；说明写「改了什么、怎么验证」。
- 入库：`AGENTS.md`、`PROGRESS.md`、`docs/`（PRD、UI-DESIGN、DEV-PLAN、PHASE-*、scripts、assets）。
- 忽略：`node_modules/`、`dist/`、`out/`、`release/`、`*.db`、`*.db-wal`、`*.db-shm`、`logs/`、`docs/**/*.local.md`、`__pycache__/`、`*.pyc`。
- 永不提交：API Key、项目数据库、正文、`backups/`、`exports/`。
- 不重写历史；阶段回退用新提交，不用 `reset --hard` 覆盖已推送内容。
- 行尾：`.gitattributes` 统一 LF；模型、原生模块、数据库等二进制已标记 `binary`。

## 先读什么

按顺序读，不要跳：

1. `docs/PRD.md` — 产品定位、6 个 Agent、权限矩阵、42 个工具、闸门、数据模型。**契约以此为准。**
2. `docs/UI-DESIGN.md` — 六页布局、四分区栅格、逐拍确认条、状态矩阵。
3. `docs/DEV-PLAN.md` — 技术选型、DDL、模块边界、调用流水线、测试与验收。
4. `docs/PHASE-01` 至 `docs/PHASE-24` — 开发顺序、每阶段任务/交付物/验收/退出条件（01–10 为 M0，11–18 为 M1，19–24 为 M2）。
5. `PROGRESS.md` — 当前进度与交接。

## 开发顺序

严格按 01 → 10，不跳阶段：

```
01 骨架 → 02 数据 → 03 工具 → 04 运行时 → 05 垂直切片
→ 06 规划台 → 07 创作台 → 08 审批台 → 09 记忆台 → 10 设置/交付
```

M1：11 规模底座 → 12 场景/时间三轴 → 13 as-of → 14 重建/关系图 → 15 覆盖/影响/伏笔 → 16 分支/重开 → 17 DOCX → 18 分发/验收。

M2：19 声音/质量基线 → 20 预算/成本 → 21 路由/异构 → 22 归档/上下文成本 → 23 10 万字性能 → 24 QA/内测/验收。

- 阶段 05 是硬检查点：一拍没有端到端跑通，不进入 06。
- 每个阶段以「进入下一阶段的条件」为闸门；不满足就不进入下一阶段。
- 阶段 07 已 `done`（2026-11-14）：创作台与调度器、G2、11 状态迁移、自动模式；`LATEST_SCHEMA_VERSION = 4`；标签 `phase-07-done`。
- 阶段 08 已 `done`（2026-11-15）：审批报告、patch、G4–G6、定稿与记忆抽取入队；`LATEST_SCHEMA_VERSION = 5`；CI run `43676789043` 全绿，标签 `phase-08-done` → `4639eb9`。
- 阶段 09 已 `done`（2026-11-15）：H1–H5、`MemoryExecutor`、检索管线（vec+FTS+RRF）、记忆台与 G7；新增 `0006_memory.sql`（`LATEST_SCHEMA_VERSION = 6`）；`E2E-MEMORY-01`。CI run `43681891589` 全绿，标签 `phase-09-done` → `4fca40c`；下一阶段从 `PHASE-10-DELIVERY.md` 开工。
- 阶段 05 已通过；阶段 06 已通过；阶段 07 已通过；阶段 08 已通过；阶段 09 已通过；阶段 10 已通过（M0）；阶段 11 已通过（多项目/30 章/文件树抽屉/诊断包）；阶段 12 已通过（场景/时间三轴）；阶段 13 已通过（as-of/作者事实/上下文检查器/审批水位）；阶段 14 已通过（重建/关系图/bge 随包）；阶段 15 已通过（覆盖检查/影响分析/伏笔/跨章标脏）；阶段 16 已通过（重开定稿/分支/异构复检/章末摘要）；阶段 17 已通过（DOCX 导出/导出选项）；阶段 18 已通过（分发/审计/图标/30 章长跑）。
- 阶段 19 已通过（声音度量/漂移告警/质量基线）；阶段 20 已通过（双预算/成本报表）；阶段 21 已通过（显式故障切换/异构默认值校准）；阶段 22 已通过（非事实类归档/上下文成本）；阶段 23–24 为 M2 计划，状态为 `todo`；不把计划文档当已交付。

## 不能违反的规则

- **6 个 Agent**：`planner` / `orchestrator` / `character` / `narrator` / `reviewer` / `memory`。没有第 7 个。
- **单一写入者**：正文只由 `DocController` 写；记忆/世界状态只由 `MemoryExecutor` 写；其他模块只能提案。
- **工具是唯一能力出口**：未注册或未授权的工具等于不存在；身份由运行时注入，不放进 `input_schema`；角色实例不能传 `character_id`。
- **审批不改定稿**：审批只有报告与 patch 提案权；定稿只能由作者触发 G6；G5/G6/G7 是一次性令牌，G1 是长期授权。
- **正文与轨迹分离**：只有 `body` 进上下文与稿件；`trace` / `grounding` 只进 UI 与归档。
- **默认逐拍**：自动模式必须显式开启，并只在出口条件、预算、角色拒演、分镜耗尽处停。
- **记忆只从定稿抽取**：台词不能写成客观事实；不物理删除，只软失效。
- **声音只告警**：`voice_metric` 是派生数据，不进 L0–L3 与系统提示词、不写正文、不建 revision；`voice` 不在 `BLOCKING_ISSUE_TYPES`，G6 不受影响。
- **故障切换只按显式配置**：备用家由作者在设置里指定；`auth` / `content_filter` / `protocol` / `context_overflow` 永不切换；切换只发生在回合开始前，同一拍不中途换模型，job 绑定快照不被改写。
- **不做**：导入旧稿/大纲、多人协作、云同步、macOS/Linux 正式支持、插件/MCP、自动发布。

## 工程约定（代码初始化后）

- 栈：pnpm + TypeScript `strict` + Electron + electron-vite + React 19 + Zustand + CSS Modules。
- 进程：`main` 拥有 SQLite、文件、模型调用；`renderer` 只做 UI，只能走 preload 的 `window.noryth`。
- 数据：better-sqlite3 + 手写 SQL 迁移 + Kysely；向量用 sqlite-vec（失败则 BLOB + 余弦）；嵌入用本地 ONNX。
- 契约：Zod 是唯一真源；工具 manifest 生成 `docs/tools/*.json`，CI 与 PRD §4.10 比对。
- 测试：Vitest + Playwright（`_electron`）+ 假 LLM 服务器；CI 不调用真实 API。
- 目录：`src/main`、`src/preload`、`src/renderer`、`src/shared`、`tests`、`scripts`；依赖边界由 `dependency-cruiser` 强制。
- 命令以 `package.json` scripts 为准；不要凭空写不存在的命令。
- CI：提交门是 `verify` + `e2e`（分两片 `--shard=1/2`、`2/2`）；性能、混沌与 30 章长跑走 `nightly.yml`，不进每次提交。e2e 偶发「无失败用例的静默早退」属 runner 侧（见 PROGRESS「当前阻塞」），失败 job 里有内存/事件日志诊断，不要用空提交反复试探。

## 修改文档的规则

- PRD / UI-DESIGN 是契约。改契约先改 PRD 变更记录，再改代码与阶段计划。
- 改范围 → 同步 `DEV-PLAN.md` §12.5 砍单清单与 §16 验收表。
- 改工具 → 更新 manifest、`docs/tools/*.json`、`check_tool_spec.py`。
- 不要提交 API Key、正文、项目数据库、`backups/`、`exports/`。

## 常用入口

| 想做什么 | 看 |
|---|---|
| 确认某个 Agent 能不能写 | `PRD.md` §4.3 权限矩阵 |
| 确认某个工具的参数/授权 | `PRD.md` §4.10 + 对应 manifest |
| 改表结构 | `DEV-PLAN.md` §5.5 DDL + 迁移文件 |
| 改工具调用顺序 | `DEV-PLAN.md` §6.4 |
| 改拍/章状态 | `PRD.md` §6.5 + `DEV-PLAN.md` §8.1 |
| 改审批/patch | `DEV-PLAN.md` §9.3–§9.5 |
| 改记忆抽取/检索 | `DEV-PLAN.md` §10 |
| 改 UI 栅格 | `UI-DESIGN.md` §2.2 + `check_ui_spec.py` |
| 当前阶段任务 | `docs/PHASE-0X-*.md` §4 |
| 当前进度/交接 | `PROGRESS.md` |

## 完成标准

一个任务算完成，必须同时满足：

1. 代码 + 单测/契约测试；关键路径有集成测试。
2. 涉及契约（工具、IPC、schema）→ 生成物更新且 `gen:check` 通过。
3. 涉及 UI 状态 → 加入状态矩阵 fixture。
4. 新增错误码 → 进 `errors.ts` 与 `DEV-PLAN.md` §18.2 文案表。
5. 没有 `TODO` / `FIXME` 进主干；确需后置 → 建 issue 并标里程碑。
6. 提交说明写清：改了什么、怎么验证、对铁律的影响（无影响也写「无」）。
