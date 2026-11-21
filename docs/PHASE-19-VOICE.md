# 阶段 19 · 声音度量与漂移告警

> 阶段 19 / 24（M2 第 1 阶段）｜ 依赖：18 ｜ 下游：20–24
> 对应：`docs/DEV-PLAN.md` §12.6（M2-1、M2-2）、`docs/PRD.md` §4.10（T25）、§11（声音区分度）
>
> **一句话目标**：把「角色说话像同一个人」从主观印象变成每场可量化、可告警、可复跑的指标，并给出第一份质量基线。

## 1 本阶段要证明什么

| # | 假设 | 验证方式 |
|---|---|---|
| 1 | 每场关账后能算出每位在场角色的句长、口头禅、问句与第一人称指标 | T25 输出逐角色明细；同一 fixture 两次结果逐字段一致 |
| 2 | 两两区分度能定位到具体角色对 | `pairs[]` 含角色 id、区分度与分项差值；UI 显示最低的一对 |
| 3 | 0.18 不是拍脑袋的阈值 | 中文夹具语料重标，记录语料 hash、样本量与误报/检出 |
| 4 | 声音偏低只告警、不阻断 | 低区分度场景仍可 G6 定稿；报告只出 `voice` 建议 |
| 5 | 指标不污染正文与上下文 | 不写 `beat.body`、不产生 revision、不进入 L0–L3 提示词 |
| 6 | 伏笔回收率有可复跑口径 | 只读聚合 `foreshadow`，输出已回收/已埋伏笔与回收率 |

## 2 范围

### 2.1 做

- M2-1：`voice.metrics`（T25）从契约外壳变成实现；输出逐角色指标与两两区分度；T25 升 1.1.0。
- M2-1：中文阈值校准；阈值常量、语料 hash 与 ADR 一起入库；不再把 0.18 散落在 UI。
- M2-2：声音漂移告警：创作台场景头徽标、审批台「声音」面板、报告 `voice` 建议。
- 迁移 `0012_voice.sql`：`voice_metric` 派生表（按 scene + revision 保存）。
- 基线：`docs/M2-METRICS-BASELINE.md` 记录声音区分度与伏笔回收率；`scripts/m2-baseline.mjs` 只读输出 JSON。
- T25 在 `reviewer` 白名单启用：审批有效工具从 19 回到 PRD §4.11 的 20。

### 2.2 不做

- 不自动改角色卡、不自动重写正文、不自动判 `fail`；指标只是证据。
- 不把声音指标塞进 L0–L3 或系统提示词；提示词不承担质量判断。
- 不做盲测平台、不做外部语料采集、不做模型微调。
- 不自动识别伏笔；M2 只对 M1 作者标注的伏笔算回收率。
- 不做分支合并、模型摘要、项目模板与自动补旁白建议（保持 backlog）。

## 3 交付物

| 交付物 | 路径 | 验收 |
|---|---|---|
| 指标纯函数 | `src/main/voice/metrics.ts` | 分句、句长直方图、√JSD、口头禅、问句率、两两区分度 |
| 指标服务 | `src/main/voice/service.ts`、`src/shared/schema/voice.ts` | 按 scene/revision 计算、持久化、读取与 stale 判定；只读 IPC `voice.scene` |
| T25 | `src/main/tools/manifests/verify.ts` + `docs/tools/voice.metrics.json` | 1.1.0；输出是旧四字段的超集；空场景 `degraded='empty'` |
| 派生表 | `src/main/db/migrations/0012_voice.sql` | 旧项目升级后表存在；`LATEST_SCHEMA_VERSION = 12` |
| 创作台告警 | `src/renderer/pages/write/SceneVoiceBadge.tsx` | 低于阈值显示角色对与分项；可展开；不阻断确认 |
| 审批台面板 | `src/renderer/pages/review/VoicePanel.tsx` | 角色表 + 两两矩阵；显示阈值版本 |
| 基线脚本 | `scripts/m2-baseline.mjs` | 只读项目 DB；输出声音与伏笔回收率 JSON |
| 校准脚本 | `scripts/calibrate-voice.mjs`、`tests/fixtures/voice/zh-corpus.json` | 同人误报 ≤5%、异人检出 ≥80%；阈值版本与语料 hash |
| 基线报告 | `docs/M2-METRICS-BASELINE.md` | 方法、语料、阈值、误报/检出、伏笔回收率与局限 |
| ADR | `docs/adr/0007-voice-threshold.md` | 背景、选项、决定、后果、回退 |
| 测试 | `tests/unit/voice/metrics.test.ts`、`tests/integration/voice.spec.ts`、`tests/e2e/voice.spec.ts` | `E2E-M2-VOICE-01` + `E2E-M2-METRICS-01` |

