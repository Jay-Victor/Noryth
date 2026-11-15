import { defineConfig } from 'vitest/config'

/**
 * 性能基线单独一份配置（DEV-PLAN §13.1：性能基线 nightly 跑，不进每次提交的门）。
 * 计时断言在共享 CI runner 上会因磁盘/杀软抖动，把阈值绑进提交门只会训练人忽略红灯。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/perf/**/*.spec.ts'],
    reporters: ['default'],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false
  }
})
