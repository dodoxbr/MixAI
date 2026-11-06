import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['test/proxy/*.proxy.ts'], hookTimeout: 30_000, testTimeout: 15_000 } });