## 4 任务分解

| ID | 任务 | 依赖 | 完成标准 |
|---|---|---|---|
| M2-1 | 声音指标与阈值校准 | B3、F4、G1 | 逐角色/两两指标可复算；阈值有语料与 ADR |
| M2-2 | 声音漂移告警 | M2-1、F5、G1 | 低区分度可见；G6 不被阻断；报告只出建议 |
| T25 启用 | 注册表 + 生成物 | C1、C2 | 审批 20 个工具；`gen:check` 0 diff |
| 0012 迁移 | `voice_metric` | B1 | 旧库升级；`db.verify()` 绿 |
| 质量基线 | 声音 + 伏笔回收率 | M2-1、M1-10 | 基线报告有可复跑数字；不新增自动识别 |

## 5 实现要点

### 5.1 指标定义（确定性优先）

取数只读 revision 清单：草稿用 `chapter.current_revision_id`，定稿用 `chapter.final_revision_id`；沿 `revision_beat` 取拍，只统计 `speaker_type='character'` 的正文。旁白不计入角色两两区分度，可单独作为场景参考。

| 指标 | 定义 |
|---|---|
| 分句 | 以 `。！？!?…` 与换行为界；保留引号；NFKC 后去空白；空句丢弃 |
| 句长 | 去空白后的字符数；直方图桶 `1–10 / 11–20 / 21–30 / 31–40 / 41–60 / 60+`，归一化 |
| 句长 √JSD | 两人句长直方图的 Jensen–Shannon 距离开方，底 2，范围 0–1 |
| 口头禅率 | 角色卡 `voice.catchphrase` 按 `、，,` 切分（2–8 字）∪ 该角色拍内重复 ≥3 次的 2–6 字 n-gram；含任一候选的拍占比 |
| 问句率 | 以 `？?` 结尾的句子 / 总句数 |
| 第一人称率 | 含 `我 / 我们 / 咱 / 俺` 的句子 / 总句数 |
| 两两区分度 | `clamp01(0.55 × √JSD + 0.15 × 口头禅率差 + 0.15 × 问句率差 + 0.15 × 第一人称率差)` |

- 场景汇总：`pairwise_distinctness` 取最低一对（最差的一对才是告警对象）；`sentence_length_jsd`、`catchphrase_rate`、`question_rate` 取各对的平均值，保持旧字段语义。
- 少于 2 个角色或某角色少于 2 拍：`pairs=[]`，工具层标 `degraded='empty'`；不把 0 当成「很区分」。
- 所有排序按 `(characterId, beatOrd)`；不使用 `Object.keys` 或 `Set` 迭代顺序。同一 fixture 两次调用必须逐字段相等。

### 5.2 阈值校准

- 语料放 `tests/fixtures/voice/zh-corpus.json`：20 场、5 个角色、每场 2–3 人、每人 8–12 拍；同一角色的拍分两半作为「同人对照」，不同角色同场作为「异人对照」。
- `scripts/calibrate-voice.mjs` 计算同人对照与异人对照的区分度分布，取 `TPR − FPR` 最大的阈值；要求同人误报 ≤5%、异人检出 ≥80%；结果 clamp 到 `[0.12, 0.30]`。
- 阈值写入 `src/shared/domain/voice.ts`：`VOICE_THRESHOLD = { version: 'zh-v1', distinctnessMin, corpusHash, calibratedAt }`；UI 与 T25 都读它，不写死 0.18。
- ADR-0007 记录：语料是夹具而非出版小说，阈值是起点；指标只告警，作者可忽略；换语料必须新版本号并重算历史 `voice_metric`。
- 校准脚本不进入提交门（依赖固定夹具，跑得动但不必每次跑）；CI 用固定阈值与 fixture 断言，避免阈值漂移。

