#!/usr/bin/env node
/**
 * bge 嵌入冒烟（ADR-0004 / PHASE-14 M1-20）。
 *
 * 门槛（本机，CPU）：
 *   - 冷启动 < 1500ms（pipeline 加载 + 第一条）
 *   - 单条 < 120ms
 *   - 维度 512
 *
 * 用法：`pnpm verify:embed`（默认读 resources/models/bge-small-zh-v1.5），
 * 或 `node scripts/embed-smoke.mjs <modelDir>`。
 * 失败退出码 1，便于打包前手工卡门；不进 CI（CI 无 GPU、机器性能不稳定）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { env, pipeline } from '@huggingface/transformers'

const modelDir = process.argv[2] ?? join(process.cwd(), 'resources', 'models', 'bge-small-zh-v1.5')
const onnx = join(modelDir, 'onnx', 'model_quantized.onnx')

if (!existsSync(onnx)) {
  console.error(`embed-smoke: 缺少模型文件 ${onnx}`)
  process.exit(1)
}

env.allowRemoteModels = false
env.localModelPath = modelDir

const started = Date.now()
const extractor = await pipeline('feature-extraction', modelDir, { dtype: 'q8' })
const coldMs = Date.now() - started

const firstStart = Date.now()
const first = await extractor(['账本在祠堂的供桌下面'], { pooling: 'cls', normalize: true })
const firstMs = Date.now() - firstStart

const warmStart = Date.now()
await extractor(['她把茶盏推了过去，声音压得很低'], { pooling: 'cls', normalize: true })
const warmMs = Date.now() - warmStart

const batchStart = Date.now()
await extractor(Array.from({ length: 8 }, (_, index) => `第 ${index + 1} 条记忆：黑漆匣子与账本`), {
  pooling: 'cls',
  normalize: true
})
const batchMs = Date.now() - batchStart

const dim = first.dims[first.dims.length - 1]
const result = { model: 'bge-small-zh-v1.5', dim, coldMs, firstMs, warmMs, batch8Ms: batchMs }
const passed = coldMs < 1500 && firstMs < 120 && dim === 512
console.log(JSON.stringify({ ...result, passed }))
process.exit(passed ? 0 : 1)
