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
| 12 | `docs/PHASE-12-STORYBOARD-TIME.md` | done | M1-1 场景库（链接/解链/排序/fork/删除 + 只读引用 + 演出前 fork 守卫）、M1-2 时间三轴（`story_start/end`、`timeline`，`idx` 取章序）、T23 `timeline.query` 实现并打开（编排/审批/记忆各 +1）、verify `scene_cross_chapter_beats`、G2 物化回写 `scene_id`；`E2E-M1-TIME-01`、`E2E-M1-SCENE-01`；新增 `0008_story_time.sql`（`LATEST_SCHEMA_VERSION = 8`） | 全部通过：本地门禁全绿（typecheck / lint / depcruise 278 modules / unit 646 / integration 35 / chaos 7 / e2e 23 / build / gen:check / 规格脚本 / perf 2） | 故事时间仍是自由文本（M1 只展示，格式校验与自动推断 M2）；引用场在 G2 后统一排到草案场次之后（只读，不参与演出顺序）；场景库无批量操作；`tool_call` 审计面板仍缺（M1 阶段 18） |
| 13 | `docs/PHASE-13-ASOF-WORLD.md` | done | M1-3 as-of 投影（`world/projection.ts` 纯函数）+ 世界时间线（章 + seq 滑杆、读者已知、`world.projection`）；M1-18 作者事实编辑器（`world/author-facts.ts` + `applyAuthorFact`/`closeAuthorFact`、`world.fact.add`/`world.fact.close`、source_type=author + 审计）；M1-17 上下文检查器（`turn_metric.context_json` 只读、预算条、`write.context`）；M1-19 审批/检索 as-of 边界（review 用 `covered_until_seq`、零水位拒绝复审、manuscript 按章截断）；`E2E-M1-ASOF-01`、`E2E-M1-CONTEXT-01`；未改 schema（`LATEST_SCHEMA_VERSION = 8`） | 全部通过：本地门禁全绿（typecheck / lint / depcruise 284 modules / unit 673 / integration 41 / chaos 7 / e2e 25 / build / gen:check / 规格脚本 / perf 2） | tool_call 审计面板仍缺（M1 阶段 18）；上下文检查器内嵌对话栅（<1600 未做模态变体）；世界状态无批量编辑 |
| 14 | `docs/PHASE-14-REBUILD-GRAPH.md` | done | M1-4 按章重建（`memory/rebuild.ts` + `ApplyInput.rebuild` 同事务清旧 + `author_confirm` + T40 打开）、M1-5 关系图（`world/relations.ts` 确定性圆环 + as-of 回放 + 来源；记忆台第五 tab）、M1-20 bge 权重随包（q8/24MB，`pnpm verify:embed`）+ `index.rebuild`（32/批、可恢复、`author_confirm`）、记忆台按章重建按钮启用；`E2E-M1-REBUILD-01`、`CHAOS-09`；未改 schema（`LATEST_SCHEMA_VERSION = 8`） | 全部通过：本地门禁全绿（typecheck / lint / depcruise 288 modules / unit 693 / integration 41 / chaos 8 / e2e 26 / build / gen:check / 规格脚本）+ NSIS 157MB + 安装冒烟 PASS | 全量重建整个项目（M2）；关系图编辑（只读）；`tool_call` 审计面板仍在阶段 18；「重新打开定稿」后端仍属阶段 16（本阶段重建作用于当前 final revision） |
| 15 | `docs/PHASE-15-COVERAGE-IMPACT.md` | done | M1-11 覆盖检查（`plan/coverage.ts` 4 类确定性规则 + `CoveragePanel` + G1 阻断/开关 + 结构化标注编辑器）、M1-8 影响分析与变更流程（`plan/impact.ts` + `plan/change.ts`、T29 写 `blueprint_change`、应用只改 outline/角色卡 + 标脏 + 系统提示、未分析拒绝）、M1-10 伏笔（`world/foreshadow.ts` + T22 + 记忆台第六 tab，距离/超期/回收）、跨章标脏（`chapter.invalidated_at/reason` + 创作台/审批台横幅 + 忽略）、T31 ops 支持结构化纲要素并在 G1 后返回 `requires_change`；新增 `0009_blueprint_ops.sql`（`LATEST_SCHEMA_VERSION = 9`）；`E2E-M1-BLUEPRINT-01`、`E2E-M1-FORESHADOW-01` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 301 modules / unit 746 / integration 46 / chaos 8 / e2e 28 / build / gen:check / 规格脚本） | 覆盖检查只做确定性规则（语义判断 M2）；影响分析不跨项目、不预测语义漂移；伏笔自动识别 M2；`tool_call` 审计面板仍在阶段 18 |
| 16 | `docs/PHASE-16-BRANCH-LONGFORM.md` | done | M1-21 重新打开定稿（`doc/reopen.ts`：旧 final 保留、新 draft、`write_epoch+1`、再定稿自动执行 `memory.rebuild`）+ 分支树（`doc/branches.ts`：开分支/对比/切回主线，head 随 commit/patch/fork 移动，final 不挂分支）、M1-22 异构复检（`review/hetero.ts` + `review.hetero` 设置；报告记录 `provider`，缺失 `degraded=hetero_unavailable`）、M1-13 章末摘要（`doc/summary.ts`：finalize 同事务、首末拍 + 关键事实 ≤5、≤300 tokens；L0 `summary.prev`）；新增 `0010_branch_summary.sql`（`LATEST_SCHEMA_VERSION = 10`）；`E2E-M1-BRANCH-01` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 310 modules / unit 769 / integration 46 / chaos 8 / e2e 29 / build / gen:check / 规格脚本） | 分支不做合并（M2）；异构复检默认 `off`，评分校准 M2-8；摘要只做抽取式（模型摘要 M2）；`summary.prev` 只进 L0 装配，不塞进 system 提示词 |
| 17 | `docs/PHASE-17-DOCX-EXPORT.md` | done | M1-6 DOCX（`doc/export-docx.ts`：标题页 / 目录 / 章标题分页 / 场景分隔 / 首行缩进 2 字符；zip 时间戳 + core 时间 + 书签 id 归一化 → 同清单字节可复现）、M1-14 选项（`format` / `scope` / `includeNotes` / `toc` / `font` / `fontSize` / `lineSpacing` / `author`）、三档格式统一从 revision 清单渲染（未定稿标「草稿」）、`ExportDialog.tsx`、`E2E-M1-DOCX-01`；依赖 `docx` + `fflate`（纯 JS）；未改 schema（`LATEST_SCHEMA_VERSION = 10`） | 全部通过：本地门禁全绿（typecheck / lint / depcruise 314 modules / unit 775 / integration 46 / chaos 8 / e2e 30 / build / gen:check / 规格脚本 / perf 2）+ NSIS 159MB + 安装冒烟 PASS + 本机 Word 打开检查；CI 全绿（`d3ac330`：verify + e2e 两片） | 目录页码由 Word/WPS 首次打开时更新（预生成条目保证不空白）；不做 PDF/EPUB、封面、Word 原生批注（M2/不做）；导出批注来自最近一份报告，不做逐条批注定位 |
| 18 | `docs/PHASE-18-DELIVERY-M1.md` | done | M1-7 更新通道/回退/演练（`update.ts` 三通道 + semver 预发布 + 同 minor 才降级 + `scripts/update-drill.mjs` + 设置页「更新」卡）、M1-15 QA（`E2E-M1-SMOKE` 3 章提交门 / `E2E-M1-A` 30 章 3 卷 nightly / `project.verify` 只读校验 / 内存与孤儿断言）、M1-23 工具审计面板（迁移 0011 `tool_call.chapter_id` + 两条回填 + `memory.toolCalls` + `ToolCallList.tsx` + `E2E-M1-TOOLCALL`）、M1-25 图标/品牌（`scripts/gen-icons.mjs` + `resources/icon.ico` / `resources/icon.png` + `icons/*` + exe/窗口/随包断言）、版本 0.2.0、`docs/M1-ACCEPTANCE.md` | PRD M1 五条全绿（`E2E-M1-A` 20.8s / 30 final / 私有 512MB；`E2E-M1-TIME-01`、`E2E-M1-REBUILD-01`、`E2E-M1-ASOF-01`、`E2E-M1-DOCX-01` 复跑绿）；本地门禁全绿（typecheck / lint / depcruise 319 modules / unit 794 / integration 46 / chaos 8 / e2e 32 / perf 2 / build / gen:check / 规格脚本）；NSIS 167,298,203 B + 安装冒烟 PASS（Win11，schema 11）；更新演练 PASS（manifest / 四态判定 / 真实下载）；CI run `44045408802`（verify 2m34 + e2e 两片 2m05 / 2m46 均绿，package 按规则跳过）；标签 `phase-18-done` → `1f2b668` | Win10 22H2 与真实第二家 Key：作者决定不测（2026-11-17，外部依赖）；GitHub Release 未上传（首个 release tag 时做）；更新演练「安装→重启→迁移」为人工步骤；30 章长跑只在 nightly/发布前跑 |
| 19 | `docs/PHASE-19-VOICE.md` | done | M2-1：T25 `voice.metrics` 实现（逐角色 + 两两分项 + `threshold`，1.1.0，审批白名单 19→20）；`zh-v1` 中文夹具语料校准（0.252；FPR 2.0% / TPR 97.5%）+ `scripts/calibrate-voice.mjs`；迁移 0012 `voice_metric`（scene + revision 一行）+ `voice.scene` 只读 IPC；M2-2：创作台场景头徽标 + 审批台 `VoicePanel` + 报告运行时 `voice` 建议（只建议，不阻断 G6）；`scripts/m2-baseline.mjs` + `docs/M2-METRICS-BASELINE.md` + ADR-0007；`E2E-M2-VOICE-01`、`E2E-M2-METRICS-01` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 328 modules / unit 827 / integration 48 / chaos 8 / e2e 34 / perf 2 / build / gen:check / 规格脚本）；CI run `44914033792` 全绿（verify + e2e 两片）；标签 `phase-19-done` → `eed3ef1` | 语料是合成夹具（阈值是起点，真实项目需复跑基线）；项目基线用假模型文本（最低一对 0 分，不代表真实分数）；旁白不参与两两区分度；声音建议只在 G4 全量报告追加（复检报告不重复） |
| 20 | `docs/PHASE-20-COST-BUDGET.md` | done | M2-3 章预算（token + ¥，出口优先，暂停/恢复不丢拍，`job.result_json.budget`）+ 费用预测（最近 5 拍中位数 / 0.7–1.3 / 无计价 null）+ 状态栏预算段；M2-5 全链路计量（`turn_metric.chapter_id`：写拍/审批/记忆/讨论/规划）+ `report.cost` + `CostReportDialog`（本章/全书、按章/按 Agent、预算编辑、费用下限）+ 迁移 0013 + `docs/M2-COST-BASELINE.md`；`E2E-M2-BUDGET-01`、`E2E-M2-COST-01`、`COST-M2-01` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 335 modules / unit 840 / integration 58 / chaos 8 / e2e 36 / perf 2 / build / gen:check / 规格脚本）；基线 30 章 / 540 拍 / 2.73 万字 / ¥3.0912（¥1.1316 每万字） | 每千字净操作时间留阶段 24 秒表；非 DeepSeek 预设仍不计价（显示下限）；自动模式暂停账本行用 `beat.generate`（0013 不改 job 表，无独立 auto job 类型）；假 usage 基线不是报价；`E2E-M2-A` 100k 长跑在阶段 24 |
| 21 | `docs/PHASE-21-ROUTING-HETERO.md` | done | M2-4 多供应商路由/故障切换（`routing` 设置、`model/router.ts`、`model/health.ts` 熔断、状态栏徽标、六 Agent 回合前切换）；M2-8 校准（`review/calibration.ts`、`scripts/m2-calibration.mjs`、`docs/M2-HETERO-CALIBRATION.md`、ADR-0008/0009）；`routing.status` / `review.calibration` 只读 IPC；错误码 `routing_exhausted`；无迁移 | 全部通过：本地门禁全绿（typecheck / lint / depcruise 341 modules / unit 857 / integration 61 / e2e 38（两片各 19）/ chaos 8 / perf 2 / build / gen:check / 规格脚本）；30 章校准：60 报告 / 60 阻断 / 30 定稿 / 审批 ¥1.2384 / `heteroDeltaPct=null`；CI run `45384289571` 全绿（verify + e2e 两片）；标签 `phase-21-done` → `825ea4c` | 真实第二家 Key 未补测；D4 保持 `review.hetero=off`；健康状态只在内存（重启清零）；「立即重试」按钮未做（§7 风险表建议项，不阻断） |
| 22 | `docs/PHASE-22-ARCHIVE-CONTEXT.md` | done | M2-7 非事实类归档（`memory/archive.ts` 确定性候选 + `apply.archiveMemoryEntries` 单事务 + `memory_audit` archive/restore + 记忆台「维护」tab + `memory.archive.*` 四个 IPC + 归档过滤/计数/缓存失效）；M2-9 上下文成本（块去重、L3 相关裁、最近拍 4→2 兜底、提示词去重、`cached_tokens` 解析 + 报表/检查器）；迁移 0014（`memory_entry.archived_at/archive_reason` + `memory_entry_archive` + `turn_metric.cached_tokens` + `memory_audit` CHECK 重建，`LATEST_SCHEMA_VERSION = 14`）；基线 `docs/M2-CONTEXT-COST.md`（180 拍：2,725 → 2,167，−20.5%；P95 不升；裁剪 0%）；`E2E-M2-ARCHIVE-01`、`COST-M2-02` | 全部通过：本地门禁全绿（typecheck / lint / depcruise 344 modules / unit 873 / integration 61 / e2e 41 / chaos 8 / perf 2 / build / gen:check / 规格脚本）；CI run `45395894252` / `45398509831` 全绿（verify + e2e 两片）；标签 `phase-22-done` → `706b62c` | 真实供应商缓存命中率未测（单家 Key，外部依赖）；归档不做语义判断，只按 kind + 引用 + 文本/向量相似度；`skipped` 不半写但需要作者重新勾选；100k 项目的上下文成本留阶段 24 复测 |
| 23 | `docs/PHASE-23-SCALE-100K.md` | done | M2-6 10 万字性能专项：`PERF-M2-01` 夹具（30 章 / 720 拍 / 119,660 字 / 3,000 记忆 / 90 声音行 / 153 成本行 / 12 伏笔，确定性计划）+ `scripts/m2-perf-report.mjs` + `docs/M2-PERF-BASELINE.md`；修复 vec0 KNN 被 SQLite 反选外循环（`CROSS JOIN`，检索 P95 1,521→9ms）、检索/归档批量取数、声音角色卡缓存、记忆台分页 50；无迁移（`LATEST_SCHEMA_VERSION = 14`，0015 未使用） | `pnpm test:perf` 4 passed；打开 31.6ms / 切章 1.3ms / T23 0.2ms / 检索 8.8ms / 装配 4.8ms / 报表 1.7ms / 声音 1.4ms / 归档 30.3ms / MD 16.7ms / DOCX 203.4ms / RSS 254.2MB；查询计数 8/9/8/4；unit 878 / integration 61 / e2e 41 绿；旧基线不退化（检索 3ms）；CI run `45416212068` 全绿（verify 2m40 + e2e 3m03/2m54）；标签 `phase-23-done` → `fa3287d` | — |
| 24 | `docs/PHASE-24-DELIVERY-M2.md` | in_progress | M2-10 QA / 内测 / M2 验收：`E2E-M2-A`（30 章 / 720 拍 / 142,344 字 / 30 final / 三卷逐章 G2→G7 / 每 5 章 verify / 0 孤儿 / 0 双活 / 0 failed / 0 overflow / 6 Agent / 伏笔 3-2-1 / 私有 514–520MB）、`E2E-M2-SMOKE`（3.6s，提交门）、长文本假适配器 `NORYTH_WRITE_FAKE_LONG`、`tests/e2e/m2-flow.ts`、`playwright.m2a.config.ts` + `pnpm test:e2e:m2a`、nightly `m2-a`、0.3.0 安装包 159.6MB + 安装冒烟 PASS + 更新演练 PASS；`docs/M2-ACCEPTANCE.md`；基线更新 `M2-CONTEXT-COST` §7 / `M2-COST-BASELINE` §9 / `M2-METRICS-BASELINE` §3.1 / `M2-PERF-BASELINE` §7 | PRD M2 四条均有用命令与实际输出（§1）；全量门禁 typecheck / lint / depcruise 345 / unit 878 / integration 61 / chaos 8 / e2e 42 / perf 4 / M1-A 21.6s / build / gen:check / 规格脚本 / 图标；安装 0.3.0 / schema 14 / `embedder source=model` | **人工内测待作者**（7 天自测 / 每千字净操作时间 / 外部试用）→ 签字或豁免后才标 done；标签 `phase-24-done` 未打（待 CI）；GitHub Release 未上传；Win10 22H2 与真实第二家 Key 作者决定不测；长跑内存余量 BACKLOG #15 |

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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| CI（首次） | GitHub Actions run `43699407599`（`a98e813`） | verify 全绿；**e2e 失败且当次无日志**（workflow 只输出 exit code 1）。已给 e2e 加 `set -o pipefail \| tee e2e.log` + 失败时日志尾部 `::error::` annotation + 上传 `e2e.log`/`test-results/` |
| CI（复跑） | GitHub Actions run `43700004809`（`c2ef570`） | verify + e2e 均绿；package 按规则跳过（非 `v*` tag） |
| 阶段标签 | `phase-11-done` → `c2ef570` | 已推送 origin |

