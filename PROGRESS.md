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
| 07 | `docs/PHASE-07-WRITING.md` | done | F1–F7：分镜草案/G2、11 状态迁移表、出口 DSL AST、调度循环与自动模式、正文/拍卡/确认条/分镜编辑器、拒演/耗尽/预算/模型错误四类暂停；`E2E-WRITE-01/02`；新增 `0004_writing.sql`（`LATEST_SCHEMA_VERSION = 4`） | 全部通过：本地门禁全绿（unit 541 / integration 25 / e2e 11 / build / gen:check / 规格脚本） | 真实模型未接（Key 在阶段 10）；影响分析仅 M1；分支树只有线性 revision；「上下文检查器」按钮占位 |
| 08 | `docs/PHASE-08-REVIEW.md` | todo | — | — | — |
| 09 | `docs/PHASE-09-MEMORY.md` | todo | — | — | — |
| 10 | `docs/PHASE-10-DELIVERY.md` | todo | — | — | — |

状态：`todo` / `in_progress` / `blocked` / `done`。

## 当前可运行命令

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm typecheck` / `pnpm lint` / `pnpm depcruise`
- `pnpm test:unit`（541：unit+contract） / `pnpm vitest run tests/integration`（25） / `pnpm test:e2e`（11）
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

## 当前阻塞

- 无。阶段 07 已 `done`：本地门禁全绿（typecheck / lint / depcruise / unit 541 / integration 25 / e2e 11 / build / gen:check / 规格脚本）。CI 待推送后跑。
- 真实模型未配置 Key（不阻塞）：创作台沿用阶段 06 的环境变量口径（`NORYTH_WRITE_API_KEY` / `NORYTH_<PROVIDER>_API_KEY` / `NORYTH_PLAN_API_KEY`）；未配置时生成失败为 `model_auth`，自动模式暂停为 `model_error`，不伪造正文。E2E 用 `NORYTH_WRITE_FAKE=1` 假适配器，生产包不认。
- 待补测（不阻塞阶段 08）：真实第二家供应商（DashScope/Moonshot）需要作者提供 Key；见 `docs/adr/0003-providers.md` 阶段 04 记录。
- 已知缺口（不阻塞）：创作台的「上下文检查器」按钮是占位（只显示 traceRef）；M0 分支只有线性 revision，没有分支树 UI；跨章影响分析在 M1。

## 下一阶段交接

- 阶段 07 已 `done`（2026-11-14）。新增迁移 `0004_writing.sql`，`LATEST_SCHEMA_VERSION = 4`；`DEV-PLAN §5.14` 已同步表结构（storyboard_draft / write_message / scheduler_event / scene.max_beats / chapter.budget_tokens）。
- 阶段 08 直接复用：
  - `commitBeat`（`src/main/doc/commit-beat.ts`）仍是唯一正文写入者；patch 应用必须走它，不要另写 UPDATE beat.body。
  - 章节现在会停在 `draft_complete`（`scheduler/loop.markChapterComplete`），并已写 `scheduler_event(chapter_complete)`；G4 从这里开始。
  - `runTurn` 的 `deps.commit` 与 `TurnDeps.hooks` 可复用到审批/修订；非单拍 Agent 可参考 `scheduler/orchestrator.ts` 的轻量运行时（复用 `invokeTool` 九步）。
  - `gate_record` 已是 0001 表：G2 的写法在 `scheduler/g2.ts`；G4/G5/G6 只需照抄 `gate.insert({gateId, entityType:'chapter', entityId, decision, actor, payloadJson})`。
  - `revision` / `revision_beat` / `patch` / `approval_report` 表在阶段 02 已就绪；`repos.patch`、`repos.review` 可直接用。
  - `write.state()` 已把章状态、revision、拍列表、count 预算与事件暴露给 UI；审批台可复用同样的四分区与事件通道模式（`IPC_EVENTS.writeEvent` 是范式）。
- 阶段 08 注意：
  - 审批报告只读初稿（T21 `draft.get_chapter`）；不得给 `pass` 当 `consistency.check` 失败或未跑完（PRD §5.3）。
  - patch 只能改已有拍（T34 分镜除外）；不能新增拍/场景；`before` 与当前正文不匹配不得套用。
  - G5/G6 是一次性令牌：`issueGate` + `consumeGate`；G6 只能在作者侧出现，无快捷键。
  - 定稿冻结：`chapter.markFinalized` 已存在；定稿后 `commitBeat` 仍会校验 `expected_revision`，但审批的 patch 必须在定稿前完成。
  - 不要把 `scheduler_event` 当审批审计；审批的 `tool_call` 已有独立审计表。
- 真实第二家供应商补测属于阶段 10 I1/I3 之前的遗留项；`settings.probeProvider` 后端已就绪，UI 在阶段 10 接。

## 更新规则

1. 完成一个任务：更新对应阶段的「已完成」。
2. 阶段结束：填「验收」与「已知问题」，状态改 `done`。
3. 出现阻塞：状态改 `blocked`，写清缺什么、等什么。
4. 新会话开始：先读本文件，再读阶段文档。
5. 不把「写了代码」写成 `done`；只有验收清单全绿才是 `done`。
