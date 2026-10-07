import { fileURLToPath } from 'node:url';

/**
 * The fake ACP agent script (`fake-acp-agent.mjs`, P8-07), for tests and for trying the ACP
 * runtime locally (`acp.command: "node"`, `acp.args: ["<this path>"]` in config.json). It lives
 * next to the sources only: the build does not copy it.
 */
export const FAKE_ACP_AGENT = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));