### 5.3 告警路径

```
场景关账 / 审批 job 开始
  → voice/service.computeScene(sceneId, revisionId)
  → 纯函数 metrics.ts（无模型、无网络）
  → voice_metric 一行（scene + revision + threshold_version）
  → 创作台场景头徽标 / 审批台 VoicePanel / 报告 voice 建议
```

- 创作台：场景头显示「声音区分度 0.12 · 沈昼 / 林晚」；展开看分项；不弹窗、不禁用确认条。
- 审批台：`VoicePanel` 显示逐角色表与两两矩阵；报告里由运行时追加 `type='voice'`、`severity='suggestion'` 的条目（`voice` 已在 `BLOCKING_ISSUE_TYPES` 之外，天然不阻断）。
- 报告条目的证据只用指标与角色对，不复制正文；`issue_ref` 指向场景，不指向拍。
- 指标缺失（空场景、旧项目、无 revision）→ 面板显示「数据不足」，不伪造 0 分。
- 不新增闸门；`G6` 仍只由作者触发，声音低不进入阻断条件。

### 5.4 存储与读取（迁移 0012）

```sql
CREATE TABLE voice_metric (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  chapter_id        TEXT NOT NULL REFERENCES chapter(id) ON DELETE CASCADE,
  scene_id          TEXT NOT NULL REFERENCES scene(id) ON DELETE CASCADE,
  revision_id       TEXT NOT NULL REFERENCES revision(id) ON DELETE CASCADE,
  metrics_json      TEXT NOT NULL,
  threshold_version TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  UNIQUE (scene_id, revision_id)
);
CREATE INDEX voice_metric_by_chapter
  ON voice_metric(project_id, chapter_id, created_at);
```

- `metrics_json` 形状固定：`{characters[], pairs[], aggregate{...}, insufficientData}`；未知字段丢弃，由 Zod 解析。
- 计算时机：场景第一次 `closed` 时、审批 job 开始时、阈值版本变化后首次读取时；同一 `(scene_id, revision_id)` 只保留一行，重算覆盖。
- 读取：`voice.scene` IPC（只读）返回最新行；若 `revision_id` 与当前稿不一致，标 `stale=true` 并按需重算。写只发生在服务层，UI 不直接写表。
- `voice_metric` 是派生数据，不是正文或记忆；删除场景/章节时级联清理，不影响 revision。

### 5.5 基线报告（声音 + 伏笔回收率）

`scripts/m2-baseline.mjs` 只读打开项目 DB，输出：

```json
{
  "voice": {
    "threshold": {"version": "zh-v1", "distinctnessMin": 0.17},
    "scenes": 30,
    "pairs": 84,
    "belowThreshold": 6,
    "minPair": {"a": "沈昼", "b": "林晚", "score": 0.11},
    "sameCharacterFalseAlarm": 0.03,
    "differentCharacterDetection": 0.86
  },
  "foreshadow": {
    "planted": 12,
    "closed": 8,
    "open": 4,
    "payoffRate": 0.667,
    "overdue": 1
  }
}
```

- 数字写进 `docs/M2-METRICS-BASELINE.md`，并注明：夹具语料、假模型文本、阈值版本、统计口径。
- 伏笔回收率 = `closed / (open + closed)`；按卷另算一份；超期只报节奏，不报逻辑错误。复用 M1 的 `foreshadow` 表与 `world/foreshadow.ts`，不新增自动识别。
- `E2E-M2-METRICS-01` 在 fixture 项目上运行脚本，断言 `voice.pairs > 0`、`threshold.version` 非空、`foreshadow.planted > 0`、`payoffRate` 在 0–1；基线报告由阶段末人工更新实际数字，不用脚本直接改文档。

### 5.6 契约变更与兼容

