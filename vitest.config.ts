import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    api: false,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true
      }
    }
  }
});
