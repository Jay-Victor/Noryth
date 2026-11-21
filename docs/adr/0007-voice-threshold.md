# ADR-0007 声音阈值：中文合成夹具校准 `zh-v1` = 0.252，只告警不阻断

- 状态：已决定（阶段 19，M2-1 / M2-2）
- 日期：2026-11-21
- 对应：PHASE-19 §5.2、PRD §4.10 T25、PRD §11、DEV-PLAN §5.20

## 背景

PRD 早期把「同场两角色声音区分度」的参考阈值写成 0.18，但那是拍脑袋的数字：没有语料、
没有误报/检出、也没有版本。M2-1 要求把主观印象变成可量化、可复跑、可告警的指标，
阈值本身必须先经过校准，否则 UI 里一个不可解释的常量会长期误导作者。

同时有两个产品约束：

1. 声音指标只是证据，不能自动判 `fail`、不能阻断 G6；
2. 阈值必须能被替换（换语料 / 换指标权重），历史 `voice_metric` 要能识别旧版本。

## 选项

| 选项 | 优点 | 缺点 |
|---|---|---|
| A. 保持 0.18，不校准 | 不增加工作量 | 无法解释；误报/检出未知；换语言或换指标就失真 |
| B. 用出版小说语料校准 | 更接近真实文风 | 版权与入库问题；标注成本高；阶段内不可完成 |
| C. 合成中文夹具 + 可复跑校准脚本 | 可入库、可复现、误报/检出可量化 | 夹具风格受控，绝对阈值不能直接外推到所有作者 |
| D. 不设阈值，只展示分数 | 不会误报 | 作者不知道该看哪一对；无法做徽标告警 |

## 决定

选 **C**，并把边界写死：

1. **语料**：`tests/fixtures/voice/zh-corpus.json`（20 场 / 5 个角色 / 每角色 8–12 拍，
   同一角色的拍分两半作「同人对照」，同场不同角色作「异人对照」）。语料是**合成中文
   夹具**，不是出版小说；`sha256` 写进阈值常量。
2. **校准脚本**：`scripts/calibrate-voice.mjs`，直接复用 `src/main/voice/metrics.ts`
   （Node 26 类型剥离），对每个候选阈值算 `TPR − FPR`，要求同人误报 ≤5%、异人检出 ≥80%，
   结果 clamp 到 `[0.12, 0.30]`；平台期取中位数，避免把阈值贴在同一人的最高分上。
3. **结果**：`zh-v1`，`distinctnessMin = 0.252`；50 个同人对的误报 2%（1/50），
   40 个异人对的检出 97.5%（39/40）。结果文件 `tests/fixtures/voice/calibration-result.json`
   与常量 `src/shared/domain/voice.ts` 必须一致（`threshold.test.ts` 守住）。
4. **唯一真源**：UI、T25、`voice.scene` 都读 `VOICE_THRESHOLD`，界面里不再出现 0.18；
   报告只追加 `type='voice'`、`severity='suggestion'` 的条目。
5. **版本化**：`voice_metric.threshold_version` 记录计算时的版本；读取时版本不一致就重算
   （同一 `(scene_id, revision_id)` 覆盖，不追加历史）。换语料必须升到 `zh-v2`。

## 后果

- 0.252 比原参考值高：在同一人对照上更保守（少误报），代价是「接近但不同」的角色对
  可能被标黄。作者可以忽略——文案固定写「提示，不阻断」。
- 合成夹具的绝对分数比真实小说高（句长分布更集中）；这个阈值是**起点**，不是效果承诺。
  M2 期间用真实项目复跑 `scripts/m2-baseline.mjs`，若误报明显再升版本，不改 G6。
- 指标只进 UI 与报告建议：`agents/prompts/**` 与 `context/**` 不读 `voice_metric`
  / `distinctness`（`tests/unit/voice/no-prompt-leak.test.ts` 守住），避免模型把分数
  当成质量结论去改写。

## 回滚方式

- 阈值本身：改 `VOICE_THRESHOLD` 并升 `version`（`zh-v1` → `zh-v2`），重跑校准脚本与
  `threshold.test.ts`；历史行按 `threshold_version` 自动重算，不删数据。
- 指标公式：权重在 `src/main/voice/metrics.ts` 的 `pairDistinctness`；改公式必须同时改
  ADR 增补、校准结果与契约测试。
- 告警：若作者反馈噪声过大，把徽标降级为「仅审批台面板可看」不需要改数据层；
  不得把 `voice` 加进 `BLOCKING_ISSUE_TYPES`（那会改变 G6 语义，需新 ADR）。
