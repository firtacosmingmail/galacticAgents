import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The Codex home Mission Control owns (P11-04, ruling R7): every Codex process runs with
 * `CODEX_HOME` set to a directory under the Galactic data dir, so nothing the user configured in
 * `~/.codex/config.toml` — MCP servers (the ChatGPT desktop app's `node_repl`), hooks, profiles,
 * plugins — reaches a Steward. Mission Control writes that home's `config.toml` (the safe settings,
 * no `mcp_servers`) and makes its `auth.json` a **symlink** to the user's own login file, so the
 * subscription login is shared without ever reading, opening or copying the credentials.
 */

/** The user's own Codex login file: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json`. */
export function defaultAuthSource(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'auth.json');
}

/**
 * The managed home's `config.toml`: the safe settings, and no MCP server at all (checked with
 * `codex app-server --strict-config --print-startup-config`; Codex 0.166 refuses
 * `approval_policy = "untrusted"` here, so the policy goes on every `thread/start` and turn).
 */
export const MANAGED_CONFIG_TOML = `# Written by GalacticAgents (P11-04): the Codex home its Stewards run in. Edits are overwritten.
# The approval policy ("untrusted") travels on every thread and turn: config.toml refuses it.
approvals_reviewer = "user"
sandbox_mode = "workspace-write"
web_search = "disabled"

[sandbox_workspace_write]
network_access = false

[features]
apps = false
plugins = false
image_generation = false
browser_use = false
computer_use = false
hooks = false
`;

export interface PreparedHome {
  /** Whether the user's login file exists (checked without opening it). */
  authPresent: boolean;
  /** The link had been replaced by a regular file (Codex rewrote it): removed and linked again. */
  replacedLink: boolean;
}

/**
 * Creates (or refreshes) the managed home: `config.toml` written, `auth.json` → `authSource`
 * linked. A regular file found where the link should be is removed unread and linked again.
 */
export function prepareCodexHome(dir: string, authSource: string): PreparedHome {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config.toml'), MANAGED_CONFIG_TOML, { mode: 0o600 });
  const link = join(dir, 'auth.json');
  let replacedLink = false;
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(link);
  } catch {
    stat = undefined;
  }
  const linked = stat?.isSymbolicLink() === true && readlinkSync(link) === authSource;
  if (!linked) {
    if (stat) {
      replacedLink = !stat.isSymbolicLink();
      rmSync(link, { force: true });
    }
    symlinkSync(authSource, link);
  }
  return { authPresent: existsSync(authSource), replacedLink };
}
