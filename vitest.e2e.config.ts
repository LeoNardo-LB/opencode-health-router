import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    globals: true,
    include: ["__tests__/e2e/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
    // Serial execution to avoid port conflicts
    fileParallelism: false,
  },
})
