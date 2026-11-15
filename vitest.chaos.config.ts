import { defineConfig } from 'vitest/config'

/**
 * 混沌套件单独一份配置：要起子进程强杀，单条最长 5s（数据库锁），
 * 不进默认 `test:unit`，由 `pnpm test:chaos` 与 nightly 跑。
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/chaos/**/*.spec.ts'],
    reporters: ['default'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
