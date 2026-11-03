import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
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
 *
 * Ruling R27 (final review I5, replacing R9): Codex may refresh the login by writing a new
 * `auth.json` and renaming it into place, which replaces the link with a regular file holding the
 * only valid (rotated) refresh token. That file is never deleted: it is renamed over the user's
 * own login file — one atomic `rename`, neither file opened or read — and the link is made again,
 * so the user's CLI and Mission Control keep the newest login.
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
  /**
   * The link had been replaced by a regular file (Codex rewrote the login): that file was moved
   * over the user's login file (ruling R27) and linked again.
   */
  replacedLink: boolean;
}

/**
 * Creates (or refreshes) the managed home: `config.toml` written, `auth.json` → `authSource`
 * linked. A regular file found where the link should be is renamed over `authSource`, unread
 * (ruling R27), then linked again; a link pointing elsewhere is replaced. Throws — deleting
 * nothing — when that file cannot be moved (the user's Codex folder gone, another volume) or
 * something else stands in the link's place.
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
    if (stat?.isFile()) {
      try {
        renameSync(link, authSource);
      } catch (error) {
        throw new Error(
          `the managed Codex home holds a newer auth.json that could not be moved to ${authSource} ` +
            `(${(error as NodeJS.ErrnoException).code ?? 'error'}): move it there yourself, then start again`,
          { cause: error },
        );
      }
      replacedLink = true;
    } else if (stat?.isSymbolicLink()) {
      // A link to somewhere else: only the link goes, never its target.
      rmSync(link, { force: true });
    } else if (stat) {
      throw new Error(`the managed Codex home's auth.json is not a file or a link: ${link}`);
    }
    symlinkSync(authSource, link);
  }
  return { authPresent: existsSync(authSource), replacedLink };
}
