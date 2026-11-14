# PROGRESS

> 跨会话记忆。每个任务完成或阶段结束时更新；只写状态、决策、阻塞、交接，不写流水账。

## 阶段状态

| 阶段 | 文档 | 状态 | 已完成 | 验收 | 已知问题 |
|---:|---|---|---|---|---|
| 01 | `docs/PHASE-01-SKELETON.md` | done | A1–A6、B1、B6、S1–S4、42+8 工具清单外壳、CI 实跑 | 全部通过：本地门禁 + CI run `43585776532` | 第二家供应商顺延阶段 04；Win10 干净机未测 |
| 02 | `docs/PHASE-02-DATA.md` | done | B2–B5、0002 迁移、13 类 repos（Kysely）、seq/hash/revision、outbox/mirror、backup、verify、fixture、57 个 DB 单测、CI 实跑 | 全部通过：本地门禁 + CI run `43589148557`（verify + e2e 均绿） | 备份与镜像调用点留阶段 07/10 |
| 03 | `docs/PHASE-03-TOOLS.md` | done | C1–C7：42 manifest / 36 实现 / 6 开关、授权解析、九步流水线、闸门/幂等/审计、36×6 契约 harness | 全部通过：本地门禁 + CI run `43591949465`（verify + e2e 均绿） | 工具日志面板未做（可选）；T31/T33/T34 提案暂存 `tool_call.result_json`，阶段 06 接草案表 |
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
- `pnpm test:unit`（391 个：unit 156 + contract 235） / `pnpm test:e2e`（5 个）
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
| S3 供应商 | DeepSeek 已实测（`deepseek-flash`） | 非流式/流式/工具调用/401 全通过；作者决定 M0 一家收口，第二家顺延阶段 04 |
| S4 NSIS | 安装/启动/卸载 | 通过；自动更新尚未接入，启动不阻塞 |
| CI | GitHub Actions run `43585776532`（`ab778c4`） | verify + e2e 均绿；文档提交 run `43586034694` 也绿 |
| 阶段标签 | `phase-01-done` → `ab778c4` | 已推送 origin |

## 验证记录（阶段 02，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 依赖边界 | `pnpm depcruise` | 87 modules / 299 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 | `pnpm test:unit` | 101 passed（其中 DB 57） |
| E2E | `pnpm test:e2e` | 5 passed |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 通过（51 工具清单 + grid） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS |
| 迁移升级 | `tests/unit/db/migration-upgrade.test.ts` | 0001 项目先备份再升 0002；outbox 新列存在 |
| C1–C9 | `tests/unit/db/constraints.test.ts` | 9 条约束均有失败用例 + 通过用例 |
| hash | `tests/unit/db/hash.test.ts` | 固定 fixture 双跑一致；换序变化；CRLF 归一 |
| 一次拍提交 | `tests/unit/db/revision.test.ts` | 清单仍 24 行；beat +1；revision +1；hash 可复算 |
| outbox/镜像 | `tests/unit/db/outbox.test.ts` | 外部改动 `file_conflict` 不覆盖；重启重试成功；退避生效 |
| 备份/恢复 | `tests/unit/db/backup.test.ts` | `VACUUM INTO` 可打开；日备份；恢复后 `db.verify()` 全绿 |
| 30 章性能 | `tests/unit/db/perf.test.ts` | 720 拍 / ≥120k 字；打开约 400ms（< 800ms） |
| 正文单写 | `tests/unit/db/body-writer.test.ts` | 只有 `db/repos/beat.ts` 通过 Kysely 插入/更新 beat；无原生 `UPDATE beat ... body` |
| Kysely | `package.json` + `src/main/db/{kysely,schema}.ts` | 全部 repos 走 Kysely builder；101 unit 全绿 |
| CI | GitHub Actions run `43589148557`（`37e6eed`） | verify + e2e 均绿 |
| 阶段标签 | `phase-02-done` → `37e6eed` | 已推送 origin |

## 验证记录（阶段 03，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过 |
| 依赖边界 | `pnpm depcruise` | 115 modules / 409 deps，0 违规 |
| Lint | `pnpm lint` | 通过（新增 `src/main/tools/**` 禁 fs/SQL/网络规则） |
| 单元 + 契约 | `pnpm test:unit` | 391 passed（unit 156 / contract 235） |
| 契约 harness | `tests/contract/tool-contracts.test.ts` | 36 × 6 = 216 + fixture 完整性 2 |
| 注册表 | `tests/contract/registry.test.ts` | 12 条全绿（含 allowlist 零 diff、快照不漂移） |
| memory.apply 闸门 | `tests/contract/memory-apply-gates.test.ts` | 无令牌 `gate_required` / 错实体 `stale_revision` / 重放 `duplicate` / 复用 `gate_consumed`；world_fact 写入校验 |
| 限知投影 | `tests/contract/world-limited.test.ts` | `filtered_count=1`；`as_of` 不能越过运行时水位 |
| 工具边界 | `tests/unit/tools/tool-boundaries.test.ts` | 无 better-sqlite3 / node:fs / fetch / 原生 SQL |
| 闸门令牌 | `tests/unit/tools/gates.test.ts` | 篡改/过期/错闸门/跨 job/消费/ G1 长期授权 11 条 |
| E2E | `pnpm test:e2e` | 5 passed |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| CI | GitHub Actions run `43591949465`（`4a2ff11`） | verify + e2e 均绿 |
| 阶段标签 | `phase-03-done` → `e23eca7` | 已推送 origin |

