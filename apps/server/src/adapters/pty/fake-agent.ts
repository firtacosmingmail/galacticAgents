import { fileURLToPath } from 'node:url';

/**
 * The scripted terminal agent (`fake-pty-agent.sh`, P8-08), for tests and for trying the PTY
 * runtime locally (`pty: {"command": "bash", "args": ["<this path>"], "idlePattern":
 * "fixture> $"}` in config.json). It lives next to the sources only: the build does not copy it.
 */
export const FAKE_PTY_AGENT = fileURLToPath(new URL('./fake-pty-agent.sh', import.meta.url));

/** The fixture's own prompt, as `pty.idlePattern`. */
export const FAKE_PTY_IDLE = 'fixture> $';

/**
 * The fixture's free-form questions its supervisor may answer (`pty.clarificationPatterns`):
 * without them every question it asks is a permission (fail closed, decision 112).
 */
export const FAKE_PTY_CLARIFICATIONS = ['^Which colour', '^Which one'];
