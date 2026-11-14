import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/contract/**/*.test.ts', 'tests/integration/**/*.spec.ts'],
    reporters: ['default'],
    testTimeout: 20_000
  }
})
