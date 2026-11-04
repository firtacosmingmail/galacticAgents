import { fileURLToPath } from 'node:url';

/**
 * The fake Antigravity CLI script (`fake-agy.mjs`, P11-05), for tests and for trying the agy
 * runtime locally (`agy.command` pointing at a wrapper that runs `node <this path>`). It lives
 * next to the sources only: the build does not copy it.
 */
export const FAKE_AGY = fileURLToPath(new URL('./fake-agy.mjs', import.meta.url));