## 验证记录（阶段 12，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 278 modules / 1356 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 646 passed（新增 scene-library 13 / timeline 5 / verify 1 / migrator 1；contract 夹具 37 个工具） |
| 集成 | `pnpm vitest run tests/integration` | 35 passed |
| 混沌 | `pnpm test:chaos` | 7 passed / CHAOS-01..08 |
| E2E | `pnpm test:e2e` | 23 passed（新增 `E2E-M1-TIME-01`、`E2E-M1-SCENE-01`） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0008；0008 在 0007 旧库上回填 `timeline='main'`、两轴 NULL、`scene_timeline` 索引存在、CHECK 拒绝非法值 |
| 迁移升级 | `tests/unit/db/verify.test.ts` | 旧 fixture 迁到 0008 后 `db.verify()` 全绿 |
| 多对多 | `tests/unit/scheduler/scene-library.test.ts` | 空场景可同时链接两章且 0 拍；已演出场景链接到别章 → `invalid_args`（`needsFork`）；解链/排序/删除的拒绝条件；fork 复制 scene + 拍（新 id、`waiting_for_human`）且原章 revision/hash/正文不变 |
| 引用只读 | 同上 | 引用章 `commitBeat` → `invalid_args` 且零写入；`readChapterStoryboard` 不再返回别章的拍 |
| 归属校验 | `tests/unit/db/verify.test.ts` | 同一场景 live 拍跨章 → `scene_cross_chapter_beats` |
| T23 | `tests/unit/tools/timeline.test.ts` | `idx` 取章序；`story_start/end` 取第一个 main 场景；`timeline[]` 按 `beat.seq` 带 `story_time` 与时间轴；闪回早于第 1 章不产生 `timeline_non_monotonic`（`consistency.check` 只比 seq）；`as_of` 超章水位 → `stale_revision` |
| 注册与生成物 | `tests/contract/registry.test.ts`、`tests/unit/catalog.test.ts` | 37 个启用工具（36 M0 + T23）；orchestrator 17 / reviewer 18 / memory 14；`M0_TOOL_COUNTS` 仍 36；`TOOL_COUNTS` 记录当前值；`gen:check` 0 diff |
| 时间线 E2E | `tests/e2e/time.spec.ts` | `E2E-M1-TIME-01`：3 章，第 1 章「民国二十三年 三月初七 夜」，第 3 章「闪回 · 民国二十年 冬」；T23 返回 `idx=3`、`storyStart=null`、`scenes[0].timeline='flashback'`、每拍 `storyTime='民国二十年 冬'`；审批报告无 `type='timeline'` 条目；DB 里 1 main + 1 flashback，0 跨章拍 |
| 场景库 E2E | 同上 | `E2E-M1-SCENE-01`：第 2 章场景库显示「第 1 章演出」+ fork；直接链接被拒（`details.needsFork`）；fork 后新场景 2 拍进第 2 章、`waiting_for_human`，第 2 章可确认；第 1 章 revision 与正文逐字不变 |
| 性能 | `pnpm test:perf` | PERF-01：切章 P95 1ms、检索 P95 25ms、导出 14ms、RSS 259MB；PERF-M1-01：切章 P95 1ms、列表摘要 P95 1ms、RSS 148MB |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T23 输出 schema 扩展、DraftScene 允许空拍 → T27/T34 清单变化） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| CI | GitHub Actions run `43707502797`（`374578b`） | verify 2m14（lint/typecheck/depcruise/unit 646/chaos 7/spec/gen/build）+ e2e 2m31，均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `43707982690`（`e86a69e`） | verify + e2e 均绿 |
| CI（复跑） | GitHub Actions run `43709035637`（`4711d3c`） | verify + e2e 均绿（同一代码；`43708534963` 的 e2e 中断为环境偶发） |
| 阶段标签 | `phase-12-done` → `374578b` | 已推送 origin |

## 验证记录（阶段 13，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 284 modules / 1384 deps，0 违规 |
| Lint | `pnpm lint` | 通过 |
| 单元 + 契约 | `pnpm test:unit` | 673 passed（新增 projection 5 / author-facts 9 / sources-asof 3 / manuscript-asof 4 / context-inspection 3 / world-view 3） |
| 集成 | `pnpm vitest run tests/integration` | 41 passed（新增 `asof.spec.ts` 6 条） |
| 混沌 | `pnpm test:chaos` | 7 passed / CHAOS-01..08 |
| E2E | `pnpm test:e2e` | 25 passed（新增 `E2E-M1-ASOF-01`、`E2E-M1-CONTEXT-01`） |
| as-of 投影 | `tests/unit/world/projection.test.ts` | 两个 as_of 返回不同事实/信念/边；读者已知只由 reveal_seq 决定；futureFacts 与 notYetRevealed 分开；输入逆序输出逐字一致 |
| 作者事实 | `tests/unit/world/author-facts.test.ts` | 单值/多值由谓词登记表决定；未知知情者/越界序/秘密早揭示拒绝；`source_type=author` + `memory_audit(actor=author)`；单值槽旧值 valid_to 关闭、重复三元组 duplicate；关闭只写 valid_to、可回放 |
| 审查边界 | `tests/integration/asof.spec.ts` | 第 3 章审批的 `world.get_objective` 工具结果 as_of=24、含「早夭的名字」（旧事实、读者未知）、不含「祠堂夹层」（第 20 章才产生）；第 20 章审批 as_of=92 且看得到；covered=0 章复审 `invalid_args` 且零模型请求 |
| 定稿检索 | `tests/unit/tools/manuscript-asof.test.ts` | ch1 上下文 search_final 0 命中、ch2 上下文命中 ch2；显式请求更晚章 `invalid_args`（details.currentOrd）；get_final_chapter 同；`memory.retrieve_audit` as_of=1 看不到 learned_seq=2 的记忆 |
| 水位解析 | `tests/unit/context/sources-asof.test.ts` | 已写章取本章 covered；新章取前一章；第一章 0；review 0 水位 `invalid_args`；collectContext 同口径 |
| 上下文检查器 | `tests/unit/scheduler/context-inspection.test.ts` + `tests/e2e/context.spec.ts` | 无指标 found=false；块/裁剪/as_of/prefix/ratio 与 `context_json` 对齐；坏 JSON 不崩；E2E 断言 UI 数字与 `turn_metric` 逐项一致、正文不被遮、Esc 关闭 |
| 状态矩阵 | `tests/unit/world-view-states.test.ts` | 读者可见性三态（已知/未揭示/—）、检查器三态（loading/missing/ready）、预算提示三种来源；文案唯一 |
| UI 巡检 | Playwright 截图（1440 / 200% 缩放） | 世界事实表 10 列在 1440 不溢出（表头缩写 + min-width 520）；200% 下横向滚动而非一字列；时间线换行；检查器占对话栅、标题不换行 |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0008；未新增迁移，`LATEST_SCHEMA_VERSION = 8` |
| 性能 | `pnpm test:perf` | PERF-01：切章 P95 1ms、检索 P95 26ms、导出 16ms、RSS 258MB；PERF-M1-01：切章 P95 1ms、列表摘要 P95 1ms、RSS 148MB |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具/schema 变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| 提交 | `4c2ad26`（feat）、`b492928` / `86c18ae`（docs） | 已推送 origin/dev |
| CI | GitHub Actions run `43713984247`（`86c18ae`） | verify 2m11 + e2e 3m00 均绿；package 按规则跳过（非 `v*` tag） |
| CI（标签所在提交） | GitHub Actions run `43714545719`（`3f82a16`） | verify + e2e 均绿；package 跳过 |
| CI（DEV-PLAN 文档提交） | GitHub Actions run `43715088328`（`bfd7731`） | verify + e2e 均绿；package 跳过 |
| 阶段标签 | `phase-13-done` → `3f82a16` | 已推送 origin |

