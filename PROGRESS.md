# PROGRESS

> 跨会话记忆。每个任务完成或阶段结束时更新；只写状态、决策、阻塞、交接，不写流水账。

## 阶段状态

| 阶段 | 文档 | 状态 | 已完成 | 验收 | 已知问题 |
|---:|---|---|---|---|---|
| 01 | `docs/PHASE-01-SKELETON.md` | done | A1–A6、B1、B6、S1–S4、42+8 工具清单外壳、CI 实跑 | 全部通过：本地门禁 + CI run `43585776532` | 第二家供应商顺延阶段 04；Win10 干净机未测 |
| 02 | `docs/PHASE-02-DATA.md` | done | B2–B5、0002 迁移、13 类 repos（Kysely）、seq/hash/revision、outbox/mirror、backup、verify、fixture、57 个 DB 单测、CI 实跑 | 全部通过：本地门禁 + CI run `43589148557`（verify + e2e 均绿） | 备份与镜像调用点留阶段 07/10 |
| 03 | `docs/PHASE-03-TOOLS.md` | done | C1–C7：42 manifest / 36 实现 / 6 开关、授权解析、九步流水线、闸门/幂等/审计、36×6 契约 harness | 全部通过：本地门禁 + CI run `43591949465`（verify + e2e 均绿） | 工具日志面板未做（可选）；T31/T33/T34 提案暂存 `tool_call.result_json`，阶段 06 接草案表 |
| 04 | `docs/PHASE-04-RUNTIME.md` | done | D1–D6：SSE/OpenAI 兼容适配器与重试、能力探测→settings、L0–L3 装配与预算裁剪、信封/grounding 校验、六角色提示词 + JSON 回退、绑定快照 + 审计；假 LLM 服务器 + 9 条 runTurn 集成 | 全部通过：本地门禁 + CI run 43595192603（verify 与 e2e 均绿） | 真实第二家供应商未补测（无 Key，见 ADR-0003）；trace 落盘与 commitBeat 留阶段 05；嵌入随包（ADR-0004）不在本阶段范围，推迟阶段 09/10 |
| 05 | `docs/PHASE-05-SLICE.md` | done | V1–V3：`commitBeat` + trace 归档 + 拍状态迁移 + 启动恢复/outbox 补发；fixture、假适配器、`#/dev/slice` 切片页；`E2E-SLICE-01` 与强杀重启 | 全部通过：本地门禁 + CI run `43597992157`（verify 与 e2e 均绿） | `verify` 的 seq 单调检查会误报「改早期拍」（ADR-0005 §4，阶段 07 修） |
| 06 | `docs/PHASE-06-PLANNING.md` | done | E1–E5：规划会话/流式/停止/重试、T42 作者选择、蓝图与角色卡草案、提案表、G1 注册与建库、覆盖检查占位；`E2E-PLAN-01/02` | 全部通过：本地门禁 + CI run `43603698391`（verify 与 e2e 均绿） | 真实供应商 Key 未接（阶段 10）；覆盖检查/影响分析仅占位（P1）；会话重命名/归档只有后端，UI 未接 |
| 07 | `docs/PHASE-07-WRITING.md` | done | F1–F7：分镜草案/G2、11 状态迁移表、出口 DSL AST、调度循环与自动模式、正文/拍卡/确认条/分镜编辑器、拒演/耗尽/预算/模型错误四类暂停；`E2E-WRITE-01/02`；新增 `0004_writing.sql`（`LATEST_SCHEMA_VERSION = 4`） | 全部通过：本地门禁全绿（unit 541 / integration 25 / e2e 11 / build / gen:check / 规格脚本）+ CI run `43609438344`（verify 与 e2e 均绿） | 真实模型未接（Key 在阶段 10）；影响分析仅 M1；分支树只有线性 revision；「上下文检查器」按钮占位 |
| 08 | `docs/PHASE-08-REVIEW.md` | done | G1–G5：报告 schema/运行/展示、维度分与 issue 定位、patch 提案+三视图+逐条决定、G5/G6 与定稿、复检维度映射+3 轮上限、版本列表与只读对比；新增 `0005_review.sql`（`LATEST_SCHEMA_VERSION = 5`）；`E2E-REVIEW-01` | 全部通过：本地门禁全绿（unit 562 / integration 29 / e2e 12 / build / gen:check / 规格脚本 / depcruise 221 modules）+ CI run `43676789043`（verify 1m19 / e2e 1m52，均绿；package 按规则跳过） | 异构复检（换模型）M1；「重新打开定稿」后端未接（DEV-PLAN §9.6）；版本对比没有分支树；报告证据是子串校验，语义越界仍为概率检测 |
| 09 | `docs/PHASE-09-MEMORY.md` | done | H1–H5：抽取（只读 final + 证据子串 + 代码级分类）、提案 UI（逐条接受/编辑/拒绝 + 来源 + 讨论）、`MemoryExecutor` 单事务 apply（文本/事实/信念/边/向量/审计 + G7）、记忆浏览与软失效、向量后隔离回归；新增 `0006_memory.sql`（`LATEST_SCHEMA_VERSION = 6`）；`E2E-MEMORY-01` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 249 modules / unit 578 / integration 32 / e2e 13 / build / gen:check / 规格脚本）+ CI run `43681891589`（verify 与 e2e 均绿；package 按规则跳过） | bge 模型与 onnxruntime 未随包（阶段 10）；当前用确定性 `hash-bigram-v1` 降级，模型名写进每条 `embedding_model`；按章重建（T40）与 as-of/关系图 M1；世界状态作者编辑器 M1；`tool_call` 审计面板阶段 10 |
| 10 | `docs/PHASE-10-DELIVERY.md` | done | I1–I4：safeStorage Key/密钥库、逐 Agent 绑定+批次审计+回滚、测试连接与计价、外观 token；J1–J6：fixture 假服务器、`E2E-M0-A` 14 步、`E2E-M0-PROVIDER`、`CHAOS-01..08`、NSIS+安装冒烟+更新检查、PERF-01、安全/无障碍/200% 缩放；导出 Markdown/TXT；新增 `0007_settings.sql`（`LATEST_SCHEMA_VERSION = 7`）；`docs/M0-ACCEPTANCE.md` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 266 modules / unit 604 / integration 35 / chaos 7 / e2e 17 / build / gen:check / 规格脚本）+ 安装冒烟 PASS（127MB NSIS） | 真实第二家供应商仍待 Key 补测；bge 权重不随包（M1，ADR-0004）；文件树抽屉未实现（M1）；Win10 22H2 未测；更新通道无发布地址 |
| 11 | `docs/PHASE-11-SCALE.md` | done | M1-12 多项目切换（`project.busy` 探针 + `project_open.cancelRunning` + 切换确认框 + 事件按 projectId 丢弃）；M1-9 章节摘要查询（2 条聚合，不再逐章读正文）+ `VirtualList`（32/8/roving）+ `PERF-M1-01`；M1-16 文件树抽屉（320 overlay + 焦点陷阱 + `project.tree`）；M1-24 `openLastProject` + `project.autoOpen` 探测（失效/锁/schema/失败回首页）+ 诊断包 zip（纯 JS store、无 Key/正文）；`E2E-M1-SWITCH-01`、`E2E-M1-TREE-01` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 274 modules / unit 620 / integration 35 / chaos 7 / e2e 21 / build / gen:check / 规格脚本 / perf 2） | 真机 30 章冷启动尚未在安装包复跑（perf 走测试夹具）；W1 常驻树暂不支持 Ctrl+B 收起 |
| 12 | `docs/PHASE-12-STORYBOARD-TIME.md` | todo | — | — | — |
| 13 | `docs/PHASE-13-ASOF-WORLD.md` | todo | — | — | — |
| 14 | `docs/PHASE-14-REBUILD-GRAPH.md` | todo | — | — | — |
| 15 | `docs/PHASE-15-COVERAGE-IMPACT.md` | todo | — | — | — |
| 16 | `docs/PHASE-16-BRANCH-LONGFORM.md` | todo | — | — | — |
| 17 | `docs/PHASE-17-DOCX-EXPORT.md` | todo | — | — | — |
| 18 | `docs/PHASE-18-DELIVERY-M1.md` | todo | — | — | — |

