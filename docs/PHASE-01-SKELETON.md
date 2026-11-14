# 阶段 01 · 骨架与可运行外壳

> 阶段 1 / 10 ｜ 依赖：无 ｜ 下游：02–10
> 对应：`docs/DEV-PLAN.md` §3、§4、§11.1、§12.3（S1–S4、A1–A6、B1、B6）
>
> **一句话目标**：在写任何业务功能之前，先证明「Electron 能打包、SQLite 能落盘、IPC 能隔离、三档栅格能成立」，并让空项目能创建、打开、只读加锁。

## 0 十阶段总览

| 阶段 | 文档 | 核心 |
|---:|---|---|
| 1 | [骨架与可运行外壳](PHASE-01-SKELETON.md) | spike、IPC、DB、栅格、项目创建 |
| 2 | [数据层与状态权威](PHASE-02-DATA.md) | repos、seq、revision、outbox、备份 |
| 3 | [工具层与授权边界](PHASE-03-TOOLS.md) | 42 manifest、36 实现、闸门、幂等 |
| 4 | [模型适配与运行时](PHASE-04-RUNTIME.md) | SSE、上下文预算、信封、grounding |
| 5 | [垂直切片](PHASE-05-SLICE.md) | 假模型跑通一拍，集成检查点 |
| 6 | [规划台与 G1](PHASE-06-PLANNING.md) | 蓝图、角色卡、建库、隔离 |
| 7 | [创作台与调度器](PHASE-07-WRITING.md) | 分镜、状态机、DSL、逐拍/自动 |
| 8 | [审批台与定稿](PHASE-08-REVIEW.md) | 报告、patch、G5/G6 |
| 9 | [记忆台与 G7](PHASE-09-MEMORY.md) | 抽取、提案、apply、检索 |
| 10 | [设置、测试与 M0 交付](PHASE-10-DELIVERY.md) | 两家预设、E2E、混沌、NSIS |

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | sqlite-vec 能在 Electron main 与安装包里加载 | S1：dev + NSIS 双环境 `loadExtension` |
| 2 | 本地嵌入能离线跑、冷启动可接受 | S2：worker 冷启动 < 1.5s，单条 < 120ms |
| 3 | 两家预设都能流式 + 工具调用 | S3：至少两家完整拼装正文、`tool_calls`、`usage` |
| 4 | NSIS 安装/卸载/更新检查不阻塞 | S4：干净 Windows 10/11 各测一次 |
| 5 | renderer 拿不到文件与 Key | 依赖规则 + CSP + IPC 白名单 |
| 6 | 1280/1440/1600 的栅格能按 token 复现 | 生成 `grid.generated.ts`，三档误差 ≤1px |

## 2 范围

### 2.1 做

- S1–S4 四个技术 spike（结论写 ADR）。
- A1–A6：脚手架、窗口/单实例/项目锁、IPC、设计 token 与外壳、命令面板/浮层、日志与诊断。
- B1：迁移器 + `0001_init.sql` 全量 DDL（只建表，不写业务 repo）。
- B6：新建/打开项目后端（G0），只依赖 `project` 表与目录创建。
- 42 个工具 manifest 空壳（name/version/actors/side_effect），以及 `check_tool_spec.py` 第一版；实现细节归入阶段 03 的 C5。
- 给 `check_ui_spec.py` 加 `--emit-json`，生成 `src/shared/layout/grid.generated.ts`；实现细节归入 A4。

### 2.2 不做（明确交给后续阶段）

- 蓝图、创作、审批、记忆四个页面：阶段 06–09。
- 完整 repos、`seq`/revision/outbox：阶段 02。
- 42 个工具实现、授权与闸门：阶段 03。
- 模型适配器、上下文装配、Agent 提示词：阶段 04。
- 实时 API 调用的正式 UI；本阶段只跑 spike 脚本。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| Electron 三入口 | `src/main/index.ts`、`src/preload/index.ts`、`src/renderer/app/main.tsx` | `pnpm dev` 起窗；生产构建可启动 |
| IPC 契约 | `src/shared/schema/ipc.ts`、`src/main/ipc/router.ts` | 未注册通道拒绝；参数 Zod 校验 |
| 窗口与锁 | `src/main/window.ts`、`src/main/lock.ts` | 双开同项目第二窗口只读 |
| 栅格 token | `src/shared/layout/grid.generated.ts`、`src/renderer/styles/tokens.css` | 1280/1440/1600 与脚本一致 |
| 迁移器与 DDL | `src/main/db/migrator.ts`、`src/main/db/migrations/0001_init.sql` | 空目录可建库；`schema_version=1` |
| 项目创建/打开 | `src/main/project/create.ts`、`open.ts` | 建五个子目录；写 G0；路径失效可重定位 |
| 日志与诊断 | `src/main/observability/*` | 日志无 Key、无正文；诊断包可导出 |
| ADR | `docs/adr/0001-vector.md`、`0002-editor.md`、`0003-providers.md` | spike 结论与回退方案写清 |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| S1 | sqlite-vec 在 Electron 与打包产物中加载 | — | dev 与 NSIS 均可查询；20k 条 P95 < 80ms |
| S2 | ONNX 嵌入 worker 冷启动与吞吐 | — | 冷启动 < 1.5s；单条 < 120ms；512 维 |
| S3 | 两家预设 SSE + 工具调用增量 | — | 正文、`tool_calls`、`usage` 均能拼装 |
| S4 | NSIS + 自动更新冒烟 | A1 | 安装、启动、卸载；更新失败不阻塞 |
| A1 | 脚手架：electron-vite、TS strict、ESLint、dependency-cruiser、CI 骨架 | — | `pnpm dev`/`build`/`lint`/`typecheck` 可跑 |
| A2 | 窗口、单实例、项目锁、只读第二窗口 | A1 | 写 IPC 在 main 侧被拒，不靠 UI 禁用 |
| A3 | IPC 路由 + preload 命名空间 + 统一错误封装 | A1 | 非法参数 `invalid_args`；renderer 无原始异常 |
| A4 | 设计 token、`AppShell`、三档栅格、导航、状态栏 | A1 | 三档误差 ≤1px；正文列 32–42 字/行 |
| A5 | 命令面板、toast、对话框、焦点管理 | A4 | Esc 归位；定稿命令走确认框 |
| A6 | 日志、诊断包、设置存储 | A1 | 日志无 Key/正文；诊断包不含正文 |
| B1 | 迁移器 + `0001_init.sql` 全量 DDL + checksum | A1 | 三个空目录均可迁移；checksum 改动即失败 |
| B6 | 新建/打开项目后端（G0） | B1 | 目录校验、空目录回滚、G0 记录 |

