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
- M1 阶段文档已建（2026-11-15）：`docs/PHASE-11-SCALE.md` 至 `docs/PHASE-18-DELIVERY-M1.md`；阶段 11–13 已 `done`，其余 `todo`；阶段顺序与任务 ID 见 `docs/DEV-PLAN.md` §12.4 / §12.6。
- 阶段 11 已 `done`（2026-11-15）：M1-12 多项目切换（`project.busy` 探针 + `cancelRunning` + 切换确认框 + 事件按 projectId 丢弃）、M1-9 章节摘要 + `VirtualList` + `PERF-M1-01`、M1-16 文件树抽屉（Ctrl B，320 overlay + 焦点陷阱）、M1-24 `openLastProject` + 诊断包 zip；`E2E-M1-SWITCH-01`、`E2E-M1-TREE-01`。未改 schema（`LATEST_SCHEMA_VERSION = 7`）；0008 从阶段 12 开始。CI run `43700004809` 全绿；标签 `phase-11-done` → `c2ef570`。
- 阶段 12 已 `done`（2026-11-15）：M1-1 场景库（链接/解链/排序/fork/删除）、M1-2 时间三轴、T23 `timeline.query`、verify `scene_cross_chapter_beats`；新增 `0008_story_time.sql`（`LATEST_SCHEMA_VERSION = 8`）。标签 `phase-12-done` → `374578b`。
- 阶段 13 已 `done`（2026-11-15）：M1-3 as-of 投影 + 世界时间线、M1-18 作者事实编辑器（`applyAuthorFact`）、M1-17 上下文检查器（`turn_metric.context_json`）、M1-19 审批/检索 as-of 边界（review 用 `covered_until_seq`）；`world.projection` / `world.fact.add` / `world.fact.close` / `write.context`；`E2E-M1-ASOF-01`、`E2E-M1-CONTEXT-01`。未改 schema（`LATEST_SCHEMA_VERSION = 8`）；CI run `43714545719` 全绿，标签 `phase-13-done` → `3f82a16`。
- 阶段 14 已 `done`（2026-11-15）：M1-4 按章重建（`memory/rebuild.ts`、`ApplyInput.rebuild` 同事务清旧、`author_confirm`、T40 打开）、M1-5 关系图（`world/relations.ts` 确定性圆环 + as-of 回放 + 来源，记忆台第五 tab）、M1-20 bge 权重随包（q8 24MB，`pnpm verify:embed` 冷启动 134ms）+ `index.rebuild`（分批 32、可恢复、`author_confirm`）；NSIS 157MB + 安装冒烟 PASS（日志 `source=model`）；新增 `E2E-M1-REBUILD-01`、`CHAOS-09`；未改 schema（`LATEST_SCHEMA_VERSION = 8`）。
- 阶段 15 已 `done`（2026-11-15）：M1-11 覆盖检查（`plan/coverage.ts` 4 类确定性规则 + G1 阻断/开关 + 结构化标注）、M1-8 影响分析与变更流程（T29 写 `blueprint_change`、未分析不可应用、应用只标脏）、M1-10 伏笔（T22 + 记忆台第六 tab）、跨章标脏（`chapter.invalidated_at` + G2/G4 提示 + 忽略）；新增 `0009_blueprint_ops.sql`（`LATEST_SCHEMA_VERSION = 9`）；`E2E-M1-BLUEPRINT-01`、`E2E-M1-FORESHADOW-01`。
- S3 按「DeepSeek 一家」收口（`deepseek-flash` 实测），第二家供应商顺延到阶段 04 D1 前补测；见 `docs/adr/0003-providers.md`。
- `docs/` 已入库，是项目规格的一部分；不要删除、移动或重写。
- 进度与交接写 `PROGRESS.md`；阶段范围与验收以 `docs/PHASE-0X-*.md` 为准。
- 如果 `docs/` 缺失，先向用户确认，不要凭记忆补规格。
- 常用命令：`pnpm dev`、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm depcruise`、`pnpm test:unit`、`pnpm test:e2e`、`pnpm gen:check`、`pnpm pack`、`pnpm dist`。
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
4. `docs/PHASE-01` 至 `PHASE-18` — 开发顺序、每阶段任务/交付物/验收/退出条件（01–10 为 M0，11–18 为 M1）。
5. `PROGRESS.md` — 当前进度与交接。

## 开发顺序

严格按 01 → 10，不跳阶段：

```
01 骨架 → 02 数据 → 03 工具 → 04 运行时 → 05 垂直切片
→ 06 规划台 → 07 创作台 → 08 审批台 → 09 记忆台 → 10 设置/交付
```

M1：11 规模底座 → 12 场景/时间三轴 → 13 as-of → 14 重建/关系图 → 15 覆盖/影响/伏笔 → 16 分支/重开 → 17 DOCX → 18 分发/验收。

- 阶段 05 是硬检查点：一拍没有端到端跑通，不进入 06。
- 每个阶段以「进入下一阶段的条件」为闸门；不满足就不进入下一阶段。
- 阶段 07 已 `done`（2026-11-14）：创作台与调度器、G2、11 状态迁移、自动模式；`LATEST_SCHEMA_VERSION = 4`；标签 `phase-07-done`。
- 阶段 08 已 `done`（2026-11-15）：审批报告、patch、G4–G6、定稿与记忆抽取入队；`LATEST_SCHEMA_VERSION = 5`；CI run `43676789043` 全绿，标签 `phase-08-done` → `4639eb9`。
- 阶段 09 已 `done`（2026-11-15）：H1–H5、`MemoryExecutor`、检索管线（vec+FTS+RRF）、记忆台与 G7；新增 `0006_memory.sql`（`LATEST_SCHEMA_VERSION = 6`）；`E2E-MEMORY-01`。CI run `43681891589` 全绿，标签 `phase-09-done` → `4fca40c`；下一阶段从 `PHASE-10-DELIVERY.md` 开工。
- 阶段 05 已通过；阶段 06 已通过；阶段 07 已通过；阶段 08 已通过；阶段 09 已通过；阶段 10 已通过（M0）；阶段 11 已通过（多项目/30 章/文件树抽屉/诊断包）；阶段 12 已通过（场景/时间三轴）；阶段 13 已通过（as-of/作者事实/上下文检查器/审批水位）；阶段 14 已通过（重建/关系图/bge 随包）；阶段 15 已通过（覆盖检查/影响分析/伏笔/跨章标脏）。

## 不能违反的规则

- **6 个 Agent**：`planner` / `orchestrator` / `character` / `narrator` / `reviewer` / `memory`。没有第 7 个。
- **单一写入者**：正文只由 `DocController` 写；记忆/世界状态只由 `MemoryExecutor` 写；其他模块只能提案。
- **工具是唯一能力出口**：未注册或未授权的工具等于不存在；身份由运行时注入，不放进 `input_schema`；角色实例不能传 `character_id`。
- **审批不改定稿**：审批只有报告与 patch 提案权；定稿只能由作者触发 G6；G5/G6/G7 是一次性令牌，G1 是长期授权。
- **正文与轨迹分离**：只有 `body` 进上下文与稿件；`trace` / `grounding` 只进 UI 与归档。
- **默认逐拍**：自动模式必须显式开启，并只在出口条件、预算、角色拒演、分镜耗尽处停。
- **记忆只从定稿抽取**：台词不能写成客观事实；不物理删除，只软失效。
- **不做**：导入旧稿/大纲、多人协作、云同步、macOS/Linux 正式支持、插件/MCP、自动发布。

## 工程约定（代码初始化后）

- 栈：pnpm + TypeScript `strict` + Electron + electron-vite + React 19 + Zustand + CSS Modules。
- 进程：`main` 拥有 SQLite、文件、模型调用；`renderer` 只做 UI，只能走 preload 的 `window.noryth`。
- 数据：better-sqlite3 + 手写 SQL 迁移 + Kysely；向量用 sqlite-vec（失败则 BLOB + 余弦）；嵌入用本地 ONNX。
- 契约：Zod 是唯一真源；工具 manifest 生成 `docs/tools/*.json`，CI 与 PRD §4.10 比对。
- 测试：Vitest + Playwright（`_electron`）+ 假 LLM 服务器；CI 不调用真实 API。
- 目录：`src/main`、`src/preload`、`src/renderer`、`src/shared`、`tests`、`scripts`；依赖边界由 `dependency-cruiser` 强制。
- 命令以 `package.json` scripts 为准；不要凭空写不存在的命令。

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