## 验证记录（阶段 14，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 288 modules / 1408 deps，0 违规 |
| Lint | `pnpm lint` | 通过（新增 `scripts/embed-smoke.mjs`、`probe` 清理） |
| 单元 + 契约 | `pnpm test:unit` | 693 passed（新增 rebuild 5 / relations 6 / reindex 3 / T40 契约 6） |
| 集成 | `pnpm vitest run tests/integration` | 41 passed |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09（新增 09：索引重建中途强杀，批事务回滚） |
| E2E | `pnpm test:e2e` | 26 passed（新增 `E2E-M1-REBUILD-01`） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0008；未新增迁移，`LATEST_SCHEMA_VERSION = 8`（`memory.rebuild` / `index.rebuild` 的 job type 在 0001 CHECK 里） |
| 按章重建 | `tests/unit/memory/rebuild.test.ts` | 旧 8 条 inactive + 新 8 条 active、id 不重叠；作者事实不失效；旧记忆事实 3 关闭 / 新 3 有效；旧边关闭 / 新边有效；旧信念 3 inactive；`memory_audit` 一条 `rebuild`（inactive 8 / rebuilt 8）+ 逐条 `invalidate`；重放 duplicate 不双写；bogus token 零写入；关系边 `from==to` 触发 CHECK → 整批回滚、旧条仍 active；`db.verify` 无 error |
| 重建水位 | 同上 | `rebuildCloseAtSeq` = 本章 `covered_until_seq`（>0） |
| 关系图 | `tests/unit/world/relations.test.ts` | 两个 as_of 边集/值不同；单向 `bidirectional=false`、反向边存在即双向；三轴计数；两次调用节点/边 deep-equal（布局确定性）；聚焦只留邻域；序列化不含记忆正文 |
| 索引重建 | `tests/unit/memory/reindex.test.ts` | pending 8 → 分批 3 条中途失败：已提交 3 条、5 条仍旧模型、`memory_vec` 行数不变；用同一 job 续跑到 8/8；`pending=0` 时拒绝签发、`reindex` 返回「无需重建」 |
| 契约夹具 | `tests/contract/tool-contracts.test.ts` | 38 个已启用工具 × 6 类 = 230；T40 夹具（author_confirm，chapter=ch_final）+ 端口注入 |
| 注册与计数 | `tests/contract/registry.test.ts`、`tests/unit/catalog.test.ts` | 38 个 Agent 工具启用（M0 36 + T23 + T40）；memory 15（13 + T23 + T40）；4 个里程碑工具未注册 |
| bge 冒烟 | `pnpm verify:embed` | `{"dim":512,"coldMs":134,"firstMs":6,"warmMs":2,"batch8Ms":15,"passed":true}`（门槛 1500/120ms） |
| Electron 内真模型 | `E2E-MEMORY-01`（未设 `NORYTH_MEMORY_EMBED=hash`） | 通过：utilityProcess + onnxruntime 在 Electron 里完成 8 条向量与召回（E2E 全量第 11 条） |
| 重建 E2E | `tests/e2e/memory-m1.spec.ts` | 14 提案 → 接受 → G7 应用 8 条 → 按章重建（二次确认）→ 旧 8 inactive / 新 8 active、摘要「旧条目 8 条失效」；关系图 as_of 0 无边、水位 1 条、点边看「章 · 记忆」、无「账本在祠堂」正文；两次 `world.relations` 坐标相等；索引改标 bge → 记忆台「索引待重建 8 / 8」→ 重建归零；DB：status 8/8、事实 1 author + 3 memory live + 3 closed、边 1 live + 1 closed、`rebuild` 审计 ≥2、`memory.rebuild`/`index.rebuild` job succeeded、`author_confirm` ≥2 已消费、`memory_vec` 16 |
| 打包 | `pnpm dist` | `release/Noryth-0.1.0-setup.exe` 157MB（上限 250MB）；`app.asar` 35MB；`app.asar.unpacked` 75MB（onnxruntime 仅 win32-x64 CPU，28MB）；`resources/models` 24MB |
| 安装冒烟 | `node scripts/install-smoke.mjs` | PASS：静默安装 → `packaged=true/schema=8` → 日志 `embedder_ready model=bge-small-zh-v1.5/source=model/dim=512` → 建项目 → `user_version=8` → 卸载清理（脚本顺手修了 schema 断言与卸载轮询） |
| 构建 | `pnpm build` | 通过（`out/main/memory-embed-worker.js` 在 asar 内） |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T40 升 1.1.0、enabled、summary 变化） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| 提交 | `3d09c3d`（feat）、`8654d8d`（docs）、`1b57902`（fix 代次键/滑杆）、`ec0a278`（fix 重放消费令牌） | 已推送 origin/dev |
| CI（首次） | GitHub Actions run `43719779933`（`8654d8d`） | verify 全绿；e2e 在第 16 条 `settings.spec` 失败（1.0s，早退；本地 5/5 通过）→ 判定为 runner 偶发 |
| CI（复跑） | GitHub Actions run `43720315361`（`b8c43ee`，空提交） | verify + e2e 均绿 |
| CI（runner 卡住） | run `43721050909`（`1b57902`）、`43721114670`（`ec0a278`） | 均卡在 `actions/setup-node@v4`（>25 分钟无进展），非代码失败；未完成即作废 |
| CI（再复跑） | GitHub Actions run `43722556226`（`a29c7b8`，空提交） | verify 2m29 + e2e 均绿；package 按规则跳过（非 `v*` tag） |
| 阶段标签 | `phase-14-done` → `a29c7b8` | 已推送 origin（树与 `ec0a278` 相同） |

## 验证记录（阶段 15，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 301 modules / 1482 deps，0 违规 |
| Lint | `pnpm lint` | 通过（新增 `OutlineMetaEditor` / `CoveragePanel` / `ForeshadowPanel` 与新 IPC 契约） |
| 单元 + 契约 | `pnpm test:unit` | 746 passed（新增 coverage 8 / impact 6 / change 9 / foreshadow 6 / plan-states 3 / migrator 0009 1；契约夹具 41 个工具） |
| 集成 | `pnpm vitest run tests/integration` | 46 passed（新增 `blueprint-change.spec.ts` 5 条） |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | 28 passed（新增 `E2E-M1-BLUEPRINT-01`、`E2E-M1-FORESHADOW-01`） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0009；旧行 `meta_json='{}'`、`invalidated_*` NULL、`foreshadow`/`blueprint_change` 两表两索引、`status` CHECK、迁后 `verifyDatabase` 无 error |
| 覆盖检查 | `tests/unit/plan/coverage.test.ts` | 4 类规则各自通过与失败；`meta_unannotated` 只建议（老项目不被卡）；scope 过滤；meta 归一化丢未知字段 |
| G1 阻断 | `tests/unit/plan/g1.test.ts` | `character_uncast` + `pov_missing` → `g1Blockers` 非空、`confirmG1` `invalid_args`、蓝图未锁；关闭 `coverage_gate` 后可确认；meta 全空不阻断 |
| 影响分析 | `tests/unit/plan/impact.test.ts` | 卷子树 → 2 章 + 记忆 + 边；主树全影响；角色卡 → 发言章 + 记忆 + 边；已关闭边不计；add 不影响现有章；确定性排序 |
| 变更流程 | `tests/unit/plan/change.test.ts` | 未分析 → `invalid_args` 且零写入；应用后正文/revision 不变、两章标脏、系统提示入库；已定稿章只标脏；忽略只清两列；拒绝不改蓝图；删有关联章的节点先拒；G1 前不能应用；G1 后 `applyProposal` 拒绝蓝图提案 |
| 伏笔 | `tests/unit/world/foreshadow.test.ts` | 标注 3 → open 3 → 回收 1 → 2；距离 1/1/0；超期文案；重开；清空计划章；无章不崩 |
| 状态矩阵 | `tests/unit/plan-states.test.ts` | 覆盖摘要四态、变更四态（未分析/可应用/已应用/已拒绝）、伏笔距离四态；文案唯一 |
| 蓝图 E2E | `tests/e2e/blueprint.spec.ts` | `E2E-M1-BLUEPRINT-01`：3 章 devSeed → 改主线标题（G1 后）= 变更记录 → 「受影响：3 章」→ 应用 → DB 3 章 `invalidated_at` 非空、正文与 revision 逐条不变 → 创作台/审批台横幅 → 忽略 1 章后其余保留；`E2E-M1-FORESHADOW-01`：UI 标注 3 条 → 基准第 3 章距离 [1,2,2]、超期文案 → 回收 1 → 未回收 2 |
| 性能 | `pnpm test:perf` | PERF-01：打开 2ms、切章 P95 1ms、检索 P95 23ms、导出 16ms（14.04 万字）、RSS 239MB；PERF-M1-01：切章 P95 1ms、列表摘要 P95 1ms、RSS 149MB |
| E2E 回归调整 | `tests/e2e/plan.spec.ts`、`tests/e2e/m0-a.spec.ts` | G1 后标题输入由「禁用」改为「提交变更」（断言改为 `blueprint-locked` 可见 + 输入可用）；`E2E-M0-A` schema 断言 8 → 9 |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T22/T26/T29 启用与输出扩展、T31 升 1.1.0） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| 提交 | `ad52579`（feat）、`be72ee7`（docs） | 已推送 origin/dev |
| CI（首次） | GitHub Actions run `43728834631`（`be72ee7`） | verify 2m09 全绿；e2e 3m17 失败：前 3 条（`a11y.spec`、`app.spec` 外壳 / 向导）失败，随后 13 条（含 `E2E-M1-BLUEPRINT-01`、`E2E-M1-FORESHADOW-01`）全绿 → 判定为 runner 冷启动偶发（与阶段 11/12/14 同形态） |
| CI（复跑） | GitHub Actions run `43729850861`（`048ab10`，空提交） | verify + e2e 均绿（28/28）；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `43730656629`（`a261e06`）、`43730675276`（`c6a1b59`） | verify + e2e 均绿 |
| 阶段标签 | `phase-15-done` → `048ab10` | 已推送 origin（树与 `be72ee7` 相同） |

## 验证记录（阶段 16，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 310 modules / 1535 deps，0 违规 |
| Lint | `pnpm lint` | 通过（新增 `BranchTree` / `ReopenDialog` / 异构设置卡） |
| 单元 + 契约 | `pnpm test:unit` | 769 passed（新增 reopen 4 / branches 3 / summary 3 / summary-block 4 / hetero 7 / rebuild-after-reopen 1 / migrator 0010 1） |
| 集成 | `pnpm vitest run tests/integration` | 46 passed |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | 29 passed（新增 `E2E-M1-BRANCH-01`；`E2E-M0-A` schema 断言 9 → 10） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0010；旧 revision `branch_id=NULL`、`chapter_summary` 空表、`approval_report.provider` 列存在、迁后 `verifyDatabase` 无 error |
| 重开定稿 | `tests/unit/doc/reopen.test.ts` | 4 条：旧 final 保留 + 新 draft（parent/清单/hash 相同）+ epoch+1 + 旧 epoch 写入被拒；非定稿章拒绝；再定稿新 final + `memory.rebuild` 入队（extract 不重复）+ 两份摘要；重复重开拒绝 |
| 分支 | `tests/unit/doc/branches.test.ts` | 3 条：开分支复制清单、提交移动 head 且 `branch_id` 继承、切回主线不丢分支、对比按拍对齐、verify 绿；同名/定稿后/未知分支拒绝；坏 head 与 current 越界被 verify 报告 |
| 章末摘要 | `tests/unit/doc/summary.test.ts` | 3 条：首末拍 + 本章关键事实（≤5）、≤300 tokens、不写正文；超长截断；collectContext 把上一章摘要交给 L0（第一章无摘要） |
| L0 预算 | `tests/unit/context/summary-block.test.ts` | 4 条：`L0:summary:prev` 存在且章纲在前、L0 ≤900；超长摘要 ≤300；预算不足先压 150 再整块丢；30 章循环不抛 overflow |
| 异构复检 | `tests/unit/review/hetero.test.ts` | 7 条：off 不切换；prefer + 同家 + 已测试第二家 → openai + 记录 provider；无第二家 → `hetero_unavailable` 且报告照常；生成已是别家不切换；停用/未测试/无 Key 不算第二家；服务级 report.provider/model 与 degraded 断言 |
| 自动重建 | `tests/unit/memory/rebuild-after-reopen.test.ts` | 1 条：首页记忆固化 → 重开改拍再定稿 → `runQueuedRebuild` 执行 → 旧 8 条 inactive / 新 8 条 active，rebuild job succeeded，不重复入队 extract |
| 分支 E2E | `tests/e2e/branch.spec.ts` | `E2E-M1-BRANCH-01`：定稿 → 记忆固化 → 重开（旧 final 保留）→ 改一拍 → 开分支写 2 拍 → 对比（≥2 拍变化 / 6 hunks）→ 切回主线不丢分支 → 再定稿（新 final）→ 自动 `memory.rebuild` applied → 旧 final 可读；DB：两个 final / 6 条清单、分支 head 与 3 条分支 revision、两份摘要 ≤300、旧记忆 inactive、无重复 extract、`db.verify()` 无 error |
| 性能 | `pnpm test:perf` | PERF-01：打开 1ms、切章 P95 1ms、检索 P95 27ms、导出 17ms（14.04 万字）、RSS 264MB；PERF-M1-01：切章 P95 1ms、列表摘要 P95 1ms、RSS 149MB |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具/schema 变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| 提交 | `e024b6f`（feat）、`136d094`（docs）、`fc03d0e`（CI 复跑空提交） | 已推送 origin/dev |
| CI（首次） | GitHub Actions run `44022119818`（`136d094`） | verify 2m52 全绿；e2e 在第 19 条 `settings.spec` 失败（1.0s，早退；本地 29/29 通过）→ 与阶段 14 同形态，判定 runner 偶发 |
| CI（复跑） | GitHub Actions run `44023118332`（`fc03d0e`，空提交） | verify + e2e 均绿；package 按规则跳过（非 `v*` tag） |
| 阶段标签 | `phase-16-done` → `fc03d0e` | 已推送 origin |