- T25 输出从四个标量扩展为「旧四字段 + `characters[]` + `pairs[]` + `threshold`」；这是超集，旧字段语义不变。先写 `docs/PRD.md` 变更记录与 `docs/DEV-PLAN.md` 对应小节，再升 manifest 1.1.0 并重新生成 `docs/tools/voice.metrics.json`。
- T25 仍只允许 `reviewer` 调用；创作台通过 `voice.scene` IPC 读指标，不给 `write` 角色新增工具。`voice.scene` 是只读 IPC（Zod 入/出参），先写 `docs/DEV-PLAN.md` §4.3 的 IPC 表并同步 `shared/schema/voice.ts`，不改工具 manifest。
- `M0_TOOL_COUNTS` 保持 36；`TOOL_COUNTS` 记录审批 20；`check_tool_spec.py` 仍只数 `m0=true`。
- 不新增错误码；空场景用工具层的 `degraded='empty'`，不把「没数据」当失败。

## 6 验收清单

- [x] T25 实现并可调用：合法 `scene_id` 返回逐角色与两两指标；空场景返回零值 + `pairs=[]` + `degraded='empty'`（`tests/unit/voice/metrics.test.ts`、`tests/contract/tool-contracts.test.ts` 42×6）。
- [x] 同一 fixture 两次计算逐字段相等；不同角色顺序输入不改变结果（`tests/unit/voice/metrics.test.ts`：两次 deep-equal、输入逆序同结果）。
- [x] 0012 迁移：旧库升级后 `voice_metric` 与索引存在；`db.verify()` 绿；`LATEST_SCHEMA_VERSION = 12`（`tests/unit/migrator.test.ts`：唯一键 + 外键级联 + verify）。
- [x] 语料校准脚本可跑；阈值常量含 `version / corpusHash / calibratedAt`；ADR-0007 记录方法、样本与局限（`zh-v1 = 0.252`；20 场 / 50 同人对 / 40 异人对；FPR 2.0% / TPR 97.5%）。
- [x] `E2E-M2-VOICE-01`：构造一对低区分度角色 → 创作台场景头出现角色对与分数 → 审批台 VoicePanel 显示同一对 → 报告出现 `voice` 建议 → G6 仍可定稿 → G4 前后 draft 清单不变、`db.verify()` 绿。
- [x] `E2E-M2-METRICS-01`：基线脚本输出声音与伏笔回收率；`docs/M2-METRICS-BASELINE.md` 记录实际数字与口径（3 场 / 3 对 / 3 场低于阈值；伏笔 2/1/1，回收率 0.5）。
- [x] T25 在审批白名单启用（20 个）；`gen:check` 0 diff；`check_tool_spec.py` PASS（PRD 42 / 清单 50 / M0 36）。
- [x] 指标不进入提示词：`tests/unit/voice/no-prompt-leak.test.ts` 扫描 `agents/prompts/**` 与 `context/**`，无 `voice_metric` / `distinctness`；E2E 断言 G4 前后 draft 清单不变、不新增拍。
- [x] 门禁：`pnpm typecheck && pnpm lint && pnpm depcruise && pnpm test:unit && pnpm vitest run tests/integration && pnpm test:e2e && pnpm build && pnpm gen:check`（unit 827 / integration 48 / e2e 34 / chaos 8 / perf 2）。

## 7 风险与回退

| 风险 | 触发 | 回退 |
|---|---|---|
| 阈值误报高 | 同人对照分数偏低 | 只告警；作者可忽略；换语料升阈值版本，不改 G6 |
| 分句不准 | 引号/省略号把一句切碎 | 固定分句规则 + 20 条中文样例单测；先修规则再调阈值 |
| 草稿与定稿混算 | 同一场 revision 变化后指标不一致 | `voice_metric` 以 revision 为键；读取时 stale 判定 |
| 指标被当成质量结论 | 作者以为低分必须改 | UI 文案写「提示，不阻断」；报告只出建议；ADR 记录 |
| 范围蔓延到自动改写 | 要求「自动修声音」 | 本阶段明确不做；自动改写属于另一个产品决策 |
| 计算拖慢关账 | 24 拍场景计算过慢 | 纯函数 O(拍数)，无模型；阶段 23 用 100k 项目复测 |

## 8 进入下一阶段的条件

1. T25 与 `voice.scene` 可用，逐角色/两两指标可复算。
2. 阈值有语料、版本与 ADR，不在 UI 写死 0.18。
3. 创作台/审批台告警可见，G6 不被阻断，正文与 revision 不变。
4. 0012 迁移与 `db.verify()` 全绿。
5. 声音与伏笔回收率基线报告有可复跑命令与数字。
