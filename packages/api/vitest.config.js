import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    hookTimeout: 60000,   // 60s for beforeAll (mongodb-memory-server startup)
    testTimeout: 30000,   // 30s per test
    globals: false,
  },
});
