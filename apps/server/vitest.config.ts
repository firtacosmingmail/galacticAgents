import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Many server tests spawn real processes (git repositories, worktrees, merges; the fake
    // adapter's children): a few seconds each, so a busy machine pushed them past Vitest's 5 s
    // default. A hang still fails, just later.
    testTimeout: 20_000,
  },
});