## 5 实现要点

### 5.1 进程与 IPC

- `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；preload 只暴露命名空间方法，不暴露通用 `invoke(channel, ...)`。
- 每个 handler 入口 `schema.parse`；错误统一 `{ ok:false, error:{ code, message } }`，不把异常抛给 renderer。
- 流式事件统一 `event:<domain>.<name>`，带 `{ jobId, turnId, seq }`；本阶段只做骨架，不做流式业务。

### 5.2 项目锁

- `<project>/.noryth.lock` 写 `{pid, host, windowId, appVersion, heartbeatAt}`，心跳 5s。
- 判定过期：进程不存在或心跳 > 30s；残留锁启动时自动接管并记 `lock_recovered`。
- 只读窗口的写入在 main 的 IPC 层拒绝，返回 `project_locked`。

### 5.3 栅格

- `check_ui_spec.py --emit-json` 输出 `GRID/BREAKPOINTS/PROSE`，`scripts/gen-layout.mjs` 生成 TS。
- `AppShell` 用 `gridTemplateColumns: ${nav}px ${sessions}px 1fr ${tree}px`；组件不写死宽度。
- CI 重新生成后 diff 必须为空；Playwright 三档量 `getBoundingClientRect()`。

### 5.4 迁移与 DDL

- `_migration(version, name, checksum, applied_at)`；每个文件首行 `-- name:`。
- 迁移在事务内执行；已应用文件被改动 → `migration_checksum_mismatch`。
- `PRAGMA journal_mode=WAL`、`foreign_keys=ON`、`synchronous=NORMAL`、`busy_timeout=5000`。

### 5.5 新建项目（G0）

1. 校验父目录、空目录或可创建、写权限、路径 < 180 字符、磁盘 ≥ 200MB。
2. 建 `noryth.db`、`manuscript/`、`assets/`、`exports/`、`backups/`、`logs/`。
3. 写 `project` 行与 `gate_record(G0)`；失败只回滚本次创建的目录。
4. 同步盘（OneDrive 等）给警告：WAL 与同步冲突会导致 `file_conflict`。

## 6 验收清单

- [x] S1：dev 与 NSIS 安装包都能 `loadExtension`，20k 条查询 P95 < 80ms（实测 33.64ms）。
- [x] S2：嵌入 worker 冷启动 < 1.5s，单条 < 120ms，维度 512（实测 377ms / 2ms / 512）。
- [x] S3（2026-11-14 收口）：DeepSeek `deepseek-flash` 已实测流式正文、工具调用与 usage；作者决定 M0 以一家收口，第二家顺延到阶段 04 D1 前补测（见 ADR-0003）。
- [x] S4：NSIS 安装、启动、建项目、卸载通过（Windows 11 本机；Windows 10 干净机未测，见 BACKLOG）。
- [x] `pnpm dev` 起窗；1280/1440/1600 三档与生成 token 误差 ≤1px（E2E 实测 ≤1px）。
- [x] 未过 G1 时创作/审批/记忆在导航置灰，悬停有原因（E2E 断言 aria-disabled + title）。
- [x] 新建项目：五个子目录 + `noryth.db` + `project` 行 + G0 记录（E2E + 单测）。
- [x] 打开项目：schema 更高只读；路径失效可重新定位（单测覆盖）。
- [x] 双开同项目：第二窗口只读，写 IPC 返回 `project_locked`（E2E 实测）。
- [x] `dependency-cruiser` 能拦住 renderer import `node:fs`（临时探针实测 exit 1）。
- [x] 日志与诊断包中搜不到 Key 与正文（单测 + E2E 诊断包断言）。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| better-sqlite3 ABI 不匹配 | 启动报 `NODE_MODULE_VERSION` | `electron-rebuild` + `npmRebuild`；锁 Electron 版本 |
| sqlite-vec 打包后找不到 | `no such module` | Plan B：BLOB + 进程内余弦（§5.6） |
| ONNX 模型太大/太慢 | 安装包 > 250MB 或首查 > 2s | 换更小模型或 q4；懒加载 + warmup |
| NSIS 更新不可达 | GitHub 下载失败 | 手动安装包；自动更新降级到 M1 |
| 栅格与脚本漂移 | 三档误差 > 1px | 以脚本为唯一真源，组件只读 token |

## 8 进入下一阶段的条件

1. S1/S2 有明确结论（采用或切 Plan B），并写进 ADR。
2. `0001_init.sql` 在三个空目录上重复迁移成功，checksum 校验生效。
3. 新建/打开项目可重复执行；G0 记录可查。
4. 双开只读、IPC 白名单、依赖边界三条安全断言通过。
5. Windows CI 上 `install + lint + typecheck + build` 绿。