## 关键决策

| 决策 | 结论 | 记录 |
|---|---|---|
| 向量检索 | sqlite-vec Plan A；扩展随包 `resources/native/vec0.dll` | `docs/adr/0001-vector.md` |
| 编辑器 | CodeMirror 6；200 字 IME 实测留到阶段 07 | `docs/adr/0002-editor.md` |
| 供应商 | OpenAI-compatible；默认 `deepseek`；S3 待 Key | `docs/adr/0003-providers.md` |
| 嵌入模型 | bge-small-zh-v1.5 q8 / 512 维；当前 devDependency，阶段 04 进包 | `docs/adr/0004-embedding.md` |
| repos 访问 | Kysely 0.29 查询构造 + better-sqlite3 同步执行（`compile()`）；迁移/PRAGMA/VACUUM 保持原生 SQL | `src/main/db/kysely.ts`、`schema.ts` |
| outbox 扩展 | 0002 增加 `chapter_id` / `revision_id` / `next_attempt_at`；`expected_hash` = 渲染后文件 hash | `DEV-PLAN` §5.5/§5.8 已同步 |
| verify 时机 | 打开项目自动跑；error 只记日志不阻塞；镜像不一致只 warn | `src/main/project/service.ts` / `src/main/db/verify.ts` |
| 备份方式 | DB 用 `VACUUM INTO`；日备份逐项复制并排除 `backups/`、DB/WAL/lock | `src/main/db/backup.ts` |
| manifest 真源 | `defineTool` TS 定义 → `docs/tools/*.json` + `generated/*`；Vite `ssrLoadModule` 直接加载 TS，删除 `tool-catalog.json` | `src/main/tools/define.ts`、`scripts/gen-tools.mjs` |
| 授权收窄 | `selfOnly` 工具在 `character:<id>` 解析期 omit `character_id` 并注入身份 | `src/main/tools/resolve.ts` |
| 闸门消费 | 校验不消费；job 成功提交后调用 `consumeGate`；G1 长期授权不消费 | `src/main/tools/gates.ts` |
| 提案持久化 | T31/T33/T34 目前由幂等层把提案结果存 `tool_call.result_json`；专用草案表留阶段 06 | 阶段 06 交接 |
| memory.apply | 阶段 03 工具 handler 经 repos 直接写记忆/世界状态；阶段 09 换 `MemoryExecutor` 服务 | 阶段 09 交接 |

## 当前阻塞

- 无。阶段 03 已 `done`：本地门禁全绿 + CI run `43591949465`（verify 与 e2e 均通过），标签 `phase-03-done` 打在 `e23eca7`。

## 下一阶段交接

- 阶段 03 已 `done`（`phase-03-done` = `e23eca7`）；阶段 04 可直接开工。
- 阶段 04 直接复用：`buildRegistry(ALL_MANIFESTS)` 取快照；`resolveToolset(agentKey, policy, snapshot)` 生成有效工具集；`invokeTool(intent, TurnContext, deps, services)` 执行九步流水线。
- `TurnContext` 需要 phase 04 从 job 构造：`chapterId` / `beatId` 来自 `job.payload_json`，`mode` 来自运行模式，`asOf` 来自 `project.seq_head` 或章 `covered_until_seq`；`toolset_version` 写入 job / `turn_metric`。
- 一次性令牌只在 job **成功提交后**调用 `consumeGate(repos, token)`；G5/G6/G7 的令牌签发 UI 在阶段 06–09 接。
- 待决：T31/T33/T34 的提案目前没有专用表，结果落在 `tool_call.result_json`；阶段 06 规划台需要草案持久化时先加迁移（0003）再改 manifest。
- `memory.apply` 阶段 03 直接经 repos 写 `memory_entry` / `world_fact` / `character_belief`；阶段 09 换成 `MemoryExecutor` 后工具 handler 只做参数适配。

## 更新规则

1. 完成一个任务：更新对应阶段的「已完成」。
2. 阶段结束：填「验收」与「已知问题」，状态改 `done`。
3. 出现阻塞：状态改 `blocked`，写清缺什么、等什么。
4. 新会话开始：先读本文件，再读阶段文档。
5. 不把「写了代码」写成 `done`；只有验收清单全绿才是 `done`。
