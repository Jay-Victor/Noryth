# ADR-0004 本地嵌入：bge-small-zh-v1.5 (q8, 512 维) 跑在 utilityProcess

- 状态：已决定（阶段 01 Spike S2 通过）
- 日期：2026-11-14
- 对应：PHASE-01 S2、DEV-PLAN §10.5、§17 D7

## 背景

检索需要离线嵌入。DEV-PLAN 指定 `@huggingface/transformers`（ONNX）+ `bge-small-zh-v1.5` q8，跑在 `utilityProcess`，冷启动 < 1.5s、单条 < 120ms、512 维。

## 证据（Windows 11 / Electron 45.2.3 / @huggingface/transformers 4.3.2 / onnxruntime-node 1.30.0）

模型文件：`Xenova/bge-small-zh-v1.5` 的 `onnx/model_quantized.onnx`（24,010,842 B）+ tokenizer，合计 24.4MB。

Spike 用 `utilityProcess.fork` 启动 worker，`env.allowRemoteModels=false`，`localModelPath` 指向本机缓存；从 `fork` 到 worker 返回 ready 计时：

| 指标 | 结果 | 通过线 |
|---|---:|---:|
| 冷启动 | 377ms | < 1500ms |
| 单条正文嵌入 | 2ms | < 120ms |
| 8 条批量 | 35ms | — |
| 维度 | 512 | 512 |

网络备注：本机 Node/curl 直连 huggingface.co 超时，模型文件通过可用的下载通道预置；这不影响离线加载结论。生产环境模型随包分发（`resources/models/`），不走网络。

## 决定

- 模型 `bge-small-zh-v1.5`，q8，512 维；`project.embedding_model` 与 `embedding_dim` 固定写入。
- 运行在 `utilityProcess`，空闲 5 分钟退出；main 只持有消息通道。
- 模型文件随包分发到 `resources/models/bge-small-zh-v1.5/`（阶段 04 加 `extraResources`；当前未加入安装包，见下）。

## 本阶段的边界

阶段 01 只证明「能离线跑、够快、维度对」。`@huggingface/transformers` 与 `onnxruntime-node` 目前在 `devDependencies`：

- 阶段 01 的安装包不含 288MB 的 onnxruntime 运行时，避免 S4 冒烟被体积拖住；
- 阶段 04 实现 embed worker 时把它们移入 `dependencies`，并把模型放进 `extraResources`；
- 安装包体积上限 250MB 的风险在阶段 04 重新测量，必要时换更小模型（D7 回退）。

> 2026-11-14 范围复核：`PHASE-04-RUNTIME.md` 的 D1–D6 不含嵌入 worker，阶段 04 实际未做随包；
> 该工作随记忆检索（阶段 09 H3）与打包（阶段 10 I/J）一起完成，届时按本 ADR 重新测量体积与冷启动。

## 阶段 09 记录（2026-11-15）

- 嵌入 worker 已实现并作为第二个 main 入口打包（`out/main/memory-embed-worker.js`），协议见 `src/main/memory/embed/protocol.ts`；只有 `resources/models/bge-small-zh-v1.5` 存在时才启用。
- 本机与 CI 没有 ONNX 权重（缓存里只有 tokenizer/config，`onnxruntime-node` 未安装），因此阶段 09 的验收使用确定性 `hash-bigram-v1`（512 维，L2 归一化，无模型无网络）。它**不是**语义模型：同义改写召回不了，只能命中共享字面；这比假装有语义能力更诚实。
- 模型名写进每条 `memory_entry.embedding_model`，检索的向量通道按模型名过滤；换回 bge 时旧行仍可按关键词召回，不会把两种向量混在一起比较。
- 阶段 10 打包前必须：`@huggingface/transformers` + `onnxruntime-node` 进 dependencies、模型进 `extraResources`，重测冷启动与安装包体积；不达标按下方回退。

## 回退

如果阶段 04 打包后冷启动 > 1.5s 或安装包 > 250MB：改用 q4 或更小模型，`embedding_dim` 变化必须全量重建索引，并更新本 ADR。
