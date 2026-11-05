import { defineConfig } from 'vitest/config';

// Capturas de tela da interface (docs/lab/img). Pré-requisito: npm run build:web.
export default defineConfig({
  test: {
    include: ['test/e2e/screenshots.test.ts'],
    testTimeout: 90_000,
  },
});
