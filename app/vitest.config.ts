import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    environmentMatchGlobs: [['src/ui/**', 'jsdom']],
    // Playwright owns e2e/ (see playwright.config.ts) — its specs import
    // @playwright/test, not vitest.
    exclude: ['**/node_modules/**', '**/dist/**', 'e2e/**'],
    api: false,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true
      }
    }
  }
});
