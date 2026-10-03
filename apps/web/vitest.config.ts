import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // Some scene tests paint procedural textures up to 2048 px on the main thread (seconds each);
    // on a busy machine they passed Vitest's 5 s default. A hang still fails, just later.
    testTimeout: 20_000,
  },
});