## 验证记录（阶段 17，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 314 modules / 1546 deps，0 违规（新增 `doc/export-docx.ts`） |
| Lint | `pnpm lint` | 通过（新增 `ExportDialog` / 行内 `\u3000` 转义 / perf 夹具） |
| 单元 + 契约 | `pnpm test:unit` | 775 passed（新增 `tests/unit/doc/docx.test.ts` 6 条） |
| 集成 | `pnpm vitest run tests/integration` | 46 passed |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | 30 passed（新增 `E2E-M1-DOCX-01`，2.9m） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0010；未新增迁移，`LATEST_SCHEMA_VERSION = 10` |
| DOCX 结构 | `tests/unit/doc/docx.test.ts` | 解压含 `[Content_Types].xml` / `word/document.xml` / `docProps/core.xml`；标题页（书名 / 作者 / 日期）、每章标题 + 首段、目录条目由 Heading1 生成；无 `sk-` / `secrets.bin` / `[INFO]` |
| 可复现 | 同上 | 同清单两次导出 sha256 相同、字节逐位相等；central directory 的 DOS 日期全为 `0x2821`（2000-01-01）；core 的 created/modified = 导出日零点（书签名 `_TocN` 与 bookmark id 按出现顺序重编号，抵消 docx 的跨文档计数器） |
| 两档批注 | 同上 | 「仅正文」输出是「正文 + 修订建议」的逐字前缀；多出的只有章末小节（`第 2 轮 · deepseek` + 阻断 / 建议条目） |
| 选项 | 同上 | 思源宋体 → `w:eastAsia="思源宋体"`；10.5pt → `w:sz=21`、首行缩进 420；行距 2 → `w:line=480`；`toc:false` 无 `TOC \h \o` |
| 草稿 / 定稿 | 同上 | 未定稿章正文前有「草稿 · 尚未定稿」，`drafts=1`；定稿后用 final revision（`revisionIds` = final id，core 属性带 final id） |
| 同名不覆盖 | 同上 | 同一秒三次导出 → `-2` / `-3`，三份都存在；`scope:'chapter'` 缺 `chapterId` → `invalid_args`（code 断言） |
| DOCX E2E | `tests/e2e/export.spec.ts` | `E2E-M1-DOCX-01`：3 章各 G2 + 生成确认一拍 → 创作台「导出」对话框导出全书 → `exports/` 有 docx → XML 含 3 章标题与各自首段 + 「草稿 · 尚未定稿」+ 目录 → 无 Key / 日志 / secrets；两次直连导出 sha256 相同、字节相等、revision 计数不变 |
| Word 兼容 | Word（Office16）COM 打开样例 | `OPEN_OK pages=6 words=1130 paragraphs=65 toc=1 tocEntries=3 outlineHeadings=2`；本机未装 WPS |
| 性能 | `pnpm test:perf` | PERF-01：打开 2ms、切章 P95 1ms、检索 P95 25ms、导出 14ms（14.8 万字）、**DOCX 95ms / 20KB**、RSS 295MB；PERF-M1-01 不变（切章 P95 1ms、摘要 P95 1ms、RSS 149MB）；perf 夹具每拍加唯一前缀并断言 DOCX 可见正文 >12 万字（避免全篇同文导致压缩率虚高） |
| UI 巡检 | 临时 Playwright（已删） | 1440 / 1280 / 200%：导出对话框无按钮截断、无越界；200% 下卡片内滚动（与其他对话框一致） |
| 打包 | `pnpm dist` | `release/Noryth-0.1.0-setup.exe` 159MB（166,931,654 B）；`app.asar` 56MB；asar 内含 `node_modules/docx` 与 `node_modules/fflate`，docx 无 `.node` |
| 安装冒烟 | `node scripts/install-smoke.mjs` | PASS：`packaged=true/schema=10`、`embedder_ready source=model`、建项目、`user_version=10`、asar 断言 docx/fflate、卸载清理 |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具/schema 变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| 提交 | `45c4781`（feat）、`d880449`（docs） | 已推送 origin/dev |
| CI（功能与文档提交） | GitHub Actions run `44027558509`（`d880449`） | verify 1m44 + e2e 3m14 均绿；package 按规则跳过（非 `v*` tag） |
| CI（标签记录提交） | GitHub Actions run `44028518908`（`dd96cdc`） | verify 绿；e2e 在第 15 条（`memory.spec`）后早退（2m32，退出码 1 且 tail 里只有 `ok 6..15`、无失败用例）→ 同阶段 14/16 的 runner 偶发形态；该提交只改 PROGRESS 一行，代码树与 `44027558509` 相同 |
| CI（复跑） | GitHub Actions run `44029599184`（`22710d1`，空提交） | verify + e2e 均绿；package 按规则跳过 |
| CI（第三次早退） | GitHub Actions run `44030624768`（`f12c16b`，只改 PROGRESS） | 同一位置再次早退（`ok 15` 后 exit 1、无失败用例）；本地连跑 3 次 `pnpm test:e2e` 均 30/30（3.0m）→ 判定为 runner 侧静默终止，不是用例失败 |
| CI 可观测性 | `.github/workflows/ci.yml` | e2e 改为 `> e2e.log`（Node 写文件同步，进程被杀不丢尾），失败时 grep + tail 120 + annotation；新增崩溃诊断步骤（内存/磁盘、Top 进程、Windows Application 事件日志） |
| 按需加载 | `doc/export-docx.ts` | `await import('docx')`（模块级缓存）+ 顶层仅 type import；`out/main/index.js` 只剩 `import("docx")`；新增单测守住（PHASE-17 §7） |
| CI（按需加载后） | GitHub Actions run `44033017991`（`bd50c14`） | verify + e2e 均绿 |
| CI（分片） | GitHub Actions run `44034048165`（`d3ac330`） | verify 绿 + e2e (1) 1m58 / e2e (2) 2m23 均绿；第 1 片到 `memory.spec`，第 2 片从 `plan.spec` 起（干净 runner） |
| 阶段标签 | `phase-17-done` → `d3ac330` | 已推送 origin（该提交 CI 全绿：verify + e2e 两片）。`06a4596` / `0fb41b8` 只是文档提交；`0fb41b8` 之后的两次红是 runner 在 e2e 中途静默终止（无失败用例），不影响本标签 |

## 验证记录（阶段 18，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 319 modules / 1566 deps，0 违规（新增 `brand.ts`） |
| Lint | `pnpm lint` | 通过（新增 `update-drill.mjs` 的 window 全局 override） |
| 单元 + 契约 | `pnpm test:unit` | 794 passed（新增 tool-call 3 / migrator 0011 1 / brand-icon 4 / update 7 / security 3） |
| 集成 | `pnpm vitest run tests/integration` | 46 passed |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | 32 passed（新增 `E2E-M1-SMOKE` 2.7s、`E2E-M1-TOOLCALL` 3.3s；`app.spec` 增 `window.open` deny 断言） |
| 30 章长跑 | `pnpm build && pnpm test:e2e:m1a` | ok 20.8s：3 卷 × 10 章 / 540 拍；每 5 章 `project.verify` 绿；30 final / 30 final revision / 0 孤儿 / 0 `context_overflow` / 0 failed job / 30 摘要；私有内存 512MB（<600；ch5 之后基本平台期，增长在 +50% 门槛内），工作集合计 622MB（参考） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0011：`tool_call.chapter_id` 按 `turn_metric.beat_id→beat.chapter_id` 与 `job.payload_json.chapterId` 两条回填；规划调用保持 NULL；`tool_by_project` / `tool_by_chapter` 存在；迁后 `verifyDatabase` 绿 |
| 审计 repo | `tests/unit/db/tool-call.test.ts` | 章 / Agent / 状态过滤与计数同口径；50 条分页、时间倒序、上限 200；记录只有 `args_hash`，无参数原文 |
| 审计 E2E | `tests/e2e/audit.spec.ts` | `E2E-M1-TOOLCALL`：审批回合落库、按章/Agent 过滤、失败空态、页脚「共 N 条 · 第 1/1 页」、上一页禁用、无「重放」、API/UI/DB 三层都无 args |
| 图标 | `tests/unit/brand-icon.test.ts` + 打包 | PNG 512/各尺寸、ICO 7 个 32 位 BMP 条目、`--check` 与脚本一致；`pnpm dist` 无 rcedit 报错；`ExtractAssociatedIcon(win-unpacked/Noryth.exe)` 取到品牌图标（非 Electron 默认） |
| 更新 | `tests/unit/update.test.ts` + `scripts/update-drill.mjs` | 7 条：通道清单、预发布排序、stable 忽略预发布、同 minor `downgrade` / 跨 minor `downgrade_blocked`、HTTP 500 → failed 不阻塞；演练 PASS：manifest sha512、up_to_date / available / downgrade_blocked / failed 四态、真实下载且 sha512 一致 |
| 安全 | `tests/unit/security.test.ts`、`tests/e2e/app.spec.ts` | 窗口偏好被改坏会抛；导航白名单只放行 `app://noryth` 与 dev 同源；生产 CSP 禁网络；渲染层 `fetch` 被阻断、`window.open` 外部地址返回 null、无 `require`/`process` |
| 性能 | `pnpm test:perf` | PERF-01：打开 1ms、切章 P95 2ms、检索 P95 26ms、导出 14ms（148k 字）、DOCX 147ms、RSS 217MB；PERF-M1-01：打开 2ms、切章 P95 1ms、摘要 P95 1ms、RSS 150MB |
| 打包 | `pnpm dist` | `release/Noryth-0.2.0-setup.exe` 167,298,203 B + `latest.yml` + blockmap；win.icon 生效 |
| 安装冒烟 | `node scripts/install-smoke.mjs` | PASS：静默安装 → `version=0.2.0 / schema=11 / packaged=true` → `embedder_ready source=model` → 建项目 → `user_version=11` → `resources/icons/*` 随包 → 卸载清理 |
| UI 巡检 | 临时 Playwright 截图（已删除） | 审计面板 1440：初版有横向滚动条、无表头 → 改 `minmax(0,…)` 栅格 + 表头 + 隐藏横向溢出；设置页「更新」卡无截断 |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具/schema 变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
| 文档 | `docs/M1-ACCEPTANCE.md`、`docs/DEV-PLAN.md` v0.9、`docs/UI-DESIGN.md` §11、`docs/adr/0006-release-channel.md` | M1 五条证据；迁移/IPC/通道变更记录；审计面板与图标勾选；D2/D3/D5 分发决策 |
| 提交 | `857e92a`（feat）、`ef846cc`（docs） | 已推送 origin/dev |
| CI | GitHub Actions run `44045408802`（`ef846cc`） | verify 2m34 绿；e2e (1) 2m05 / e2e (2) 2m46 均绿；package 按规则跳过（非 `v*` tag） |
| CI（重跑确认） | run `44056729448`（`fd5a883`，仅文档） | verify + e2e 两片全绿；确认 `44055566898` 的 branch 失败为 runner 偶发 |
| 阶段标签 | `phase-18-done` → `1f2b668` | 已推送 origin；该提交 CI run `44049244747` 全绿 |
| CI（收口后文档提交） | run `44055566898`（`f58834b`） | verify 绿；e2e (1) `E2E-M1-BRANCH-01` 失败（36.5s；本地连跑 3 次 18s 全绿，同代码的 `ef846cc`/`1f2b668`/`fce9c49` 三次 CI 全绿）→ 判定 runner 偶发；e2e (2) 在 `slice.spec` 后静默早退（已知形态） |

## 验证记录（阶段 19，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 328 modules / 1608 deps，0 违规（新增 `voice/metrics.ts`、`voice/service.ts`、`review/voice.ts`） |
| Lint | `pnpm lint` | 通过（新增 `SceneVoiceBadge` / `VoicePanel` / 校准与基线脚本） |
| 单元 + 契约 | `pnpm test:unit` | 827 passed（新增 voice metrics 11 / service 7 / threshold 4 / no-prompt-leak 1 / voice-states 3；契约夹具 42×6=254） |
| 集成 | `pnpm vitest run tests/integration` | 48 passed（新增 `voice.spec.ts` 2：报告追加 voice 建议 + 重复不叠加 + 正文/revision 不变；高区分度不追加） |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | 34 passed（新增 `E2E-M2-VOICE-01`、`E2E-M2-METRICS-01`；`E2E-M0-A` schema 断言 11 → 12；`a11y` bridge 命名空间加 `voice`） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0012：`voice_metric` 表 + `voice_metric_by_chapter` 索引；`UNIQUE(scene_id, revision_id)` 拒绝第二行；外键拒绝缺失场景；删场景级联；迁后 `verifyDatabase` 无 error |
| 指标纯函数 | `tests/unit/voice/metrics.test.ts` | 11 条：分句（连续终止符/引号/纯标点丢弃）、直方图 6 桶、√JSD（同分布 0 / 不相交 1 / 空分布 0）、问句率、第一人称率、口头禅（角色卡 + 拍内 ≥3 次 n-gram）、两两公式、人数不足 `insufficientData`、两次 deep-equal、输入逆序同结果、三角色两两排序 |
| 指标服务 | `tests/unit/voice/service.test.ts` | 7 条：计算不落库；persist 只留一行且二次命中缓存；revision 变化 `stale=true` 并按新稿重算（同场景两行）；阈值版本变化覆盖同一行；`persist=false` 不写；空场景 `found=false` 不伪造 0 分；缺场景 `invalid_args` 且 sync 不抛 |
| 阈值一致性 | `tests/unit/voice/threshold.test.ts` | 4 条：常量 = `calibration-result.json`；语料 sha256 = `corpusHash`；FPR ≤5% / TPR ≥80% / 阈值在 [0.12,0.30]；等于阈值不告警 |
| 状态矩阵 | `tests/unit/voice-states.test.ts` | 3 条：missing / insufficient / low / ok 四态；文案唯一；UI 不出现 0.18 |
| 提示词隔离 | `tests/unit/voice/no-prompt-leak.test.ts` | `agents/prompts/**` 与 `context/**` 无 `voice_metric` / `distinctness` / `voice.metrics` |
| 语料校准 | `node scripts/calibrate-voice.mjs` | `zh-v1 = 0.252`；20 场 / 50 实例 / 50 同人对 / 40 异人对；同人误报 2.0%（1/50）、异人检出 97.5%（39/40）；结果文件与常量一致 |
| 质量基线 | `node scripts/m2-baseline.mjs <项目>`（`E2E-M2-METRICS-01` 内跑） | voice：3 场 / 3 对 / 3 场低于阈值 / 最低一对 0.00（假模型同构文本）；foreshadow：2 埋设 / 1 回收 / 1 未回收 / 回收率 0.5 / 超期 1 |
| 告警 E2E | `tests/e2e/voice.spec.ts` | `E2E-M2-VOICE-01`：2 角色各 2 拍 → 场景头徽标显示角色对与 `data-low=1`、展开见 `zh-v1` → G4 报告 1 条运行时 voice 建议（无阻断）→ 审批台逐角色表 + 两两矩阵 → G5/复检/G6 定稿 → G4 前后 draft 清单不变、`db.verify` 绿 |
| 性能 | `pnpm test:perf` | 2 passed（PERF-01 / PERF-M1-01 达标；指标层是纯函数，未进关账热路径以外的循环） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（T25 升 1.1.0 并启用；allowlist reviewer 20） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |

## 验证记录（阶段 20，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 335 modules / 1658 deps，0 违规（新增 `report/cost.ts`、`model/usage.ts`、`scheduler/forecast.ts`） |
| Lint | `pnpm lint` | 通过（新增 `CostReportDialog` / 基线脚本 / 两个 E2E） |
| 单元 + 契约 | `pnpm test:unit` | 840 passed（新增 forecast 5 / report cost 7 / migrator 0013 1） |
| 集成 | `pnpm vitest run tests/integration` | 58 passed（新增 `budget.spec.ts` 5、`usage.spec.ts` 5） |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | 36 passed（新增 `E2E-M2-BUDGET-01` 10.9s、`E2E-M2-COST-01` 6.7s；`E2E-M0-A` schema 断言 12 → 13；`a11y` bridge 命名空间加 `report`；provider 断言排除项目级规划行） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0013：`chapter.budget_cny`、`turn_metric.chapter_id`、两个索引；beat 指标按 `beat.chapter_id` 回填、规划行保持 NULL；CHECK 拒绝负预算；迁后 `verifyDatabase` 绿 |
| 双预算 | `tests/integration/budget.spec.ts` | 费用超限 `reason=cost` / token 超限 `reason=tokens`；`job.result_json.budget` 两套 limit/used/reason；提高预算恢复后已确认拍逐字不变、无重复暂停账本 |
| 出口优先 | 同上 | 预算 500 tokens、出口 `beats(1)`：1 拍后 `draft_complete`、无 paused 事件、`scene_closed(reason=exit_satisfied)` |
| 手动模式 | 同上 | 预算 0 时仍可逐拍生成；只提示 `budget.exceeded`，不暂停 |
| 预测 | `tests/unit/scheduler/forecast.test.ts` | 5 拍中位数 1400 × 4 = 5600（3920–7280）；不足 5 拍回落 900/拍；无计价 null；两次 deep-equal；只取最近 5 条 |
| 全链路计量 | `tests/integration/usage.spec.ts` | 写拍 `chapter_id` + `beat_id`；审批/讨论/记忆各 ≥2 行且 `beat_id=NULL`；规划 `chapter_id=NULL`；同 turn upsert 只 1 行；非写拍 `context_json` 只有 kind/prompt_version/toolset_version/block_tokens |
| 报表对账 | `tests/unit/report/cost.test.ts` + `E2E-M2-COST-01` | 合计 = `turn_metric` 直接汇总；`byChapter + projectLevel = total`；字数 = revision 清单；`costPer10k` 与字数一致；查询计数 ≤ 8；删除章显示「已删除章」 |
| 确认耗时 | `tests/unit/report/cost.test.ts` | 作者确认 500ms/300ms → samples 2、P50 400、P95 null（<5）；自动确认（无 `beat_confirmed`）计 missing 1 |
| 基线 | `node scripts/m2-cost-baseline.mjs`（30 章夹具） | 30 章 / 540 拍 / 2.73 万字 / 240 记忆；¥3.0912；¥1.1316 每万字；审批 40.06% / 角色 23.76% / 旁白 23.76% / 记忆 12.42%；确认 P50 23ms / P95 34ms（60 样本 / 480 缺失） |
| 性能 | `pnpm test:perf` | 2 passed（PERF-01 / PERF-M1-01 不变；报表不在关账热路径） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `70ea573`（feat + 文档） | 已推送 origin/dev |
| CI | GitHub Actions run `44920083884`（`70ea573`） | verify 2m34 绿；e2e (1) 2m24 / e2e (2) 2m33 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44920593930`（`49e541d`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-20-done` → `70ea573` | 已推送 origin |

