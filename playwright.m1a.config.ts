import { defineConfig } from '@playwright/test'

/**
 * 30 章长跑（E2E-M1-A）。只在 nightly / 发布前跑：
 *   pnpm build && pnpm test:e2e:m1a
 *
 * 与提交门分开配置，避免长跑拖慢每次提交；用例本身共用 tests/e2e/m1-flow.ts。
 */
export default defineConfig({
  testDir: './tests/e2e-long',
  // M2 长跑有自己的配置（playwright.m2a.config.ts）；这里排除，避免 `test:e2e:m1a` 跑两遍。
  testIgnore: ['m2-a.spec.ts'],
  timeout: 3_600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
