import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@noryth/core': pkg('core'),
      '@noryth/store': pkg('store'),
      '@noryth/git': pkg('git'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      // 05-roadmap.md §3.1 的"纯函数"层门槛；store/CLI 走集成测试，不在这里充数。
      include: ['packages/core/src/**/*.ts'],
      exclude: ['packages/core/src/types.ts', 'packages/core/src/index.ts'],
      thresholds: {
        lines: 90,
        branches: 80,
        functions: 90,
        statements: 90,
      },
    },
  },
});
