import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The shell's Node side only: the Rust side (src-tauri) is built by `pnpm desktop:build`.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
