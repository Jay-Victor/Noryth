import { defineConfig } from '@playwright/test'

/**
 * 10 万字长跑（E2E-M2-A）。只在 nightly / 发布前跑：
 *   pnpm build && pnpm test:e2e:m2a
 *
 * 与 M1 的 `playwright.m1a.config.ts` 分开：`test:e2e:m1a` 不跑 M2 长跑，
 * 本配置也不跑 M1 长跑与成本基线夹具（后者由 m1a 配置显式指定文件运行）。
 */
export default defineConfig({
  testDir: './tests/e2e-long',
  testIgnore: ['m1-a.spec.ts', '_cost-baseline.spec.ts'],
  timeout: 3_600_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' }
})
