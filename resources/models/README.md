# 嵌入模型（随包）

这个目录随安装包发布（electron-builder `extraResources`）。**阶段 14 起 bge 权重随包**：

```
resources/models/bge-small-zh-v1.5/
  config.json
  tokenizer.json
  tokenizer_config.json
  onnx/model_quantized.onnx   # q8，约 24MB，512 维
```

应用启动时按 `process.resourcesPath/models/bge-small-zh-v1.5` 解析（见
`src/main/memory/embed/model.ts` 与 `docs/adr/0004-embedding.md`）。权重缺失时自动降级为
确定性 `hash-bigram-v1`（512 维、离线、零依赖），并把它写进每条 `memory_entry.embedding_model`；
检索的向量通道按模型名过滤，两种向量不会互相召回。

## 门槛与验证

- 冷启动 < 1.5s、单条 < 120ms、512 维：`pnpm verify:embed`（本机 CPU，实测冷启动约 0.13s）。
- 安装包 > 250MB 或冷启动超标 → 回退 q4 / 更小模型，并全量重建索引（`index.rebuild`，M1-20）。
- 换模型（或首次启用 bge）后，在记忆台点「重建索引」；旧行仍可按关键词召回，向量通道只匹配当前模型。

## 打包裁剪

`electron-builder.yml` 只带 win32-x64 的 CPU 运行时：`onnxruntime-node` 的 linux/darwin/arm64
与 DirectML 相关 DLL、`onnxruntime-web` 全部排除（省约 250MB）。本机 CPU 推理不需要 GPU EP。
