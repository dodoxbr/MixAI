import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/e2e/yoga-smoke.test.ts', 'test/lab-real-diff-offline.test.ts'],
    fileParallelism: false,
    // O worker é uma thread do processo descartável, sem processo servidor órfão.
    pool: 'threads',
    testTimeout: 60_000,
    hookTimeout: 20_000,
  },
});
