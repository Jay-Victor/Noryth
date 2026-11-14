# PROGRESS

> 跨会话记忆。每个任务完成或阶段结束时更新；只写状态、决策、阻塞、交接，不写流水账。

## 阶段状态

| 阶段 | 文档 | 状态 | 已完成 | 验收 | 已知问题 |
|---:|---|---|---|---|---|
| 01 | `docs/PHASE-01-SKELETON.md` | done | A1–A6、B1、B6、S1–S4、42+8 工具清单外壳、CI 实跑 | 全部通过：本地门禁 + CI run `43585776532` | 第二家供应商顺延阶段 04；Win10 干净机未测 |
| 02 | `docs/PHASE-02-DATA.md` | done | B2–B5、0002 迁移、13 类 repos（Kysely）、seq/hash/revision、outbox/mirror、backup、verify、fixture、57 个 DB 单测、CI 实跑 | 全部通过：本地门禁 + CI run `43589148557`（verify + e2e 均绿） | 备份与镜像调用点留阶段 07/10 |
| 03 | `docs/PHASE-03-TOOLS.md` | done | C1–C7：42 manifest / 36 实现 / 6 开关、授权解析、九步流水线、闸门/幂等/审计、36×6 契约 harness | 全部通过：本地门禁 + CI run `43591949465`（verify + e2e 均绿） | 工具日志面板未做（可选）；T31/T33/T34 提案暂存 `tool_call.result_json`，阶段 06 接草案表 |
| 04 | `docs/PHASE-04-RUNTIME.md` | done | D1–D6：SSE/OpenAI 兼容适配器与重试、能力探测→settings、L0–L3 装配与预算裁剪、信封/grounding 校验、六角色提示词 + JSON 回退、绑定快照 + 审计；假 LLM 服务器 + 9 条 runTurn 集成 | 全部通过：本地门禁 + CI run 43595192603（verify 与 e2e 均绿） | 真实第二家供应商未补测（无 Key，见 ADR-0003）；trace 落盘与 commitBeat 留阶段 05；嵌入随包（ADR-0004）不在本阶段范围，推迟阶段 09/10 |
| 05 | `docs/PHASE-05-SLICE.md` | done | V1–V3：`commitBeat` + trace 归档 + 拍状态迁移 + 启动恢复/outbox 补发；fixture、假适配器、`#/dev/slice` 切片页；`E2E-SLICE-01` 与强杀重启 | 全部通过：本地门禁；unit 477 / E2E 7 | `verify` 的 seq 单调检查会误报「改早期拍」（ADR-0005 §4，阶段 07 修） |
| 06 | `docs/PHASE-06-PLANNING.md` | todo | — | — | — |
| 07 | `docs/PHASE-07-WRITING.md` | todo | — | — | — |
| 08 | `docs/PHASE-08-REVIEW.md` | todo | — | — | — |
| 09 | `docs/PHASE-09-MEMORY.md` | todo | — | — | — |
| 10 | `docs/PHASE-10-DELIVERY.md` | todo | — | — | — |

状态：`todo` / `in_progress` / `blocked` / `done`。

## 当前可运行命令

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm typecheck` / `pnpm lint` / `pnpm depcruise`
- `pnpm test:unit`（462 个：unit+integration 227 + contract 235） / `pnpm test:e2e`（5 个）
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
| 提交 | `f343668` | 随本次 docs 提交推送 origin/dev |
| CI | 推送后触发 | verify + e2e 待跑 |

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

## 当前阻塞

- 无。阶段 05 已 `done`：本地门禁全绿（typecheck / lint / depcruise / unit 477 / e2e 7 / build / gen:check）；CI 与标签在提交后打。
- 待补测（不阻塞阶段 06）：真实第二家供应商（DashScope/Moonshot）需要作者提供 Key；见 `docs/adr/0003-providers.md` 阶段 04 记录。
- 已知问题：`db/verify.ts` 的 `seq_not_monotonic` 按拍序检查，改早期拍会误报；阶段 07 必须改为按提交序/唯一性检查（ADR-0005 §4）。

## 下一阶段交接

- 阶段 05 已 `done`，`commitBeat` 接口冻结；阶段 06 可直接开工。
- 阶段 06 直接复用：
  - `commitBeat(db, repos, {...})`（`src/main/doc/commit-beat.ts`）：唯一正文写入者；不要另写体写入 SQL，也不要改签名；
  - `markGenerating` / `rollbackGenerate` / `rejectBeat` / `confirmBeat` / `editBeat`（`src/main/doc/beats.ts`）：拍状态迁移原语；
  - `runTurn(deps, {job})` 的第 8 步落盘通过 `deps.commit` 注入；流式事件用 `TurnDeps.hooks`，turn ID 用 `turnIdFor(jobId, beatId)` 生成，避免两处拼串；
  - `writeTurnTrace`（`src/main/doc/trace.ts`）：trace 只归档 thought/tool_call/grounding/meta，不写正文；
  - `recoverInterrupted` + `publishPendingMirrors` 已挂到 `ProjectService.open`；不要在其他地方重复扫描 running job；
  - 未打包构建的切片服务（`src/main/slice/*`）是脚手架：阶段 07 的正式创作台直接复用底层 `runTurn`/`commitBeat`，不要依赖 `DevSliceService`。
- 阶段 06 注意：
  - T31/T33/T34 提案仍落 `tool_call.result_json`；要持久化草案先加迁移 `0003`，再改 manifest 与 `docs/tools/*.json`；
  - 切片没有新增表，`LATEST_SCHEMA_VERSION` 仍为 2；
  - 阶段 06 的规划页需要真实模型绑定；`settings.probeProvider` 后端已就绪，UI 绑定预设在阶段 10 完结。
- 阶段 07 注意：先修 `verify` 的 seq 检查（ADR-0005 §4 第 1 条），再接调度器/自动模式；`commitBeat` 不要改签名。
- 真实第二家供应商补测属于阶段 10 I1/I3 之前的遗留项；`settings.probeProvider` 后端已就绪，UI 在阶段 10 接。

## 更新规则

1. 完成一个任务：更新对应阶段的「已完成」。
2. 阶段结束：填「验收」与「已知问题」，状态改 `done`。
3. 出现阻塞：状态改 `blocked`，写清缺什么、等什么。
4. 新会话开始：先读本文件，再读阶段文档。
5. 不把「写了代码」写成 `done`；只有验收清单全绿才是 `done`。
