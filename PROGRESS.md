# PROGRESS

> 跨会话记忆。每个任务完成或阶段结束时更新；只写状态、决策、阻塞、交接，不写流水账。

## 阶段状态

| 阶段 | 文档 | 状态 | 已完成 | 验收 | 已知问题 |
|---:|---|---|---|---|---|
| 01 | `docs/PHASE-01-SKELETON.md` | in_progress | A1–A6、B1、B6、S1、S2、S4；42+8 工具清单外壳 | 本地门禁全绿；S3 未执行 | S3 缺两家 API Key；Windows CI 未实跑 |
| 02 | `docs/PHASE-02-DATA.md` | todo | — | — | 等 01 收口 |
| 03 | `docs/PHASE-03-TOOLS.md` | todo | — | — | 等 01 收口 |
| 04 | `docs/PHASE-04-RUNTIME.md` | todo | — | — | — |
| 05 | `docs/PHASE-05-SLICE.md` | todo | — | — | 硬门：未通过不得进入 06 |
| 06 | `docs/PHASE-06-PLANNING.md` | todo | — | — | — |
| 07 | `docs/PHASE-07-WRITING.md` | todo | — | — | — |
| 08 | `docs/PHASE-08-REVIEW.md` | todo | — | — | — |
| 09 | `docs/PHASE-09-MEMORY.md` | todo | — | — | — |
| 10 | `docs/PHASE-10-DELIVERY.md` | todo | — | — | — |

状态：`todo` / `in_progress` / `blocked` / `done`。

## 当前可运行命令

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm typecheck` / `pnpm lint` / `pnpm depcruise`
- `pnpm test:unit`（44 个） / `pnpm test:e2e`（5 个）
- `pnpm gen:layout` / `pnpm gen:tools` / `pnpm gen:check`
- `python docs/scripts/check_ui_spec.py` / `python docs/scripts/check_tool_spec.py`
- `pnpm pack`（win-unpacked） / `pnpm dist`（NSIS）
- `pnpm prepare:native`（sqlite-vec DLL → resources/native，已挂 postinstall）

## 验证记录（阶段 01）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 依赖边界 | `pnpm depcruise` | 58 modules / 142 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 | `pnpm test:unit` | 44 passed |
| E2E | `pnpm test:e2e` | 5 passed（外壳/栅格、向导建项、双开只读、错误码、诊断包） |
| 栅格 | `python docs/scripts/check_ui_spec.py` | PASS（1280/1440/1600 与生成 token 一致） |
| 工具清单 | `python docs/scripts/check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 生成物 | `pnpm gen:check` | 通过（51 个工具 JSON + grid.generated.ts） |
| 构建 | `pnpm build` | 通过 |
| 打包 | `pnpm dist` | `release/Noryth-0.1.0-setup.exe`（131.9MB） |
| 安装冒烟 | 静默安装 → 启动 → 建项目 → 卸载 | 通过（安装目录与注册表项均清理） |
| S1 向量 | Electron dev + 打包产物 | `vec0.dll` 可加载；20k 条 P95 33.64ms |
| S2 嵌入 | utilityProcess + ONNX q8 | 冷启动 377ms / 单条 2ms / 512 维 |
| S3 供应商 | DeepSeek 已实测（`deepseek-flash`） | 非流式/流式/工具调用/401 全通过；第二家待测 |
| S4 NSIS | 安装/启动/卸载 | 通过；自动更新尚未接入，启动不阻塞 |

## 关键决策

| 决策 | 结论 | 记录 |
|---|---|---|
| 向量检索 | sqlite-vec Plan A；扩展随包 `resources/native/vec0.dll` | `docs/adr/0001-vector.md` |
| 编辑器 | CodeMirror 6；200 字 IME 实测留到阶段 07 | `docs/adr/0002-editor.md` |
| 供应商 | OpenAI-compatible；默认 `deepseek`；S3 待 Key | `docs/adr/0003-providers.md` |
| 嵌入模型 | bge-small-zh-v1.5 q8 / 512 维；当前 devDependency，阶段 04 进包 | `docs/adr/0004-embedding.md` |

## 当前阻塞

- **S3**：DeepSeek 已通过（`deepseek-flash`，2026-11-14）；还缺第二家（DashScope `qwen-plus` 或 Moonshot）。清单见 `docs/adr/0003-providers.md`；Key 不进仓库、不进应用。回填第二家后关闭。

## 下一阶段交接

- 阶段 02 的依赖已就绪：迁移器（checksum / 事务 / 重入）、`openDatabase`、项目锁、`projects.json` 登记、错误模型、`IpcResult`。
- 阶段 02 会替换 `src/main/project/service.ts` 里内联的 project 表 SQL 为 `db/repos`，并补齐 outbox/backup/verify；不要改 `0001_init.sql`（改了就 checksum mismatch，必须新增迁移）。
- `docs/tools/*.json` 目前 `contract_complete=false`；阶段 03 C5 补 schema 并保留工具名与 actors 不变（`check_tool_spec.py` 会拦）。
- 阶段 01 未做：自动打开上次项目、应用图标、诊断 zip、Windows CI 实跑（见 `docs/BACKLOG.md`）。

## 更新规则

1. 完成一个任务：更新对应阶段的「已完成」。
2. 阶段结束：填「验收」与「已知问题」，状态改 `done`。
3. 出现阻塞：状态改 `blocked`，写清缺什么、等什么。
4. 新会话开始：先读本文件，再读阶段文档。
5. 不把「写了代码」写成 `done`；只有验收清单全绿才是 `done`。
