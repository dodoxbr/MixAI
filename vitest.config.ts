import { defineConfig } from 'vitest/config';

// Testes do servidor/núcleo. A interface (web/) tem os próprios testes (npm run test:web) e os
// testes de integração com navegador ficam em vitest.e2e.config.ts (npm run test:e2e).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/e2e/**', 'node_modules/**', 'web/**'],
  },
});
