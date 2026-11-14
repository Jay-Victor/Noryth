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

## 回退

如果阶段 04 打包后冷启动 > 1.5s 或安装包 > 250MB：改用 q4 或更小模型，`embedding_dim` 变化必须全量重建索引，并更新本 ADR。
