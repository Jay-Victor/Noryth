# ADR-0002 正文编辑器：CodeMirror 6

- 状态：已决定（IME 实测待阶段 07）
- 日期：2026-11-14
- 对应：DEV-PLAN §2.1 / §11.4、PHASE-01（编辑器 spike 的落点）

## 背景

正文按拍编辑，必须满足：中文 IME 稳定、撤销栈可靠、只挂载当前拍、`Ctrl+Enter` 提交时不与输入法冲突。候选：

- CodeMirror 6：状态与视图分离，`compositionstart/end` 可精确控制；
- textarea：零依赖，但长文撤销与选中体验差；
- TipTap/ProseMirror：富文本能力用不上，schema 复杂度高。

## 决定

采用 **CodeMirror 6**，但把「200 字中文 IME 无丢字、Enter 只在非 composing 时提交」作为阶段 07 的硬验收，而不是在本阶段口头通过。

## 现状与理由

阶段 01 没有正文编辑器（正文 UI 在阶段 07 F5），因此没有真实 IME 环境可测。本 ADR 记录选型与验证计划，避免阶段 07 才临时做技术选型。

阶段 07 的验收步骤：

1. 连续输入 200 个汉字（含拼音候选切换），逐字比对 DOM 与 `beat.body`；
2. `compositionstart` 期间按 Enter 不触发确认；
3. `Ctrl+Z` 只撤销当前拍的输入，不跨拍；
4. 切拍时卸载编辑器，24 拍不保留 24 个实例。

## 回退

若阶段 07 的 IME 测试失败：改用按拍挂载的原生 `textarea`，保留 `expectedRevision` 与提交流程不变；更新本 ADR 并记录失败样本。
