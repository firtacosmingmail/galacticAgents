import { fileURLToPath } from 'node:url';

/**
 * The fake Codex CLI script (`fake-codex-agent.mjs`, P11-04), for tests and for trying the codex
 * runtime locally (`codex.command` pointing at a wrapper that runs `node <this path>`). It lives
 * next to the sources only: the build does not copy it.
 */
export const FAKE_CODEX_AGENT = fileURLToPath(new URL('./fake-codex-agent.mjs', import.meta.url));
