import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    api: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleThread: true
      }
    }
  }
});
