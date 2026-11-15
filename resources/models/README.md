# 嵌入模型（可选）

这个目录随安装包发布（electron-builder `extraResources`）。M0 交付**不包含** bge 权重：
当前用确定性 `hash-bigram-v1`（512 维，离线、零依赖），每条记忆都记录真实的
`embedding_model`，检索的向量通道按模型名过滤。

放入 bge 权重即可启用真模型，无需改代码：

```
resources/models/bge-small-zh-v1.5/
  config.json
  tokenizer.json
  tokenizer_config.json
  onnx/model_quantized.onnx
```

应用启动时按 `process.resourcesPath/models/bge-small-zh-v1.5` 解析（见
`src/main/memory/embed/model.ts` 与 `docs/adr/0004-embedding.md`）。切入真模型后
需要按章重建索引（M1，T40）；M0 不提供重建入口。

体积/冷启动门槛（ADR-0004 / DEV-PLAN 风险 R2）：安装包 > 250MB 或首查冷启动 > 1.5s
时回退更小模型或 q4，并全量重建索引。