## 验证记录（阶段 21，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| 依赖边界 | `pnpm depcruise` | 341 modules / 1717 deps，0 违规（新增 `model/health.ts`、`model/router.ts`、`review/calibration.ts`） |
| Lint | `pnpm lint` | 通过（新增 `RoutingCard` / 校准脚本 / routing 单测与 E2E） |
| 单元 + 契约 | `pnpm test:unit` | 857 passed（新增 routing 9 / calibration 4 / settings 2；契约夹具不变） |
| 集成 | `pnpm vitest run tests/integration` | 61 passed（新增 `routing.spec.ts` 3：429→下一拍备用、401 不切换、两家都失败 routing_exhausted） |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm exec playwright test --shard=1/2` + `--shard=2/2` | 19 + 19 = 38 passed（新增 `E2E-M2-ROUTING-01`、`E2E-M2-CALIBRATION-01`；`a11y` bridge 加 `routing`；settings 增加故障切换卡断言） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0013；未新增迁移，`LATEST_SCHEMA_VERSION = 13` |
| 设置兼容 | `tests/unit/settings/store.test.ts` | 旧设置文件缺 `routing` → 默认关闭；只改开关保留 agents；显式 agents 整表替换 |
| 路由决策 | `tests/unit/model/routing.test.ts` | 9 条：off 不切换；429 → 备用 + from/to/reason；auth/内容过滤/未勾选触发不记健康；3 次失败熔断 + 冷却半开 + 成功复位；两家失败 `routing_exhausted`；备用家资格（未测试/无工具/停用/无 Key/同家）；角色实例归一；重启清空 |
| 异构优先级 | `tests/unit/review/hetero.test.ts` | 9 条（新增 2）：第二家不健康 → 备用家 ≠ 生成家才兜底；备用家 = 生成家 → `hetero_unavailable`；异构关闭仍可按路由切 reviewer |
| 校准 | `tests/unit/review/calibration.test.ts` + `E2E-M2-CALIBRATION-01` | 同家/异构两组、阻断接受率、维度均值、费用与 D4 判定；IPC 与 `scripts/m2-calibration.mjs` 同口径；第二家未定价 `heteroDeltaPct=null` |
| 30 章校准 | `NORYTH_COST_BASELINE=1` 夹具 + `node scripts/m2-calibration.mjs` | 60 报告 / 60 阻断（60 接受）/ 120 建议（30 拒绝）/ 30 定稿；审批 ¥1.2384、生成 ¥1.4688；同家 60 / 异构 0；`heteroDeltaPct=null`；D4 保持 off |
| 路由 E2E | `tests/e2e/routing.spec.ts` | `E2E-M2-ROUTING-01`：主家 429 → 当前拍失败 → 下一拍备用 → 状态栏「备用 OpenAI」→ `turn_metric` provider/model + `context_json.routing` → job 快照仍 deepseek → 已确认拍逐字不变 → 审批报告 provider 正确 |
| 性能 | `pnpm test:perf` | 2 passed（PERF-01 / PERF-M1-01 不变；路由只做回合前一次判定） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 提交 | `7e8e833`（feat + 文档）、`825ea4c`（fix：routing_exhausted 补记 job failed） | 已推送 origin/dev |
| CI | GitHub Actions run `45384289571`（`825ea4c`） | verify 绿；e2e (1) / e2e (2) 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `45385713668`（`ed42ed5`） | verify + e2e 两片均绿；package 跳过；`edab431` 的 run 已取消（同一内容被 v0.13 变更记录取代） |
| 阶段标签 | `phase-21-done` → `825ea4c` | 已推送 origin |

## 当前可运行命令

- `pnpm dev` / `pnpm build` / `pnpm start`
- `pnpm typecheck` / `pnpm lint` / `pnpm depcruise`
- `pnpm test:unit`（878：unit+contract） / `pnpm vitest run tests/integration`（61）
- `pnpm test:perf`（PERF-01 + PERF-M1-01 + PERF-M2-01 基线；nightly，不进提交门）
- `node scripts/m2-perf-report.mjs`（跑 100k 基线并输出 `out/perf/m2-perf-report.json` + `.md`）
- `pnpm test:chaos`（8 条 / CHAOS-01..09） / `pnpm test:e2e`（42）
- `pnpm build && pnpm test:e2e:m1a`（E2E-M1-A 30 章长跑；nightly/发布前）
- `pnpm build && pnpm test:e2e:m2a`（E2E-M2-A 30 章 / 10 万字长跑；nightly/发布前）
- `pnpm verify:embed`（bge 冷启动/单条/维度门槛；打包前手工跑）
- `node scripts/calibrate-voice.mjs`（声音阈值校准；固定夹具，不进提交门）
- `node scripts/m2-baseline.mjs <项目目录>`（只读质量基线：声音区分度 + 伏笔回收率）
- `node scripts/m2-cost-baseline.mjs <项目目录>`（只读成本基线：总费用 / 每万字 / 按章 / 按 Agent）
- `node scripts/m2-calibration.mjs <项目目录>`（只读异构校准：报告 / 代理接受率 / 维度 / 费用 / D4 建议）
- `node scripts/install-smoke.mjs`（安装冒烟：装 → 建项 → 卸载）
- `node scripts/update-drill.mjs`（更新演练：manifest 完整性 + 四态判定 + 下载）
- `node scripts/gen-icons.mjs` / `node scripts/gen-icons.mjs --check`
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 提交 | `eed3ef1`（feat + 文档）、`6306550` / `9553cc9`（docs：提交/CI/标签记录） | 已推送 origin/dev |
| CI | GitHub Actions run `44914033792`（`eed3ef1`） | verify 1m49（lint / typecheck / depcruise / unit 827 / chaos 8 / spec / gen / build）+ e2e (1) 2m03 / e2e (2) 1m59 均绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | GitHub Actions run `44914510581`（`6306550`）、`44915039757`（`9553cc9`） | verify + e2e 两片均绿；package 跳过 |
| 阶段标签 | `phase-19-done` → `eed3ef1` | 已推送 origin |
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
| 场景多对多 | 规划期空场景可链接多章；演出后 live 拍只属一个演出章；别的章是只读引用，链接/生成都要求先 fork；有 live 拍时改章内顺序必须走分镜 + 重新开演（正文顺序是 revision 的一部分） | `scheduler/scene-library.ts`、`db/repos/scene.ts` |
| 引用场 | 引用场不进本章 revision 清单与 hash；`readChapterStoryboard` 只返回本章拍；G2 物化保留引用链接并排在草案场次之后 | `scheduler/storyboard.ts`、`doc/commit-beat.ts` |
| fork | 复制 scene + live 拍（新 id、`waiting_for_human`/`proposed`）+ 新建本章 revision；不复制 `supersedes_id`（新血统，避免 `beat_supersedes_once` 与追溯链分叉）；原章不动 | `scheduler/scene-library.ts` |
| 时间三轴 | `story_start/end` 自由文本只展示；`idx` = `chapter.ord`；`timeline` = main/flashback/dream；闪回永不参与故事时间比较；`timeline_non_monotonic` 仍只看 `beat.seq` | 迁移 `0008_story_time.sql`、`db/repos/scene.ts` |
| T23 | 与 `write.timeline` 共用 `queryTimeline`；输出是 §5.2 形状的超集（每拍多 `timeline`，另加 `scenes[]`）；`as_of` 超章水位 → `stale_revision`；`enabled: true` 打开 | `tools/support/timeline.ts`、`tools/manifests/knowledge.ts` |
| 工具计数 | `M0_TOOL_COUNTS` 只数 `milestone=M0`（PRD §4.11 基线 36 不变）；新增 `TOOL_COUNTS` 记录当前启用数；`check_tool_spec.py` 仍数 `m0=true` | `scripts/gen-tools.mjs`、`generated/allowlist.ts` |
| G2 回写 | 物化后把 `scene_id` 写回分镜草案：编辑器据此显示三轴、场景库据此判定「已在本章演出」，重复保存不会重复建场景 | `scheduler/storyboard.ts` |
| as-of 水位 | 章节认知水位统一由 `context/sources.resolveChapterAsOf` 决定：write = 本章 covered（新章取前一章），review = 本章 covered 且为 0 拒绝；`project.seq_head` 不再作为 Agent 上下文水位 | `src/main/context/sources.ts`、`review/run.ts` |
| 世界投影 | `world/projection.ts` 纯函数：事实按自身 valid_from/to、信念按 learned_seq、边按 since/valid_to；读者已知只认 `public + reveal_seq ≤ as_of`；`futureFacts`（还不存在）与 `notYetRevealed`（读者未知）分开计数 | `src/main/world/projection.ts` |
| 作者事实 | 作者写入口只有 `world.fact.add` / `world.fact.close` → `applyAuthorFact`（单一事务 + 审计 actor=author）；单值槽按谓词登记表（`MULTI_VALUE_PREDICATES`），新值先关旧值，回填早于当前值被拒 | `src/main/world/author-facts.ts`、`memory/apply.ts` |
| 定稿检索 | `manuscript.search_final` / `manuscript.get_final_chapter` 只返回 `chapter.ord ≤ 当前章` 的定稿；显式请求更晚章 → invalid_args（details 带 currentOrd） | `tools/manifests/knowledge.ts` |
| 上下文检查器 | 数据源 `turn_metric.context_json`；`beat_id` 沿 supersedes 链查最近一条（生成记的是槽位拍）；只读、不回传被裁正文、显示估算 + 上次实际 ratio | `scheduler/service.ts`、`renderer/pages/write/ContextInspector.tsx` |
| 按章重建 | `memory.rebuild(chapterId)` + `author_confirm`；重建专属抽取 job（幂等键与首次抽取分开）→ 单事务清旧 + 写新；旧条目 `inactive`、旧事实/边按来源关闭（`author` 不失效）、旧信念软失效；重放 duplicate | `memory/rebuild.ts`、`memory/apply.ts` |
| 重建关闭序 | `min(本章 covered_until_seq, 新提案同槽位最早 seq)`；同槽位旧值在新值出现处结束，不再出现的旧值关在章末；事实来源是提案 id、边来源是记忆 id（两张映射表） | `memory/apply.ts` |
| 关系图 | 数据源 `world/projection` 的边规则 + active 角色；纯函数确定性圆环（两位小数）；同轴反向边 = 双向（实线），否则虚线 + 箭头；来源只给「章 · 记忆/拍」，不显示正文；`focusId` 只留邻域 | `world/relations.ts`、`renderer/pages/memory/RelationshipGraph.tsx` |
| 关系回放 | `relationship_edge` 必须读全量行（含已关闭）：`RelationshipRepo.listByProject`；阶段 13 的 projection 同步改用，否则滑杆回到过去时边消失 | `db/repos/world.ts`、`world/service.ts` |
| 索引重建 | 只重算 active 且 `embedding_model != 当前模型`；32 条/批、每批事务（删旧向量 + 插新向量 + 改模型名）；job `result_json {total,rebuilt,done}` 作续跑点；令牌在收尾事务消费 | `memory/reindex.ts` |
| bge 随包 | 权重 24MB（q8/512）进 `resources/models`；`@huggingface/transformers` 进 dependencies；打包排除 onnxruntime-web 与 linux/darwin/arm64、DirectML（只留 win32-x64 CPU 28MB）；冷启动 134ms | `electron-builder.yml`、`resources/models/`、`docs/adr/0004-embedding.md` |
| 覆盖检查 | 唯一实现在 `plan/coverage.ts`（纯函数）；4 类规则里只有「关键事件无落点 / 角色无出场章 / POV 不存在或归档」阻断 G1，主线间隔与未标注只建议；开关在 `project.metadata_json.coverage_gate`（默认开、G1 前有效） | `plan/coverage.ts`、`plan/g1.ts`、`CoveragePanel.tsx` |
| 覆盖输入 | `outline_node.meta_json` 是唯一输入，形状 `{key_events, character_ids, pov_character_id, mainline}`；未知字段丢弃；旧行 `{}` 只给建议，不阻断 | `shared/schema/blueprint.ts`、迁移 `0009_blueprint_ops.sql` |
| 影响分析 | 两条路径并集：outline 子树 → 章 → 记忆；角色卡 → 发言 live 拍 → 章 / 记忆 → 以记忆为来源的边；只算 active 记忆与未关闭边；纯函数 `computeImpact` | `plan/impact.ts` |
| 变更流程 | T29 写 `blueprint_change(status=proposed)`（side_effect=propose）；应用要求 `impact_json.analyzed===true`，否则 `invalid_args`；G1 前只能「应用建议」，G1 后 `applyProposal` 拒绝蓝图提案 | `plan/change.ts`、`tools/manifests/verify.ts` |
| 跨章标脏 | 应用变更只写 `chapter.invalidated_at/reason` + 一条 `write_message` 系统提示；不建 revision、不改正文/章状态；已定稿章同样只标脏；作者可「忽略」清两列 | `db/repos/chapter.ts`、`plan/change.ts` |
| 伏笔 | 作者手写标注（埋设章 / 计划回收章 / 回收章）；距离 = 当前章 ord − 埋设章 ord；超期只标「已 N 章未回收（超计划）」；不自动回收、不进检索、不阻断 | `world/foreshadow.ts`、`ForeshadowPanel.tsx` |
| T31 契约 | ops 允许 `meta`（结构化纲要素）；G1 后返回 `requires_change=true`，提案只能作为变更流程输入 | `tools/manifests/propose.ts`、PRD §4.10 |
| 重开定稿 | `finalized → revising`；新 draft（parent=final，复制清单，`branch_id=NULL`）；旧 final 保留；`write_epoch+1`；正文仍只有 `commitBeat`/patch/finalize 写 | `doc/reopen.ts`、`scheduler/transitions.ts` |
| 再定稿记忆 | 首次定稿入队 `memory.extract`；重开再定稿入队 `memory.rebuild`（payload 带 G6 记录）；后台执行失败不回滚定稿，任务标 failed + errorCode | `doc/finalize.ts`、`memory/service.ts` |
| 分支 | `revision_branch` 只承载 draft；final 永远 `branch_id=NULL`；开分支复制清单，head 随 commit/patch/fork 移动；切换只改 `current_revision_id`；不做合并 | `doc/branches.ts`、`db/repos/branch.ts`、迁移 0010 |
| 分支审计 | 开分支/切换写 `review_message` 系统消息（`scheduler_event.kind` 的 CHECK 不允许新类型，M1 不重建该表） | `review/service.ts` |
| 章末摘要 | finalize 同事务写 `chapter_summary`：首拍 + 末拍 + 本章新出现的客观公开事实 ≤5，≤300 tokens；不调模型、不写正文、不参与 hash；旧 final 摘要保留 | `doc/summary.ts`、迁移 0010 |
| L0 摘要 | `L0:summary:prev` 只在上一章有摘要时加；章纲先占位、摘要用剩余 L0 额度（≤300）；超预算先压 150 再整块丢（最近拍之后、pinned 之前） | `context/assemble.ts`、`context/budget.ts`、`context/sources.ts` |
| 异构复检 | `review.hetero=off/prefer` 默认 off；prefer 时 job 开始解析一次：生成 provider（turn_metric，缺失回退旁白）与 reviewer 相同且第二家已启用/已测试/有 Key → 切换；报告写 provider；无第二家 `degraded=hetero_unavailable` 不阻断 | `review/hetero.ts`、`review/run.ts`、设置页 |
| 分支 verify | `branch_head_invalid`（head 缺/跨章/非 draft）、`current_revision_not_in_branch`、`summary_revision_invalid` | `db/verify.ts` |
| 导出快照 | 三档格式（md/txt/docx）统一从 `revision_manifest` 渲染：`finalized` 章读 `final_revision_id`，其余章读 `current_revision_id` 并标「草稿」；不建 revision、不写 outbox、不动正文 | `doc/export.ts`、`shared/schema/export.ts` |
| DOCX 生成 | `docx`（纯 JS，运行时 `await import` 按需加载）+ `fflate`；标题页 → 目录（Heading1 自动条目 + `updateFields`）→ 每章分页 + 场景分隔 + 拍段落；首行缩进 2 字符；批注只做章末「修订建议」小节 | `doc/export-docx.ts`、`ExportDialog.tsx` |
| 导出一致性 | zip 条目时间固定 2000-01-01、core 时间归一化到导出日零点、`_TocN` 与 bookmark id 按出现顺序重编号；同一天同一清单两次导出字节一致（`sha256` 相同） | `doc/export-docx.ts` `normalizeArchive` |
| 导出文件安全 | 目标固定 `exports/`，解析后必须在目录内；同名追加 `-2`/`-3` 不覆盖；文件名只由书名/章名 + 时间戳生成，不接受路径入参 | `doc/export.ts` `resolveTarget` |

## 验证记录（阶段 22，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| Lint | `pnpm lint` | 通过 |
| 依赖边界 | `pnpm depcruise` | 344 modules / 1731 dependencies，0 违规 |
| 单元 + 契约 | `pnpm test:unit` | 873 passed（110 文件；新增 archive 5 / context-cost 4 / usage 5；retrieve 扩展 1） |
| 集成 | `pnpm vitest run tests/integration` | 61 passed |
| E2E | `pnpm test:e2e` | **41 passed**（3.9m；新增 `E2E-M2-ARCHIVE-01`、`COST-M2-02` 两条） |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| 性能 | `pnpm test:perf` | 2 passed（PERF-01 / PERF-M1-01，基线未回退） |
| 迁移 | `tests/unit/migrator.test.ts` | 0001→…→0014；旧 memory_audit 行逐列保留、CHECK 接受 archive/restore、`memory_entry_archive` 索引存在；`db.verify()` 绿；`LATEST_SCHEMA_VERSION = 14` |
| 归档候选 | `tests/unit/memory/archive.test.ts` | 只 experience；fact/relationship/cognition/pin/高重要度/被引用/待决策提案都不进入；确定性两次相同；keeper 文本/余弦与相似度；软归档 `status` 不变、向量仍在；坏令牌零写入；重放不双写；签发后失效项 `skipped` 且有效项照常写入；恢复清两列 + restore 审计 |
| 检索口径 | `tests/unit/memory/retrieve.test.ts` 扩展 | 归档后 pinned / bigram / LIKE / `retrieveOwn` 都不命中；恢复后重新命中；缓存需失效（生产入口已清） |
| 归档 E2E | `tests/e2e/archive.spec.ts` | 14 提案 → 全部接受 → 8 条记忆 → 维护 1 条候选 → 归档 → 已归档 1、候选 0 → 角色记忆「仅已归档」1 条 → 召回不含归档 ID（keeper 仍命中）→ 恢复 → archived_at NULL / counts 0；revision 行与 content_hash 不变、memory_vec/fts 行数不变；audit archive 2 / restore 1 |
| 上下文成本 | `tests/unit/context/cost.test.ts` | 180 拍：中位数 2,725 → 2,167（**−20.5%**）；P95 2,736 → 2,176（不升）；`context_trimmed` 0% → 0%；overflow 0；按层 L2 1,156.7→970.7、L3 592→296；块去重/L3 上限/确定性断言 |
| 缓存指标 | `tests/unit/model/usage.test.ts` + `tests/e2e/context-cost.spec.ts` | OpenAI/DeepSeek 两种字段都解析；未报告 NULL；640/1000 = 64% 落库、检查器与成本对话框显示 640 · 64%；未报告显示「未报告」（`cacheCalls=0`、`hitRate=null`） |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具/schema 生成物变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 基线 | `docs/M2-CONTEXT-COST.md` | 前后按层 token、单拍/每万字成本、缓存命中、样本与局限 |
| CI（首次） | run `45394778424`（`fe831da`） | verify 绿、e2e (1) 绿；e2e (2) 在 `E2E-M1-SWITCH-01` 读到空状态文案（切回 A 后立即读 innerText 的竞态） |
| 竞态修复 | `tests/e2e/switch.spec.ts` | `toHaveText` 自动重试（语义不变）；单跑 3 passed |
| CI（收口） | run `45395894252`（`536b7db`） | verify + e2e 两片全绿；package 按规则跳过（非 `v*` tag） |
| CI（文档提交） | run `45397201830`（`71a6a8a`） | verify + e2e 两片全绿 |
| UI 巡检 | 1440×900 截图（临时 spec，已删） | 维护 tab 候选行原为无样式内联文本、reason 显示英文；`706b62c` 补网格/已归档行/左对齐并把 `duplicate_experience` 映射为「重复经历」；复查无裁切/溢出 |
| CI（UI 修复） | run `45398509831`（`706b62c`） | verify + e2e 两片全绿；package 跳过 |
| 阶段标签 | `phase-22-done` → `706b62c` | 已推送 origin（UI 修复后从 `536b7db` 移动） |

## 验证记录（阶段 23，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| Lint | `pnpm lint` | 通过（新增 perf 夹具 / 报表脚本 / 分页组件） |
| 依赖边界 | `pnpm depcruise` | 345 modules / 1,733 deps，0 违规 |
| 单元 + 契约 | `pnpm test:unit` | 878 passed（111 文件；新增 renderer pagination 5） |
| 集成 | `pnpm vitest run tests/integration` | 61 passed |
| E2E | `pnpm test:e2e` | **41 passed**（4.0m；含 `E2E-MEMORY-01`、`E2E-M2-ARCHIVE-01`） |
| 性能 | `pnpm test:perf` | 4 passed（PERF-01 / PERF-M1-01 / PERF-M2-01 夹具确定性 + 100k 基线） |
| 100k 基线 | `node scripts/m2-perf-report.mjs` | 打开 P95 31.6ms / 切章 1.3ms / T23 0.2ms / 检索 8.8ms / 装配 4.8ms / 报表 1.7ms / 声音 1.4ms / 归档 30.3ms；MD 16.7ms / DOCX 203.4ms；RSS 254.2MB；查询 8/9/8/4 |
| 旧基线回归 | `pnpm test:perf` | PERF-01：打开 1ms / 切章 P95 1ms / 检索 P95 3ms（原 23–27ms）/ 导出 15ms / DOCX 102ms / RSS 308MB；PERF-M1-01：切章 2ms / 摘要 1ms / RSS 149MB |
| 迁移 | `tests/unit/migrator.test.ts` | 未新增迁移，`LATEST_SCHEMA_VERSION = 14`（0015 未使用） |
| 向量执行顺序 | `EXPLAIN QUERY PLAN` + `tests/perf/m2-scale.spec.ts` | `memory_vec CROSS JOIN memory_entry` 固定 vec0 先取 k 近邻；检索 P95 1,521ms → 9ms |
| 归档候选 | 同上 | 3,000 条 / 200 候选 / 50 上限，8 条语句、P95 30.3ms（文本键缓存 + 每角色一次向量批读） |
| 记忆台分页 | `tests/unit/renderer/pagination.test.ts` | 3,000 行 / 每页 50 / 页码夹紧；筛选变化回第 1 页；归档区同样分页 |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff（无工具/schema 变更） |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 基线文档 | `docs/M2-PERF-BASELINE.md` | 命令、机器、P50/P95、查询计数、优化依据、局限 |
| CI | GitHub Actions run `45416212068`（`fa3287d`） | verify 2m40 / e2e (1) 3m03 / e2e (2) 2m54 全绿；package 按规则跳过 |
| 阶段标签 | `phase-23-done` → `fa3287d` | 已推送 origin |

## 验证记录（阶段 24，本地）

| 门 | 命令 | 结果 |
|---|---|---|
| 类型 | `pnpm typecheck` | 通过（main + web 两套） |
| Lint | `pnpm lint` | 通过（新增 `m2-flow` / `m2-a` / `m2-smoke` / 长文本假适配器） |
| 依赖边界 | `pnpm depcruise` | 345 modules / 1,733 deps，0 违规 |
| 单元 + 契约 | `pnpm test:unit` | 878 passed（111 文件） |
| 集成 | `pnpm vitest run tests/integration` | 61 passed（含预算出口优先） |
| 混沌 | `pnpm test:chaos` | 8 passed / CHAOS-01..09 |
| E2E | `pnpm test:e2e` | **42 passed（4.1m；新增 `E2E-M2-SMOKE` 3.6s）** |
| 100k 长跑 | `pnpm build && pnpm test:e2e:m2a` | **1 passed（27.8s）**：30 章 / 720 拍 / 142,344 字确认正文（`beat` 合计 160,887）/ 30 final / 每 5 章 verify / 0 孤儿 / 0 双活 / 0 failed / 0 overflow / 240 记忆 / 30 摘要 / 150 声音行 / 6 Agent / 伏笔 3-2-1 / 私有 514–520MB（ch5→ch30 1.29×）/ 最慢章 1.26s |
| M1 长跑回归 | `pnpm build && pnpm test:e2e:m1a` | 1 passed（21.6s）/ 1 skipped（成本夹具默认 skip）；30 章 / 私有 514MB |
| 性能 | `pnpm test:perf` | 4 passed：PERF-01 打开 2ms / 切章 1ms / 检索 P95 3ms / 导出 13ms（148,104 字）/ DOCX 111ms / RSS 307MB；PERF-M1-01 打开 3ms / 切章 1ms / 摘要 1ms / RSS 150MB；PERF-M2-01 打开 31.1ms / 切章 1.2ms / T23 0.4ms / 检索 8.7ms / 装配 5.2ms / 报表 1.6ms / 声音 1.1ms / 归档 29.9ms / MD 14.9ms / DOCX 207.1ms / RSS 258.5MB / 查询 8-9-9-8-4 |
| 预算证据 | `tests/e2e/budget.spec.ts` + `tests/integration/budget.spec.ts` | E2E：¥0.01 暂停 → 提高 → 恢复 → `draft_complete`，`job.result_json.budget` 两套数字；集成：出口优先（预算 500、`beats(1)` 1 拍收束） |
| 声音 / 伏笔基线 | `node scripts/m2-baseline.mjs <长跑项目>` | 90/90 场景、270 对、0 低于阈值、最低 0.4333；伏笔 3 埋设 / 2 回收 / 1 open、回收率 0.667、超期 1 |
| 成本基线 | `node scripts/m2-cost-baseline.mjs <长跑项目>` | ¥3.67252 / 142,344 字 = ¥0.2580 每万字；分章 0.12208–0.1248；角色 42.22% / 审批 33.72% / 旁白 13.33% / 记忆 10.46% / 规划 0.20% / 编排 0.07%；872 有计价 / 0 无计价 |
| 迁移 | `tests/unit/migrator.test.ts` | 未新增迁移，`LATEST_SCHEMA_VERSION = 14` |
| 构建 | `pnpm build` | 通过 |
| 生成物 | `pnpm gen:check` | 51 清单 + 2 生成模块 + grid，0 diff |
| 规格脚本 | `check_ui_spec.py` / `check_tool_spec.py` | PASS：PRD 42 / 清单 50（系统 8）/ M0 36 |
| 图标 | `node scripts/gen-icons.mjs --check` | `icons ok: 9 files` |
| 打包 | `pnpm dist` | `release/Noryth-0.3.0-setup.exe` 167,340,425 B（≈159.6MB）+ `latest.yml` + blockmap |
| 安装冒烟 | `node scripts/install-smoke.mjs` | PASS：0.3.0 / schema 14 / packaged=true / `embedder source=model` / `user_version=14` / 卸载清理 |
| 更新演练 | `node scripts/update-drill.mjs` | PASS：manifest sha512 / up_to_date / available / downgrade_blocked / failed / 真实下载 |
| 基线文档 | `docs/M2-ACCEPTANCE.md` | PRD M2 四条证据 + 内测清单 + 已知问题 + 复跑命令；`M2-CONTEXT-COST` §7 / `M2-COST-BASELINE` §9 / `M2-METRICS-BASELINE` §3.1 / `M2-PERF-BASELINE` §7 已更新 |
| 未执行（人工/外部） | — | 作者 7 天自测 / 每千字净操作时间 / 外部试用；GitHub Release 上传与 feed；Win10 22H2（作者决定不测）；真实第二家 Key（作者决定不测） |

## 当前阻塞

- 阶段 23 已 `done`（2026-11-24）：M2-6 10 万字性能专项——`PERF-M2-01` 夹具（30 章 / 720 拍 / 119,660 字 / 3,000 记忆 / 90 声音行 / 153 成本行 / 12 伏笔，确定性计划）、`scripts/m2-perf-report.mjs`、`docs/M2-PERF-BASELINE.md`；修复 vec0 KNN 被 SQLite 反选外循环（`CROSS JOIN`，检索 P95 1,521→9ms）、检索/归档批量取数、声音角色卡缓存、记忆台分页 50；无迁移（`LATEST_SCHEMA_VERSION = 14`，0015 未使用）。本地门禁全绿（unit 878 / integration 61 / e2e 41 / perf 4 / build / gen:check / 规格脚本）；CI run `45416212068` 全绿；标签 `phase-23-done` → `fa3287d`。
- 阶段 24 `in_progress`（2026-11-24）：代码、全量门禁、100k 长跑、0.3.0 打包、安装冒烟与更新演练全部完成；PRD M2 四条有证据（`docs/M2-ACCEPTANCE.md`）。**待作者**：7 天自测 / 每千字净操作时间 / 外部试用，或明确豁免；在此之前 `docs/M2-ACCEPTANCE.md` 的自签与 `phase-24-done` 标签保持未完成（推送后补 CI run id）。
- **作者决定不测的外部依赖（2026-11-17，不阻断 M1/M2 收口）**：
  - Windows 10 22H2 安装冒烟：本机只有 Win11，未执行；在 Win10 VM 上跑 `node scripts/install-smoke.mjs`（PHASE-18 §7）。
  - 真实第二家供应商补测：无 DashScope/Moonshot Key；ADR-0003 记录，M1-26。
  - 更新演练的「安装 → 重启 → schema 迁移」：脚本只覆盖检查/判定/下载；发布前在干净机手动演练一次（同 §4 的 feed 格式）。
- 遗留观察（不阻塞）：阶段 12 的文档提交 run `43708534963`（`37af4db`）e2e 在第 10 条（provider）之前中断：日志只有 `Downloading Electron binary...`，前 9 条已 `ok`，verify 全绿。形态与阶段 11 的 `43699407599` 一致（runner 上 `node_modules/electron/dist` 不可用），判断为环境偶发；复跑记录见「验证记录（阶段 12）」。
- CI e2e 静默早退（不阻塞验收）：阶段 17 的 5 次 run 里 3 次在 `ok 15`（`memory.spec`）之后 exit 1、日志无失败用例（本地连跑 3 次 30/30）。已把 e2e 分两片——第 1 片到 `memory.spec` 结束、第 2 片从 `plan.spec` 起在干净 runner 上——并加崩溃诊断（内存/磁盘、Top 进程、Windows Application 事件日志、`> e2e.log` 同步落盘）。若再现，按诊断步骤定位是 OOM 还是应用崩溃，再决定是否拆更多片。
- 真实模型 Key：设置页（阶段 10）已接管——Key 经 safeStorage 加密存 `%APPDATA%/noryth/secrets.bin`，环境变量只做兜底（`NORYTH_<PROVIDER>_API_KEY` / `NORYTH_WRITE_API_KEY` 等）；未配置时失败为 `model_auth`，不伪造正文、报告或提案。E2E 用 `NORYTH_*_FAKE=1` 假适配器，生产包不认。
- 真实第二家供应商（DashScope/Moonshot）：**作者决定不测（2026-11-17）**；见 `docs/adr/0003-providers.md` 与 `docs/BACKLOG.md` #11（M1-26）。
- 已知缺口（不阻塞）：
  - **bge 已随包**（阶段 14）：`resources/models/bge-small-zh-v1.5/`（q8 24MB）；`pnpm verify:embed` 冷启动 134ms、单条 6ms、512 维；安装包 157MB（<250MB）；`install-smoke` 断言运行日志 `source=model`。换模型或首次启用走记忆台「重建索引」（分批 32、可恢复）。权重通过 hf-mirror 预置（huggingface.co 直连仍超时），将来升级模型时沿用同一目录结构。
  - 文件树抽屉（Ctrl B）已在阶段 11 交付（W2/W3 overlay 320、焦点进出、200% 缩放）；W1 常驻树的 Ctrl+B 收起仍未做（不阻断验收）。
  - Windows 10 22H2 安装冒烟未执行（本机 Win11 PASS，schema 11）；作者决定不测（2026-11-17），有 VM 时补跑 `node scripts/install-smoke.mjs`。
  - 自动更新：阶段 18 已交付三通道 / 同 minor 回退 / 手动检查 / 演练（`update-drill` PASS）；`NORYTH_UPDATE_FEED` 未配置时仍为 `disabled`，首个 release tag 时填 feed。
  - 按章重建（T40）与关系图已在阶段 14 交付；「按章重建」作用于**当前 final revision**。重新打开定稿（M1-21）已在阶段 16 交付：旧 final 保留、新 draft、再定稿自动入队 `memory.rebuild`。关系图只读、无编辑与自动识别关系变化（M2）。
  - 世界状态作者编辑器已在阶段 13 交付（新增/关闭事实、单值槽 supersede、审计）；批量编辑/导入/导出设定集是 M2。
  - `tool_call` 审计面板已在阶段 18 交付（M1-23）：迁移 0011 归属列、`memory.toolCalls` 只读分页、记忆台「审计 → 工具调用」；仍不显示参数原文、不提供重放。
  - 上下文检查器已在阶段 13 交付；<1600 宽度用对话栅内嵌（UI-DESIGN §2.6 的模态变体未做，未进验收）。分支树与重新打开定稿已在阶段 16 交付（只对比/切换，不做合并——M2；异构复检默认 off，评分校准 M2-8）。`summary.prev` 只影响 L0 预算，不写 system 提示词；角色/旁白仍按 PRD §8.1 只拿脱敏目标，跨章连续性靠检索。
  - 「预览 tab 上限 6」当前无对应界面：预览区只有正文/分镜两个视图 tab；多文档 tab 仍是 M2 候选（阶段 13 的上下文检查器最终用了对话栅内嵌）。W1 常驻树的 Ctrl+B 收起同样后置（不阻断验收）。
  - 关系图 >50 角色用「聚焦某角色邻域」而不是分页；未引入 canvas（SVG + memo，30 角色无压力，未做 50+ 专项 perf）。
  - 覆盖检查只做确定性规则（4 类 + 未标注建议），语义级「章纲与角色卡冲突」仍靠审批；自动语义识别是 M2。
  - 蓝图变更是「记录 + 标脏」，不自动重写下游正文（PHASE-15 §2.2 明确不做）；影响分析不预测语义漂移，只给结构影响面。
  - 伏笔只有作者手写标注（M1）；自动识别与「伏笔回收提示」进审批报告是 M2。

## 下一阶段交接

- 阶段 20 已 `done`（2026-11-21）；M2-1/M2-2/M2-3/M2-5 交付（声音 / 预算 / 成本报表）。阶段 18 的 M1 收口证据见 `docs/M1-ACCEPTANCE.md`。
- 作者决定不测的两项外部依赖（2026-11-17）：
  1. Win10 22H2 VM 安装冒烟（`node scripts/install-smoke.mjs`；不阻断 M1）；
  2. 真实第二家供应商 Key（ADR-0003 / M1-26；不阻断 M1）。
- 发布前可选动作：更新演练的人工「安装 → 重启 → schema 迁移」一次（脚本已覆盖检查 / 判定 / 下载）。
- 阶段 18 直接复用（M2 会用到）：
  - **长跑脚手架**：`tests/e2e/m1-flow.ts` 的 `runChapter`（G2 → 2 拍 → 自动 → G4/G5 → 复检 → G6 → G7）与 `memoryMb`；新增章节场景只改 `write.devSeed` 的 `volumes/chaptersPerVolume/characters`，不要在测试里直接写库。
  - **只读校验**：`window.noryth.project.verify()`（仅 dev 注册）返回 `{ok, issues, stats}`；生产包调用返回 `invalid_args`。
  - **工具审计**：迁移 0011 后 `tool_call.chapter_id` 由 `invokeTool` 从 `TurnContext` 写入；新增运行时入口必须带 `chapterId`，否则面板按章过滤会漏。
  - **更新**：`runUpdateCheck` 是唯一入口（启动后台 + 设置页手动）；`NORYTH_UPDATE_CHANNEL` 选通道，`NORYTH_UPDATE_FEED` 指 feed 根；`allowDowngrade` 只在判定 `downgrade` 时打开。
  - **图标**：只改 `scripts/gen-icons.mjs` 再生成，不手改二进制；`brand-icon.test.ts` 会拦手改。
  - **导出**：`exportManuscript` / `renderDocx` 仍是唯一实现（阶段 17），新增格式先改 `shared/schema/export.ts`。
- M1 的关键回归（发布前每次都跑）：
  1. `E2E-M1-TIME-01`（闪回不误报，阶段 12）✅
  2. `E2E-M1-ASOF-01`（第 3 章读不到第 20 章事实，阶段 13）✅
  3. `E2E-M1-REBUILD-01`（按章重建旧记忆 inactive + 关系图回放 + 索引重建，阶段 14）✅
  4. `E2E-M1-BLUEPRINT-01`（蓝图变更必须过影响分析 + 标脏不改正文，阶段 15）✅
  5. `E2E-M1-BRANCH-01`（重开定稿 / 分支对比与切换 / 再定稿自动重建记忆，阶段 16）✅
  6. `E2E-M1-DOCX-01`（DOCX 通过，阶段 17）✅
  7. `E2E-M1-SMOKE`（3 章闭环，提交门）/ `E2E-M1-A`（30 章，nightly）/ `E2E-M1-TOOLCALL` ✅
- 阶段 23 已 `done`（2026-11-24，标签 `phase-23-done` → `fa3287d`）；M2-6 交付；`PERF-M2-01` 全部目标 PASS（数字见 `docs/M2-PERF-BASELINE.md`），旧 `PERF-01` / `PERF-M1-01` 未退化。阶段 24 开工：M2-10 100k 长跑 / QA / 内测 / M2 验收（`docs/PHASE-24-DELIVERY-M2.md`），版本 0.3.0，产出 `docs/M2-ACCEPTANCE.md`。
- 阶段 24 已执行（2026-11-24，状态 `in_progress` 等作者签字）：`E2E-M2-A` 30 章 / 142,344 字 / 27.8s、`E2E-M2-SMOKE` 3.6s、0.3.0 安装包 159.6MB、安装冒烟与更新演练 PASS。直接复用：
  - **长跑脚手架**：`tests/e2e/m2-flow.ts` 的 `seedLongrun`（3 卷 / 30 章 / 5 角色 / 3 场 × 8 拍，角色轮换）/ `runChapterM2`（章预算 + 编排回合 + 2 拍含重生成 + G4/G5/G6/G7）/ `launchM2` / `runPlanningTurn`；M1 的审批/记忆闭环从 `m1-flow.ts` 导出复用，不要复制第二份。
  - **长文本假模型**：`NORYTH_WRITE_FAKE_LONG=1`（未打包构建）每拍 ≥150 字、按「角色：<名字>」选句长/口头禅；改风格或长度会同时影响声音基线，改后重跑 `scripts/m2-baseline.mjs`。
  - **配置边界**：`playwright.m2a.config.ts` 只跑 `m2-a.spec.ts`；`playwright.m1a.config.ts` 已 `testIgnore` m2-a，`test:e2e:m1a` 不会重复跑 30 章 M2 长跑。
  - **nightly**：`.github/workflows/nightly.yml` 的 `m2-a` job（失败上传 `m2a.log` + `test-results/`）；只在默认分支 schedule / workflow_dispatch 生效。
  - **基线**：`docs/M2-ACCEPTANCE.md`（四条证据 + 内测清单 + 未执行项）；`M2-CONTEXT-COST` §7 / `M2-COST-BASELINE` §9 / `M2-METRICS-BASELINE` §3.1 / `M2-PERF-BASELINE` §7 已按长跑数字更新。
  - **待办**：作者 7 天自测 / 每千字净操作时间 / 外部试用 → 签字或豁免；`v0.3.0-m2.1` 标签与 GitHub Release 上传（NSIS + `latest.yml` + blockmap）属发布动作，未执行。
- 阶段 23 直接复用（阶段 24 会用到）：
  - **100k 夹具**：`tests/perf/m2-scale.spec.ts` 的 `buildPlan()` 是纯函数（显式 id、固定时钟、无随机数），阶段 24 长跑可直接复用同一计划生成 30 章 / 10 万字；`fixtureDigest()` 用于断言确定性。
  - **查询计数**：`startQueryCounter(db)` 包装 `db.prepare`，报表/声音/归档/检索的语句数上界在 perf 门里断言；新增查询路径时先想清楚是否随章数线性增长。
  - **vec0 执行顺序**：`memory-index.searchVector` 必须保留 `CROSS JOIN`；改回普通 JOIN 会让 SQLite 选 `memory_own` 当外循环，3k 记忆时召回退化到 ~1s（perf 门会红）。
  - **批量取数**：`MemoryRepo.listByIds` / `MemoryIndexRepo.readVectors` 是检索与归档的唯一批量入口；不要退回逐条 `get()` / `readVector()`。
  - **分页**：`shared/domain/pagination.ts` 的 `pageSlice` 是记忆台分页的唯一实现（每页 50）；新增 100+ 行列表优先复用 `VirtualList` 或 `pageSlice`。
  - **基线脚本**：`scripts/m2-perf-report.mjs` 只读 `out/perf/m2-perf-report.json`，不写库；CI 上不需要跑，nightly / 发布前跑。

- 阶段 22 直接复用（M2 会用到）：
  - **归档**：`buildArchiveCandidates()` 是唯一候选规则（只读、确定性）；写入只走 `archiveMemoryEntries()` / `restoreMemoryEntry()`（`memory/apply.ts`）；批次 id 用 `archiveBatchId(ids)`；令牌是 `author_confirm`（实体类型 `archive`），不是 G7。
  - **迁移 0014**：`memory_entry.archived_at/archive_reason`、`turn_metric.cached_tokens`、`memory_audit` CHECK 含 `archive/restore`；`LATEST_SCHEMA_VERSION = 14`。
  - **检索口径**：新增或修改任何记忆查询（向量 / FTS / LIKE / pinned / `listByCharacter`）必须带 `archived_at IS NULL`；归档/恢复后调用 `invalidateRetrievalCache(projectId)`，否则旧结果回魂。
  - **上下文成本**：`assembleContext()` 是默认优化档；`assembleContextBaseline()` 只用于同一夹具对照。任何新增裁剪都要保持 `context_json.trimmed` 可查、角色卡/禁揭/本拍意图不裁。
  - **缓存**：`recordTurnMetric()` 是唯一计量入口；`cached_tokens` 为 NULL 表示「供应商未报告」，报表与检查器都显示「未报告」。
  - **基线**：`docs/M2-CONTEXT-COST.md`（180 拍 −20.5%）；阶段 24 的 100k 长跑在同一文档更新整章口径。
- 阶段 21 开工（M2-4 / M2-8，`docs/PHASE-21-ROUTING-HETERO.md`）：显式故障切换与异构默认值；不改 0013 的 `turn_metric` 报表口径，路由只影响绑定解析与 `provider` 记录。M2 验收口径见 `docs/DEV-PLAN.md` §16.5 与 `docs/PRD.md` §10。
- 阶段 21 直接复用（M2 会用到）：
  - **路由**：`createRoutingRuntime()`（`src/main/model/router.ts`）是唯一入口；六个 Agent 在回合开始前调用 `route()`，成功后 `recordSuccess()`、失败后 `recordFailure()`；不要在适配器里重试或换家。
  - **健康**：`HealthRegistry`（`src/main/model/health.ts`）只在内存；3 次失败/5 分钟窗口/冷却半开都已固化，测试注入时钟；重启清空是刻意行为。
  - **留痕**：`turn_metric.context_json.routing` 由 `contextSnapshot` / `simpleContextJson` 写入；`job.payload_json.bindings` 永远是初始快照，实际 provider 以 `turn_metric` 为准。
  - **审批优先级**：`resolveHeteroReview()` 已带 `fallback` / `usable` 参数；先异构、后健康检查，备用家不得等于生成家。
  - **校准**：`buildCalibrationReport()`（`src/main/review/calibration.ts`）只读报告/patch/G6；`review.calibration` 与 `scripts/m2-calibration.mjs` 同口径；改 D4 默认值前先重跑 30 章夹具并更新 ADR-0009。
  - **设置**：`routing` 补丁只浅合并开关/触发/冷却，`agents` 整表替换；旧设置文件缺字段默认关闭。
- 发布注意：首个 release tag（`v0.2.0-m1.1`）时上传 `release/Noryth-0.2.0-setup.exe` + `latest.yml` + blockmap 到 GitHub Releases，并配置 `NORYTH_UPDATE_FEED`（或 electron-builder publish），否则更新状态为 `disabled`；安装包 159.6MB（上限 250MB）；保留上一版安装包供回滚（`release/` 不入库）。GitHub Release 上传尚未执行（见 `docs/M1-ACCEPTANCE.md` §6 第 8 条）。
- 阶段 20 直接复用（M2 会用到）：
  - **预算口径**：`chapterBudget()`（`src/main/scheduler/loop.ts`）同时返回 token/费用；`sumByChapter()`（`TurnMetricRepo`）按 `chapter_id` 汇总。新增报表或预算提示必须复用这两处，不要再写第二套口径。
  - **计量入口**：所有模型调用走 `recordTurnMetric()`（`src/main/model/usage.ts`）；turn_id 稳定 + upsert。新增运行时入口（例如路由探测）必须带 `chapterId` 或显式 NULL（项目级）。
  - **报表**：`buildCostReport()`（`src/main/report/cost.ts`）一次聚合 + 一次耗时样本；`report.cost` 只读 IPC。阶段 22/24 的上下文成本、100k 长跑都复用这个入口。
  - **迁移 0013**：`chapter.budget_cny`（NULL = ¥5.00）+ `turn_metric.chapter_id` + 两个索引；`chapter_id` 不设外键（删章保留审计）。`LATEST_SCHEMA_VERSION = 13`。
  - **计价**：只有 DeepSeek 预设写了折算价（¥2/¥8 每百万 token）；其他供应商保持 0 → 报表显示「费用为下限」。补真实价格前不要伪造。
  - **暂停账本**：自动模式没有独立 job 类型；预算暂停写 `scheduler_event(reason='budget_exceeded')` + 一条 `paused` 的 `beat.generate` 账本行（`result_json.budget`）。改 job 表结构前先评估恢复与诊断。
  - **基线**：`node scripts/m2-cost-baseline.mjs <项目目录>` 只读；夹具用 `tests/e2e-long/_cost-baseline.spec.ts`（默认 skip，`NORYTH_COST_BASELINE=1` 才跑）。阶段 24 的 100k 长跑用同一脚本更新数字。
- 阶段 19 直接复用（M2 会用到）：
  - **声音指标**：`computeVoiceMetrics` 是纯函数（无 import/无模型），新增指标先改 `src/main/voice/metrics.ts` 与契约测试；写入只走 `voice/service.ts`（`resolveSceneVoice` / `syncChapterVoice`）。
  - **阈值**：只读 `VOICE_THRESHOLD`（`src/shared/domain/voice.ts`）；换语料必须升 `version` 并重跑 `scripts/calibrate-voice.mjs`，不要手改 `calibration-result.json`。
  - **派生表**：`voice_metric` 以 `(scene_id, revision_id)` 唯一；读取时版本/稿不一致就重算覆盖，不追加历史。
  - **告警**：报告 `voice` 建议由 `review/voice.ts` 在 G4 后追加（`iss_voice_*`），只进建议；不要把 `voice` 加进 `BLOCKING_ISSUE_TYPES`。
  - **基线**：`scripts/m2-baseline.mjs` 只读，输出 JSON；`docs/M2-METRICS-BASELINE.md` 由作者抄数字，不自动改文档。
- 发布注意：首个 release tag（`v0.2.0-m1.1`）时上传 `release/Noryth-0.2.0-setup.exe` + `latest.yml` + blockmap 到 GitHub Releases，并配置 `NORYTH_UPDATE_FEED`（或 electron-builder publish），否则更新状态为 `disabled`；安装包 159.6MB（上限 250MB）；保留上一版安装包供回滚（`release/` 不入库）。GitHub Release 上传尚未执行（见 `docs/M1-ACCEPTANCE.md` §6 第 8 条）。
- 文档：`AGENTS.md` 随阶段 19 更新（阶段 19 状态、schema 12、校准/基线命令与声音铁律）；`docs/PHASE-19-VOICE.md` 验收清单已勾选，ADR-0007 与 `docs/M2-METRICS-BASELINE.md` 入库。

## 更新规则

1. 完成一个任务：更新对应阶段的「已完成」。
2. 阶段结束：填「验收」与「已知问题」，状态改 `done`。
3. 出现阻塞：状态改 `blocked`，写清缺什么、等什么。
4. 新会话开始：先读本文件，再读阶段文档。
5. 不把「写了代码」写成 `done`；只有验收清单全绿才是 `done`。