状态：`todo` / `in_progress` / `blocked` / `done`。

## 验证记录（阶段 10，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 266 modules / 1298 deps，0 违规 |
| Lint | `pnpm lint` | 通过（新增 scripts/install-smoke.mjs、tests/chaos/*.cjs 的 override） |
| 单元 + 契约 | `pnpm test:unit` | 604 passed |
| 集成 | `pnpm vitest run tests/integration` | 35 passed（新增 provider-settings 3） |
| 混沌 | `pnpm test:chaos` | 7 passed / 覆盖 CHAOS-01..08（事务强杀、outbox、apply、锁、写失败、更新、零丢失） |
| E2E | `pnpm test:e2e` | 17 passed（新增 `E2E-M0-A`、`E2E-M0-PROVIDER`、J6 无障碍/200% 缩放） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0007；`LATEST_SCHEMA_VERSION = 7` |
| Key 保管 | `tests/unit/settings/secrets.test.ts` | 5 条：文件无明文、末 4 位、换后端解密失败、删除、内存降级 |
| 绑定 | `tests/unit/settings/bindings.test.ts` | 5 条：继承链、批次审计、逐批回滚、重复回滚拒绝、未测试模型拒绝 |
| 设置补丁 | `tests/unit/settings/store.test.ts` | 4 条：补丁不带 default（回归）、外观浅合并、损坏文件回落、显式键 |
| 导出 | `tests/unit/doc/export.test.ts` | 4 条：revision+content_hash、批注开关、TXT 无标记、空项目拒绝 |
| fixture 服务器 | `tests/unit/fake-llm/fixture-server.test.ts` | 5 条：匹配/流式/工具/错误/repeat/目录加载 |
| 性能 | `pnpm test:perf`（`tests/perf/`，nightly） | 30 章 720 拍 14.0 万字：切章 P95 1ms、检索 P95 25ms、导出 16ms、RSS 231MB |
| 打包 | `pnpm run pack` / `pnpm run dist` | `release/Noryth-0.1.0-setup.exe` 127MB + `latest.yml`；离线打包用 `electronDist` |
| 安装冒烟 | `node scripts/install-smoke.mjs` | PASS：静默安装 → packaged=true/schema=7 → 建项目 → 安装目录 vec0 可 COUNT → 卸载 |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `5e21fce`（I1–I4）、`80d7f56`（导出+J1+设置 E2E）、`e40fb2f`（M0-A+PROVIDER+补丁回归）、`bf1df72`（J3–J6+M0 验收）、`965f0ba`/`5ae3f38`（CI 可观测性与 perf 移出提交门） | 已推送 origin/dev |
| CI | GitHub Actions run `43689085620`（`5ae3f38`） | verify 2m08（lint/typecheck/depcruise/unit 604/chaos 7/spec/gen/build）+ e2e 2m23，均绿；package 按规则跳过（非 tag） |
| 阶段标签 | `phase-10-done` → `5ae3f38` | 已推送 origin |
| 安装包 | `release/Noryth-0.1.0-setup.exe` | 127MB + `latest.yml`；`node scripts/install-smoke.mjs` PASS |

## 验证记录（阶段 11，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 274 modules / 1331 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 620 passed（新增 zip 3 / 诊断 zip 1 / 摘要 1 / VirtualList 4 / 自动打开 3 / 设置 1 / project-service 3 / chat-summary 1 等） |
| 集成 | `pnpm vitest run tests/integration` | 35 passed |
| 混沌 | `pnpm test:chaos` | 7 passed / CHAOS-01..08 |
| E2E | `pnpm test:e2e` | 21 passed（新增 `E2E-M1-SWITCH-01` 3 段、`E2E-M1-TREE-01`；诊断包 E2E 改为 zip 全文扫描） |
| 性能 | `pnpm test:perf` | PERF-01：切章 P95 1ms、检索 P95 24ms、导出 17ms、RSS 251MB；PERF-M1-01（30 章 / 720 拍 / 14 万字）：切章 P95 2ms、列表摘要 P95 1ms、RSS 146MB；含迁移与 verify 的打开 325ms（`tests/unit/db/perf.test.ts`） |
| 切换不串台 | `tests/e2e/switch.spec.ts` | A 生成并确认一拍 → 切 B（B 无章、创作台按 B 置灰、`write.state` invalid_args）→ 回 A：正文逐字相同、章状态相同、revision 计数不变 |
| 运行中切换 | 同上第 2 段 | `project.busy` 报 write；无 `cancelRunning` → `project_busy`；带 `cancelRunning` → 切成功；回 A 后 0 已确认拍、0 generating、0 半条正文、24 拍结构不变 |
| 自动打开 | 同上第 3 段 + `tests/unit/project-service.test.ts` | 正常 → 规划台；`openLastProject=false` → 首页；锁被存活进程持有 → 首页 + toast「上次项目在另一窗口打开」、无只读横幅、`project.current()` 为 null；probe 覆盖 missing/locked/ok，autoOpen 覆盖 disabled/no_last/missing/locked/ok |
| 文件树抽屉 | `tests/e2e/tree.spec.ts` | 1440×900 开抽屉：preview 与 `write-prose` 宽度逐像素不变；`role=dialog`、焦点在抽屉内；Esc 后焦点回 `tree-open`；点章节点关闭抽屉并跳创作台 |
| 虚拟列表 | `tests/unit/renderer/virtual-list.test.ts` + E2E | 1,000 行只渲染可视 + overscan（顶部 23 / 中部 31）；40 章 E2E 渲染行数 < 40；滚动 60 步无 >50ms 长任务 |
| 诊断包 | `tests/unit/observability/zip.test.ts`、`tests/unit/diagnostics.test.ts`、`tests/e2e/diagnostics.spec.ts` | zip 头 `PK\x03\x04`、CRC 逐条校验、可解压；条目 README/diagnostics.json/logs/app.log；无 `secrets.bin`/`exports/`；全文无 `sk-` 形态、无真实正文片段 |
| 启动开关 | `tests/unit/settings/store.test.ts` | `openLastProject` 默认 true；关闭后不覆盖 `lastOpenedProjectId` / `providersEnabled` |
| 章节摘要 | `tests/unit/db/chapter-summary.test.ts` | 30 章计数正确；superseded 不计入、author_edited 计入已确认；摘要行无 body/grounding 字段 |
| 状态矩阵 | `tests/unit/auto-open-states.test.ts` | 7 个 reason 全覆盖；失败类有可读文案且 key 唯一；成功/关闭/无记录静默 |
| UI 巡检 | 临时 Playwright 截图夹具（已删除） | 逐屏看首页菜单/创作台/抽屉/切换确认/设置/200%：发现并修复「场景·本章会话」被挤成 40px 条（`.write-sessions` 改 flex 分配）；200% 下 Playwright 截图会错位，改用几何 + `elementFromPoint` 断言（E2E 内已固化） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具/schema 变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |

## 当前可运行命令

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm typecheck` / `pnpm lint` / `pnpm depcruise`
- `pnpm test:unit`（620：unit+contract） / `pnpm vitest run tests/integration`（35）
- `pnpm test:perf`（PERF-01 + PERF-M1-01 基线；nightly，不进提交门）
- `pnpm test:chaos`（7 条 / CHAOS-01..08） / `pnpm test:e2e`（21）
- `node scripts/install-smoke.mjs`（安装冒烟：装 → 建项 → 卸载）
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

## 验证记录（阶段 04）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 140 modules / 535 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 462 passed（unit+integration 227 / contract 235） |
| SSE | `tests/unit/model/sse.test.ts` | 逐字符分片、CRLF、多行 data、无结尾空行 |
| 适配器 | `tests/unit/model/openai-compat.test.ts` | 12 条：正文/reasoning/工具增量/usage、401 不重试、429 与 5xx 重试 2 次、超时重试 2 次、400 上下文/内容过滤、协议错误 1 次、abort、非流式、探测 |
| 探测 | `tests/unit/model/probe.test.ts`、`settings-probe.test.ts` | 探测结果写 `settings.providers`；401→`model_auth`；Key 不落盘 |
| token/预算 | `tests/unit/context/tokens.test.ts`、`budget.test.ts` | 公式与校准；裁剪顺序；角色卡/意图不裁；溢出抛 `context_overflow` |
| 装配 | `tests/unit/context/assemble.test.ts` | 同 fixture 两次 blocks/totalTokens 完全一致；L0 脱敏；pinned/refs/recent 顺序 |
| 取材可见性 | `tests/unit/context/sources.test.ts` | 角色只拿自己的记忆；旁白只拿读者已知；as_of 受章水位约束；发言者不一致拒绝 |
| 信封 | `tests/unit/agents/validate.test.ts` | 伪造 ID→`grounding_not_returned`；quote 改写→`grounding_quote_mismatch`；字数/ speaker / degraded |
| 提示词 | `tests/unit/agents/prompts.test.ts` | 六角色各一份；system 只放 L0/L1；动态内容不改前缀 hash；回退替换契约 |
| JSON 回退 | `tests/unit/model/json-fallback.test.ts` | 解析失败重问 1 次；连续 2 次→`tool_protocol_error` |
| 绑定 | `tests/unit/model/bindings.test.ts` | 实例→角色→项目→预设；快照不漂移；审计旧/新 |
| 一拍集成 | `tests/integration/turn.spec.ts` | 9 条：工具取材→合法信封、旁白拍、探测能力冻结、伪造/改写拒绝、JSON 回退、回退 2 次失败、500 暂停、绑定不漂移 |
| 两家预设 | `tests/integration/presets.spec.ts` | DeepSeek/OpenAI 预设都能流式 + 工具调用（假服务器；真实第二家待 Key） |
| E2E | `pnpm test:e2e` | 5 passed |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| CI | GitHub Actions run `43595192603`（`cc46c10`） | verify + e2e 均绿 |
| 提交 | `cc46c10` | 已推送 origin/dev |
| 阶段标签 | `phase-04-done` → `cc46c10` | 已推送 origin |

## 验证记录（阶段 05）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 152 modules / 614 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 477 passed（unit+integration 242 / contract 235） |
| commitBeat | `tests/unit/doc/commit-beat.test.ts` | 7 条：一次提交清单 2 行 + hash 可复算 + outbox；stale revision/epoch 拒绝且零写入；空正文/跨槽位拒绝；确认推进 covered；编辑 author_edited + 后续拍 stale |
| 启动恢复 | `tests/unit/doc/recovery.test.ts` | running job + generating 拍 → interrupted；已确认拍不动；空操作 |
| fixture | `tests/unit/slice/seed.test.ts` + `status-matrix.test.ts` | 1/1/1/2/5；`db.verify` 绿；重复 seed 幂等；基线镜像 hash 一致；11 个状态全有文案 |
| 一拍集成 | `tests/integration/slice.spec.ts` | 3 条：两拍各一 revision、grounding 来自工具、trace 不含 body；伪造 grounding 两次失败→rejected 零落盘；重生成 supersede + revision +1 |
| 切片 E2E | `tests/e2e/slice.spec.ts` | `E2E-SLICE-01`：seed→2 拍→确认→重生成→编辑→重启（DB：5 revision 全复算；live=confirmed+author_edited）；强杀：`taskkill /F /T` → 重开 confirmed 保留、第二拍 interrupted、重试成功、无孤儿清单、outbox 全发布 |
| 入口隔离 | 同上 E2E + `src/main/index.ts` | `[data-nav="slice"]` 为 0；切片通道只在未打包构建注册 |
| E2E 全量 | `pnpm test:e2e` | 7 passed（原 5 + 切片 2） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `f343668` | 已推送 origin/dev |
| CI | GitHub Actions run `43597992157`（`8ab717b`） | verify + e2e 均绿 |
| 阶段标签 | `phase-05-done` → `f343668` | 已推送 origin |

## 验证记录（阶段 06，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 174 modules / 735 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 497 passed（unit+contract） |
| 集成 | `pnpm vitest run tests/integration` | 17 passed（含规划链路 1、作者选择 1、原 turn/presets/slice 15） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→0002→0003；`LATEST_SCHEMA_VERSION = 3` |
| G1 | `tests/unit/plan/g1.test.ts` | 5 条：结构/voice 阻断顺序；注册角色 + 世界初值 + 锁蓝图 + 2 私有/1 公共；重复确认不写第二条 G1；建库半失败不回滚；重试 complete |
| 草案 | `tests/unit/plan/draft.test.ts` | 4 条：字段 version +1；G1 后拒绝；层级/ord 唯一；有子节点不能删；card_version +1 |
| 提案 | `tests/unit/plan/proposals.test.ts` | 5 条：整棵树一次应用；roster 只写草案；锁定后拒绝；改卡受影响章节；未知字段丢弃 |
| 会话 | `tests/unit/plan/session.test.ts` | 4 条：停止保留文本；重试复用同一条消息（消息数不变）；无 Key → model_auth；G1 半完成修正为 failed |
| 隔离 | `tests/unit/plan/isolation.test.ts` | 5 私有 + 1 公共；跨角色 0 命中；孤儿条目使自检失败；重复建库幂等 |
| 规划链路 | `tests/integration/plan.spec.ts` / `plan-choice.spec.ts` | 假模型 + 真实工具管道：2 个提案 → 应用 → 5 角色/8 初值/2 章 → G1 → 6 命名空间；T42 选择请求经 UI 通道解析后继续本轮，审计存在 |
| 规划 E2E | `tests/e2e/plan.spec.ts` | `E2E-PLAN-01`：对话 → 应用建议 → 改 2 个动机 → voice 缺项禁用 → G1（2 章行）→ 创作台解锁；`E2E-PLAN-02`：建库失败 `setup_incomplete` → 重试 complete |
| E2E 全量 | `pnpm test:e2e` | 9 passed（原 7 + 规划 2） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:tools` / `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T31 新增 `parent_ref`/`ref`；T42 交互超时改 5 分钟） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `bbea9df` | 已推送 origin/dev |
| CI | GitHub Actions run `43603698391`（`bbea9df`） | verify 1m40 / e2e 1m11，均绿 |
| 阶段标签 | `phase-06-done` → `bbea9df` | 已推送 origin |

## 验证记录（阶段 07，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 198 modules / 898 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 541 passed（unit 306 / contract 235） |
| 集成 | `pnpm vitest run tests/integration` | 25 passed（新增 write 8） |
| E2E | `pnpm test:e2e` | 11 passed（原 9 + `E2E-WRITE-01/02`） |
| 状态机 | `tests/unit/scheduler/transitions.test.ts` | 14 条：11 个拍状态全可达、每条边可走、stale 三条出口（重跑/排队/忽略）、superseded 终态、confirmed 不能直接确认、非法迁移带 from/event/allowed；章/场景/任务表同构 |
| 出口 DSL | `tests/unit/scheduler/dsl.test.ts` | 19 条：六种节点、自然语言拒绝、纯 beats 告警、未登记实体/谓词不可判定、4 参数 rel 拒绝、深度/节点/拍数上限、fact/rel/beats 求值与 all/any/not |
| 循环判定 | `tests/unit/scheduler/loop.test.ts` | 9 条：G2 物化 + verify 全绿、硬冲突拒绝开演、按序发牌、连续重生成 3 次无孤儿/无双活、出口收束、max_beats WARN、storyboard_exhausted 不续写、预算暂停 |
| verify 修正 | `tests/unit/db/verify.test.ts` | 改为 seq 唯一 + 槽位单调；「改早期拍」不再误报（ADR-0005 §4） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→0002→0003→0004；`LATEST_SCHEMA_VERSION = 4` |
| 创作台集成 | `tests/integration/write.spec.ts` | 8 条：3 场 24 拍（前 6 拍全部确认、其中 2 拍重生成）→ 自动跑完 `draft_complete`；自动在出口处停（6/12 拍）；max_beats 收束留 WARN；编辑已确认拍 → 下游 stale → 三选一（分支/替换/重跑）；分镜耗尽暂停；拒演保留理由且不写正文；预算/无 Key 各自暂停 |
| 创作台 E2E | `tests/e2e/write.spec.ts` | `E2E-WRITE-01`：devSeed 24 拍 → 冲突时 G2 禁用并显示第一条原因 → 修好开演 → 4 确认 2 重生成 → 自动跑完，DB 24 confirmed / 0 双活；`E2E-WRITE-02`：自动在 `beats(3)` 处停，剩 3 拍 proposed |
| IME 守卫 | 同上 E2E | 编辑框填入 200+ 中文字符后按 Enter：不提交确认、字符不丢（只换行） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T34 升 1.1.0、T27 分镜 schema 增 `ord/notes/max_beats`） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `5897d51`（feat）、`11575c8`（fix） | 已推送 origin/dev |
| CI | GitHub Actions run `43609438344`（`11575c8`） | verify 1m20 / e2e 1m45，均绿；package 按规则跳过 |
| 阶段标签 | `phase-07-done` → `11575c8` | 已推送 origin |

## 验证记录（阶段 08，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 221 modules / 1060 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 562 passed（unit 327 / contract 235） |
| 集成 | `pnpm vitest run tests/integration` | 29 passed（新增 review 4） |
| E2E | `pnpm test:e2e` | 12 passed（原 11 + `E2E-REVIEW-01`） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0005；`LATEST_SCHEMA_VERSION = 5` |
| 报告契约 | `tests/unit/review/report.test.ts` | 9 条：阻断缺 beat/证据/why 降级；建议类不能阻断；verdict 反推；issue_id 重编号与去重；维度 1–5；§9.7 维度映射；落库前「拍存在 + 证据为正文子串」；已定稿拒绝；纯文本降级 |
| patch/定稿 | `tests/unit/review/patch-finalize.test.ts` | 9 条：一批 N 条只产生一个 revision 且 hash 可复算；归一化 before；不一致 → `patch_conflict` 零写入；同拍双 patch / base 变更 / 已定稿拒绝；接受+拒绝+未决定 superseded；全拒绝不建 revision；无 G6 记录 / 未勾选阻断拒绝；定稿 final 快照 + G6 payload + memory.extract 入队 + 幂等；G5/G6 令牌错实体/过期/复用 |
| 版本对比 | `tests/unit/review/diff.test.ts` | 3 条：行级 LCS 编号；空文本；槽位对齐（patch 后是「已改」而非删+加） |
| 审批链路 | `tests/integration/review.spec.ts` | 4 条：报告 fail（2 阻断/3 建议，证据为正文子串）→ 讨论不改稿 → G5 → 3 patch → 接受 2 拒绝 1 → 新 revision → 复检（scope 非空、章节 approved）→ G6 定稿 → 定稿后编辑 `already_finalized`、verify 全绿；base 变更 `stale_revision` 且显示 superseded；坏 `before` → `patch_conflict` 零写入；3 轮转人工（G5 关闭、G6 可执行）；未跑 consistency.check 的 pass → `degraded=check_missing` |
| 审批 E2E | `tests/e2e/review.spec.ts` | `E2E-REVIEW-01`：devSeed → 自动 G4（fail，2 阻断/3 建议）→ 讨论 → G5 → 3 patch → 接受 2 拒绝 1（一次执行）→ 复检（2/3 轮、scope 非空、approved）→ 版本对比 → G6 确认框 → 定稿；DB：chapter finalized、final revision 6 行、G6 已消费且 payload 含 finalRevisionId、`memory.extract` 1 条 queued、6 拍全 confirmed、2 份报告、patch applied 2 / rejected 1；定稿后 `write.edit` → `already_finalized` |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T35/T36 升 1.1.0） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `48cd5c6`（feat）、`4639eb9`（docs/agents） | 已推送 origin/dev |
| CI | GitHub Actions run `43676789043`（`4639eb9`） | verify 1m19 / e2e 1m52，均绿；package 按规则跳过 |
| 阶段标签 | `phase-08-done` → `4639eb9` | 已推送 origin |

## 验证记录（阶段 09，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 249 modules / 1218 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 578 passed（unit+contract） |
| 集成 | `pnpm vitest run tests/integration` | 32 passed（新增 memory 3） |
| E2E | `pnpm test:e2e` | 13 passed（原 12 + `E2E-MEMORY-01`） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0006；`LATEST_SCHEMA_VERSION = 6` |
| 证据校验 | `tests/unit/memory/evidence.test.ts` | 3 条：归一化、连续子串、缺拍/缺 quote/拍不在清单/非子串四种原因 |
| 分类 | `tests/unit/memory/classify.test.ts` | 6 条：台词 objective→claim、旁白/作者可 objective、claim 原样、缺角色/缺三元组丢弃、关系退化、置信度/轴/值夹紧 |
| apply | `tests/unit/memory/apply.test.ts` | 4 条：一次应用 8 记忆/3 信念/4 事实/1 边/8 向量 + 审计；重放 duplicate 不双写；中途失败全回滚（令牌未消费、决策保留）；单值事实与记忆 supersede；同一客观三元组重复提案只记已应用、不撞唯一索引 |
| 检索 | `tests/unit/memory/retrieve.test.ts` | 3 条：as_of / valid_to 在 SQL 过滤、pinned 独立、跨角色 0 命中、无嵌入器降级关键词仍命中 |
| 记忆链路 | `tests/integration/memory.spec.ts` | `E2E-MEMORY-01` 链路版：14 提案（台词→claim）→ 拒 2 改 1 → 应用 12 → 第 2 章召回 ≥1 → 隔离回归通过；初稿抽取被拒；篡改 quote 丢弃并记 `evidence_mismatch` |
| 记忆台 E2E | `tests/e2e/memory.spec.ts` | `E2E-MEMORY-01`：devSeed（第 1 章定稿 + 第 2 章已规划 + 入队）→ 自动抽取 14 → 删 2 改 1 → 全部接受 → G7 应用 12 → 角色记忆 6 / 世界事实 4（1 claim）/ 信念 3 / 关系 1 → 隔离回归 → 第 2 章召回；DB：memory_vec 6 / memory_fts 6 / G7 已消费 / memory.apply succeeded / extract job applied |
| 构建 | `pnpm build` | 通过（新增 `out/main/memory-embed-worker.js` 入口） |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T37/T39 升 1.1.0） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `4fca40c`（feat）、`f87b7dd`（docs） | 已推送 origin/dev |
| CI | GitHub Actions run `43681891589`（`4fca40c`） | verify 与 e2e 均绿；package 按规则跳过 |
| 阶段标签 | `phase-09-done` → `4fca40c` | 已推送 origin |

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
| 提案持久化 | 阶段 06 起 T31/T32/T33 写 `agent_proposal`（kind = blueprint_patch / character_card / roster），作者「应用建议」才落草案；T34 分镜仍由幂等层暂存 `tool_call.result_json`，阶段 07 接专用表 | `src/main/plan/proposals.ts`、`db/migrations/0003_planning.sql` |
| memory.apply | 阶段 03 工具 handler 经 repos 直接写记忆/世界状态；阶段 09 换 `MemoryExecutor` 服务 | 阶段 09 交接 |
| 模型适配 | 统一 OpenAI-compatible；错误归一化 `auth/rate_limit/timeout/context_overflow/server/protocol/content_filter`；429/5xx/超时重试 2 次、协议 1 次、401/400 不重试 | `src/main/model/adapter.ts`、`openai-compat.ts` |
| 模型输出 | 模型只交 `{body, grounding}`；`turn_id/speaker/trace/meta` 由运行时装配，模型无法伪造工具轨迹 | `src/main/agents/validate.ts` |
| grounding 范围 | 运行时装配的检索 refs 与工具返回 refs 都可引用；被裁掉的块不可引用（模型没看见） | `src/main/context/assemble.ts`、`tools/turn-refs.ts` |
| 预算默认 | hardCap = min(ctx×0.5, 12000)；固定层 L0 900/L1 600/卡 700/意图 160/L3 150×8；裁剪按 §7.3 顺序 | `src/main/context/budget.ts` |
| token 估算 | 唯一实现在 `context/tokens.ts`；工具截断复用，避免两套口径 | `src/main/tools/tokens.ts` |
| 绑定冻结 | job 创建时解析并写 `payload_json.bindings`（含探测能力）；`runTurn` 只查快照、不回数据库 | `src/main/agents/job.ts`、`model/bindings.ts` |
| 能力探测 | `/models` + 流式 + `tool_choice=required`（400 回退 auto）+ JSON mode 实测；contextWindow/pricing 取预设表（/models 无统一字段）；结果按预设写 `settings.providers`，Key 不落盘 | `src/main/model/probe.ts` |
| 假 LLM | Node http 服务器，按请求序列脚本化，支持流式/工具分片/错误注入；CI 不调真实 API | `tests/integration/support/fake-llm.ts` |
| commitBeat | `(chapterId, beat, expectedRevision, epoch)` 事务内写 beat/revision/清单/outbox；epoch 或 revision 不匹配即 `stale_revision`，不合并 | `src/main/doc/commit-beat.ts` |
| 生成落盘 | `runTurn` 增加可选 `commit` 回调；不注入时保持阶段 04 纯校验行为；commit 失败 job failed 且事务回滚 | `src/main/agents/turn.ts` |
| 槽位替换 | 生成/重生成都 supersede 槽位现行拍（含 proposed 占位）；正文 append-only，唯一索引靠 supersede 释放 | `src/main/doc/beats.ts` |
| trace 归档 | `logs/trace/<jobId>/<turnId>.json`，只存 thought/tool_call/grounding/meta/装配摘要，不复制 body；路径进 `beat.trace_ref` | `src/main/doc/trace.ts` |
| 启动恢复 | 打开项目时 `job.running → interrupted`、`beat.generating/regenerating → interrupted`，并补发 outbox；失败只记日志不阻塞打开 | `src/main/doc/recovery.ts`、`doc/publish.ts` |
| 重试幂等 | job 幂等键增加可选 `attempt`；同一任务重放复用 job，强杀后的重试必须换 attempt | `src/main/agents/job.ts` |
| 切片入口 | `#/dev/slice` + 未打包构建；切片 IPC 只在 `app.isPackaged === false && NORYTH_SLICE !== '0'` 注册；不进入导航 | `src/main/index.ts`、`src/renderer/app/dev/Slice.tsx` |
| 规划会话 | 独立于 `runTurn`：无 chapter/beat，自然语言输出；工具仍走同一 `invokeTool` 九步流水线；停止用 AbortSignal，重试复用同一消息行（attempt +1） | `src/main/plan/runtime.ts`、`plan/service.ts` |
| 规划草案 | `plan_character` / `plan_fact` / `outline_node` 分离；G1 前 `character` / `world_fact` 为空；应用蓝图/清单提案时 `blueprint_version + 1` | `src/main/plan/proposals.ts` |
| 注册清单 | `plan_character` 是草案；G1 由 `registerRoster` 写成正式 `character`，ID 稳定、`card_version` 继承；G1 前不注册 | `src/main/agents/roster.ts` |
| G1 锁定 | `project.blueprint_locked_at` 是锁定标记；同一事务把章节点落成 `chapter` 行（阶段 07 分镜锚点）；`setup_state=failed` 时蓝图仍锁定，只补建库；重复确认不写第二条 `gate_record` | `src/main/plan/g1.ts` |
| 命名空间 | `memory_namespace` 记录 5 私有 + 1 公共；`ensureNamespaces` 幂等；隔离自检按角色/命名空间映射核对，`isolation_verified` 写 `project.metadata_json` | `src/main/memory/namespace.ts` |
| 规划模型 | 阶段 06 用环境变量提供 Key（`NORYTH_PLAN_API_KEY` / `NORYTH_<PROVIDER>_API_KEY`）；未配置时失败为 `model_auth`；E2E 用 `NORYTH_PLAN_FAKE=1` 假适配器，生产包不认 | `src/main/plan/model.ts`、`plan/fake-adapter.ts` |
| 作者选择 | T42 经 `plan/choice` 事件与 `plan.choose` IPC 解析；选择挂起 5 分钟，停止/结束会取消全部挂起请求，工具不会悬空；超时 5 分钟（human-in-the-loop 不属于 10s 交互上限） | `src/main/plan/service.ts`、`tools/manifests/interaction.ts`、`renderer/pages/plan/ChatPane.tsx` |
| verify seq | 改为「章内唯一 + `seq_head >= max(seq)` + 同一槽位单调」；阅读顺序不再参与判定，改早期拍不误报（ADR-0005 §4） | `src/main/db/verify.ts` |
| 分镜真相 | 开演前唯一真相是 `storyboard_draft.scenes_json`；G2 才物化成 `scene`/`beat`（proposed、空正文）+ 基线 revision；改分镜不制造 revision | `src/main/scheduler/storyboard.ts`、`g2.ts` |
| 出口 DSL | 文本语法只有一份（`shared/dsl/parse`），AST 校验/求值在 `shared/dsl/exit`；`valid` 看结构与值域，`machine_decidable` 还要求实体/谓词/在场者已登记；纯 beats 标 `beats_only` 告警 | `src/shared/dsl/exit.ts`、`src/main/tools/support/dsl.ts` |
| 调度判定 | `decideNext` 先判收束（exit → max_beats → 预算），再发牌；`nextActionableBeat` 只在本场按序取拍，已收束场景不再发牌 | `src/main/scheduler/loop.ts` |
| 自动模式 | 预检（剩余拍/预估 token 与费用/max_beats/预算余额）+ 每拍边界检查；出口满足、max_beats、预算、耗尽、拒演、模型错误各自暂停；预算先于发牌 | `src/main/scheduler/auto.ts`、`service.ts` |
| 拒演 | T41 只在 commit 回调前检查：有拒演就抛 `character_refusal`，**不写正文**；暂停保留理由，不提供「强制继续」 | `src/main/scheduler/beat.ts`、`service.ts` |
| 创作台单飞 | 同项目同一时刻只允许一个生成任务；取消用 AbortSignal + `expected_revision` 拒绝迟到结果；暂停只在拍边界 | `src/main/scheduler/service.ts` |
| 编排对话 | 复用 `invokeTool` 九步流水线，只挂编排工具集；T34 通过后写草案并让 UI 切到分镜 tab；不写正文 | `src/main/scheduler/orchestrator.ts` |
| 创作台 E2E 脚手架 | `write.devSeed` 只在未打包构建注册，等价 G1 完成 + 一章 + 3×8 分镜；生产包调用返回 `invalid_args` | `src/main/ipc/router.ts`、`scheduler/service.ts` |
| 报告单一入口 | T35 与运行时兜底都走 `review/report.submitReport`：issue_id 补齐、缺 beat/证据/why 或建议类类型的阻断降级为建议、verdict 由条目反推；落库前再验「拍存在 + evidence 是正文子串」 | `src/main/review/report.ts`、`shared/schema/report.ts` |
| 确定性检查 | 没有成功跑过 `consistency.check` 的 pass/pass_with_notes 报告标 `degraded=check_missing`；schema 失败标 `schema_fallback`；都不改 verdict | `src/main/review/run.ts` |
| patch 批量落盘 | `doc/patch-apply.ts` 一次事务替换 N 拍、只产生一个 revision；`before` 归一化（NFKC/行尾空白）后必须一致；同拍多条 / base 变更 / 已定稿一律拒绝 | `src/main/doc/patch-apply.ts`、`shared/text/normalize.ts` |
| 逐条决定 | UI 先在本地收集接受/拒绝，全部选完点「执行修订」一次提交；旧 base 上的待决提案对外显示 superseded（DB 仍保留 revision_id 供审计） | `renderer/stores/review.ts`、`review/patch.ts` |
| G5/G6 令牌 | 与工具层同一套 HMAC 格式与 `gate_record`：G5 绑定 patch job、G6 绑定「章 + 当前 revision」；成功后才消费；G6 的 ack 补记回同一条记录 | `review/gates.ts`、`tools/gates.ts` |
| 定稿 | `doc/finalize.ts` 只 INSERT final revision + 复制清单；状态先 approved 再 FINALIZED；幂等；`memory.extract` 入队（queued）；`commitBeat/editBeat/generate` 对已定稿章抛 `already_finalized` | `src/main/doc/finalize.ts` |
| 未复检改动 | 从当前 revision 沿 parent 链回溯到报告 revision；只算链内 `applied_revision_id` 的 patch 与链内创建的 author_edited 拍 | `src/main/review/rounds.ts` |
| 复检范围 | `approval_report.scope_json` 存维度键；§9.7 映射（知识越界→人物+剧情、纲要对齐→纲要对齐、时间线→剧情、文笔→文笔、未分类→全维度）；T35 不知道 scope，由运行时回合后补记 | `review/rounds.ts`、`review/run.ts` |
| 3 轮上限 | 轮次 = 报告数；到 3 轮且最新仍 fail → 转人工（G5 关闭、G6 仍可执行） | `review/rounds.ts`、`review/service.ts` |
| 审计通道 | 审批是独立事件通道 `event:review`；消息存 `review_message`，不混进创作台的 `write_message` | `shared/ipc-channels.ts`、`db/migrations/0005_review.sql` |
| 审批 E2E 脚手架 | `review.devSeed` 只在未打包构建注册：G2 → 6 拍 commitBeat（confirmed）→ draft_complete；生产包返回 `invalid_args` | `review/service.ts`、`ipc/router.ts` |
| 记忆抽取 | 只读 `revision_beat`（kind='final'）清单；T37 与运行时 JSON 回退共用 `submitProposalItems`；quote 归一化子串校验，不匹配丢弃并记 `evidence_mismatch` | `memory/extract.ts`、`memory/evidence.ts` |
| 事实/信念分类 | 代码级：台词证据的 `world_fact(objective)` 改写为 `claim` 并留 downgraded；旁白/作者可 objective；缺角色或三元组丢弃 | `memory/classify.ts`、`propose.ts` T37 |
| 记忆执行器 | 先算 embedding（批量、维度校验）再单事务写 `memory_entry`+`memory_vec`+`memory_fts`+`world_fact`+`character_belief`+`relationship_edge`+审计+决策；G7 同事务消费；重放 `duplicate` | `memory/apply.ts` |
| 检索管线 | vec top30 + bigram top30 → RRF(k=60, 1.0/0.7) → 绝对下限 → 头名 40% 截断 → 文本去重 → pinned ≤5；可见性过滤在 SQL；缓存键含 project/actor/character/as_of/model | `memory/retrieve.ts`、`db/repos/memory-index.ts` |
| 嵌入降级 | 有 `resources/models/bge-small-zh-v1.5` 时 utilityProcess+bge；否则确定性 `hash-bigram-v1`（512 维）；每条 `memory_entry.embedding_model` 记真实模型，向量通道按模型过滤 | `memory/embed/**`、`docs/adr/0004-embedding.md` |
| 单值 supersede | `world_fact.single_value=1` 且 objective → 旧行 `valid_to_seq`；记忆 `supersedes_id` → 旧条目 `superseded`；关系边按 `(from,to,axis)` 关闭旧行 | `memory/apply.ts`、`db/repos/{world,memory}.ts` |
| 记忆台 IPC | `memory.state/extract/decide/decideMany/g7.issue/apply/invalidate/recall/isolation/send` + 未打包 `devSeed`；G7 令牌只在主进程签发 | `shared/schema/memory.ts`、`ipc/router.ts` |
| 软失效 | 「标记错误」只写 `status='inactive'` + `memory_audit`；不物理删除；按章重建 M1 禁用 | `memory/apply.ts`、`memory/service.ts`、`MemoryBrowser.tsx` |

| Key 保管 | 主进程 safeStorage（DPAPI）加密写 `secrets.bin`，文件只有密文 + 末 4 位；没有可用后端时退化为内存保管（不写明文）；环境变量只做兜底 | `settings/secrets.ts`、`settings/safe-storage.ts`、`model/keys.ts` |
| 绑定批次 | 一次「保存绑定」= 一批（`model_binding_audit.batch_id`）；`binding_rollback` 保证同一批只回滚一次，回滚是撤销栈；绑定前必须「该供应商已通过测试连接」 | `settings/service.ts`、迁移 `0007_settings.sql` |
| 设置补丁 | 补丁 schema 显式写、不带 `.default()`：`SettingsSchema.partial()` 会把 `providers` 覆盖成 `{}`，一次打开项目就清空探测快照（阶段 10 修，附回归测试） | `shared/schema/project.ts`、`shared/schema/settings.ts` |
| 导出 | `doc/export.ts` 只读：Markdown/TXT 到 `exports/`，文件带 revision 与 content_hash；「正文 + 批注」附最近一份审批建议；不产生 revision | `doc/export.ts`、IPC `export.run` |
| 测试连接 | 复用 `probe()`（/models + 流式 + tool_choice + JSON mode）；成功写能力快照，失败给错误码 + 建议（auth/限流/网络） | `settings/service.ts`、`model/probe.ts` |
| 假模型 fixture | 按 `agent` / `beat` / `model` / 子串匹配，可注入流式、工具、usage、延迟、HTTP 错误与一次性响应；JSON 而非 YAML（不引解析依赖） | `tests/fake-llm/server.ts` |
| 混沌 | 真子进程在事务中被 `taskkill /F`；SQLITE_BUSY（busy_timeout 5s）统一映射 `project_locked`；更新检查失败只记日志 | `tests/chaos/*`、`db/busy.ts`、`update.ts` |
| 打包 | `electronDist: node_modules/electron/dist` 离线打包；`resources/native` + `resources/models` 走 extraResources；`npmRebuild: false`（N-API prebuild） | `electron-builder.yml`、`scripts/install-smoke.mjs` |
| 外观 | 主题/强调色/字号/行距只写 `<html data-*>` 与 CSS 变量；正文用 `--prose-size` / `--prose-leading`，导出不受影响 | `lib/theme.ts`、`styles/tokens.css` |
| 项目切换 | 单窗口单项目：`project.busy()` 先探测；无 `cancelRunning` 时 main 直接回 `project_busy`；确认后 `write.abortAllAndWait()` + `plan.abortAllAndWait()` 等任务退出再关库；审批/记忆这类不可取消的任务一律拒绝切换 | `ipc/router.ts`、`scheduler/service.ts`、`plan/service.ts` |
| 跨项目事件 | 事件 payload 带 `projectId`；write/review/memory 的 `applyEvent` 先比 `projectId` 再比 `chapterId`，切库后迟到的 delta 一律丢弃 | `renderer/stores/*.ts` |
| 章节列表 | 新增 `chapter.listSummaries`：两条聚合查询（章+拍计数、场计数），不加载任何正文；`WriteChapterSummary` 增 `wordCount`。30 章时 `state()` 不再把 14 万字读进内存 | `db/repos/chapter.ts`、`scheduler/service.ts` |
| 虚拟列表 | 自写 `VirtualList`：固定行高 32、overscan 8、`content-visibility: auto`、roving tabindex；窗口计算是纯函数 `visibleRange`，单测直接覆盖 1,000 行 | `components/VirtualList.tsx` |
| 文件树抽屉 | W2/W3 的 44px 轨道 + 320px overlay（`position: fixed`，不参与栅格）；`role=dialog` + 复用 `useOverlayDismiss` 的焦点陷阱与归位；Ctrl+B 只在工作台 scope、拍编辑中不开；节点来自 main 的 `project.tree`（结构 + 数据库视图，无正文） | `app/FileTreeDrawer.tsx`、`project/tree.ts` |
| 启动自动打开 | `settings.openLastProject` 默认 true；`project.autoOpen` 先只读探测（missing / locked / schema_newer / quick_check / project 行），通过才 `open`；打开后若变只读立即关闭并回首页；renderer 1.5s 截止，迟到成功主动 close，避免 main 与 UI 分叉 | `project/service.ts`、`stores/app.ts`、`shared/domain/auto-open.ts` |
| 诊断包 zip | 纯 JS store 压缩（PKZIP 单盘、无 data descriptor），避免原生模块进打包；内容 = README + diagnostics.json + logs/app.log；条目名限 ASCII；正文/secrets/exports 一律不读；日志与 JSON 都过 `scrubSecrets` | `observability/zip.ts`、`observability/diagnostics.ts` |
| 假适配器取消 | 创作台假适配器按真实适配器契约检查 `signal.aborted`，否则「取消」在 E2E 里永远测不到（取消后仍会提交） | `scheduler/fake-adapter.ts` |
| 开发种子 | `write.devSeed` 增 `chapters`（≤40）：只给 E2E 铺多章，生产包不注册该通道；第一章仍带分镜 | `scheduler/service.ts`、`shared/schema/write.ts` |

## 当前阻塞

- 无阻塞。阶段 11 已 `done`（2026-11-15）：本地门禁全绿（typecheck / lint / depcruise 274 modules / unit 620 / integration 35 / chaos 7 / e2e 21 / build / gen:check / 规格脚本 / perf 2）。
- 真实模型 Key：设置页（阶段 10）已接管——Key 经 safeStorage 加密存 `%APPDATA%/noryth/secrets.bin`，环境变量只做兜底（`NORYTH_<PROVIDER>_API_KEY` / `NORYTH_WRITE_API_KEY` 等）；未配置时失败为 `model_auth`，不伪造正文、报告或提案。E2E 用 `NORYTH_*_FAKE=1` 假适配器，生产包不认。
- 待补测（不阻塞阶段 10）：真实第二家供应商（DashScope/Moonshot）需要作者提供 Key；见 `docs/adr/0003-providers.md` 阶段 04 记录（M1 阶段 18，M1-26）。
- 已知缺口（不阻塞）：
  - **bge 权重不随包（M1 阶段 14）**：`resources/models/` 已进 `extraResources` 与安装包（目录 + 说明），但权重未交付（本机 HuggingFace 超时、缓存只有 config/tokenizer），M0 用确定性 `hash-bigram-v1` 降级（每条 `memory_entry.embedding_model` 记录真实模型，向量通道按模型过滤）。放入权重即启用，无需改代码；按 ADR-0004 阶段 10 记录执行体积/冷启动门槛与 T40 重建。
  - 文件树抽屉（Ctrl B）已在阶段 11 交付（W2/W3 overlay 320、焦点进出、200% 缩放）；W1 常驻树的 Ctrl+B 收起仍未做（不阻断验收）。
  - Windows 10 22H2 未单独做安装冒烟（本机 Win11 PASS）；发布前补一台 VM（M1 阶段 18）。
  - 自动更新：`src/main/update.ts` 后台检查 + electron-updater 下载，`NORYTH_UPDATE_FEED` 未配置时 `disabled`；首个 release tag 时填 feed（M1 阶段 18）。
  - 按章重建（T40）与 as-of 时间线、关系图是 M1（阶段 13/14）；记忆台的「按章重建」按钮禁用。
  - 世界状态作者编辑器（显式新增事实）M1（阶段 13），当前只读。
  - `tool_call` 审计面板属 P1（工具调用指标面板），M0 未做；记忆台展示 `memory_audit` 动作链，`tool_call` 表已按 §9.5 落库（M1 阶段 18）。
  - 创作台的「上下文检查器」按钮是占位（M1 阶段 13）；M0 分支只有线性 revision（M1 阶段 16）；审批的异构复检在 M1（阶段 16）；「重新打开定稿」后端未接（DEV-PLAN §9.6，M1 阶段 16）。
  - 「预览 tab 上限 6」当前无对应界面：预览区只有正文/分镜两个视图 tab；多文档 tab 留给阶段 13 的上下文检查器与文件预览扩展。W1 常驻树的 Ctrl+B 收起同样后置（不阻断验收）。

## 下一阶段交接

- 阶段 11 已 `done`（2026-11-15）。M0 验收报告仍是 `docs/M0-ACCEPTANCE.md`；M1 阶段 11 的证据见本文件「验证记录（阶段 11，本地）」。
- 阶段 12 直接复用（规模底座已就位）：
  - **多项目**：首页 `requestSwitch()` 是唯一入口（先 `project.busy()` 再决定直开/确认）；新增域如果要能被切换打断，必须实现 `abortAllAndWait()` 并挂进 `settleRunningWork()`。
  - **章列表**：任何列表页都走 `chapter.listSummaries()` / `VirtualList`，不要在 renderer 里 map 全量拍；列表行禁止带 `body`（`WriteChapterSummary` 已按此收口）。
  - **抽屉**：`useTree` + `project.tree` 是文件树单一入口；新增可点开的对象（场景、时间轴、关系图）只需在 `project/tree.ts` 加节点，抽屉与 W1 常驻树都自动出现。
  - **启动**：`project.autoOpen` 的探测顺序（missing → locked → schema_newer → quick_check → 打开后转只读即关）是安全边界，迁移失败/只读锁不得自动打开。
  - **诊断包**：`exportDiagnosticsZip` 是唯一导出；新增内容只进 `diagnostics.json`，绝不把正文或 `secrets.bin` 塞进条目。
- M1 阶段文档已建并推送（2026-11-15，commit `1ed4e90`，origin/dev）：`docs/PHASE-11-SCALE.md` 至 `docs/PHASE-18-DELIVERY-M1.md`；阶段 11 已标 `done`，其余仍为 `todo`；顺序与任务 ID 见 `docs/DEV-PLAN.md` §12.4 / §12.6。
- M1 开工顺序：11 规模底座 → 12 场景与时间三轴 → 13 as-of 与世界状态 → 14 重建/关系图/bge → 15 覆盖/影响/伏笔 → 16 分支/重开/摘要 → 17 DOCX → 18 分发与验收。阶段 11 未动 schema（仍是 0007 / `LATEST_SCHEMA_VERSION = 7`）；0008 从阶段 12 开始。
- M1 的关键回归：
  1. `E2E-M1-TIME-01`（闪回不误报，阶段 12）。
  2. `E2E-M1-ASOF-01`（第 3 章读不到第 20 章事实，阶段 13）。
  3. `E2E-M1-REBUILD-01`（按章重建旧记忆 inactive，阶段 14）。
  4. `E2E-M1-DOCX-01`（DOCX 通过，阶段 17）。
  5. `E2E-M1-A`（30 章连续创作，阶段 18 / nightly）。
- 发布注意：首个 release tag 前配置 `NORYTH_UPDATE_FEED`（或 electron-builder publish），否则更新状态为 `disabled`；`latest.yml` 已随 `pnpm run dist` 生成。

## 更新规则

1. 完成一个任务：更新对应阶段的「已完成」。
2. 阶段结束：填「验收」与「已知问题」，状态改 `done`。
3. 出现阻塞：状态改 `blocked`，写清缺什么、等什么。
4. 新会话开始：先读本文件，再读阶段文档。
5. 不把「写了代码」写成 `done`；只有验收清单全绿才是 `done`。
