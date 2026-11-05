import { defineConfig } from 'vitest/config';

// Integração da interface: servidor LAB real + build Angular + Chromium (Playwright).
// Pré-requisito: npm run build:web.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // as capturas de tela têm script próprio (npm run screenshots)
    exclude: ['test/e2e/screenshots.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
