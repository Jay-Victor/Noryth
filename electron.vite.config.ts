import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // 第二个入口：嵌入 worker（utilityProcess.fork 需要独立 JS 文件）。
        // onnxruntime 只在模型随包时存在；显式 external，避免开发机缺包时打包失败。
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'memory-embed-worker': resolve(__dirname, 'src/main/memory/embed/worker.ts')
        },
        external: ['@huggingface/transformers', 'onnxruntime-node']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    }
  }
})
