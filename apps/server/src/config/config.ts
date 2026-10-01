import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** Persisted in `~/.galactic/config.json`. Every field is optional on disk; defaults fill the rest. */
export const ConfigFile = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  token: z.string().min(16).optional(),
  /** Extra allowed `Host`/`Origin` host names, e.g. "mymac.tailnet-name.ts.net" or "*.ts.net". */
  allowedHosts: z.array(z.string().min(1)).optional(),
  /** Where new project folders are created (SPEC §3.5); absolute or `~/…`. */
  projectsRoot: z.string().min(1).optional(),
  /**
   * Let a remote client (Phase 7: the phone PWA through Tailscale Serve) set up auto-approvals:
   * spawn under a policy looser than the global default. Off unless set (TECHNOLOGY §8, P2-04).
   */
  autoApproveRemote: z.boolean().optional(),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

export interface ServerConfig {
  /** Always the loopback address in v1 (TECHNOLOGY §8); Tailscale Serve forwards to it. */
  host: '127.0.0.1';
  port: number;
  token: string;
  /** Host names accepted in `Host` and `Origin` headers; `*.ts.net` style wildcards allowed. */
  allowedHosts: string[];
  /** `GALACTIC_DEV=1`: enables the `/dev/*` routes (`pnpm dev` sets it; `galactic start --dev` opts in). */
  dev: boolean;
  /** `~/.galactic` (or `$GALACTIC_HOME`): config, database, logs. */
  dataDir: string;
  configPath: string;
  dbPath: string;
  /**
   * Where a project without an existing folder gets `<projectsRoot>/<slug>` (SPEC §3.5, P2-05).
   * Default `~/GalacticProjects`; `GALACTIC_PROJECTS_ROOT` or `projectsRoot` in the file override it.
   */
  projectsRoot: string;
  /**
   * Whether a request from a remote client may loosen the permission table (P2-04; TECHNOLOGY §8:
   * "never auto-approved for a remote client unless explicitly configured"). Default `false`: a
   * remote spawn runs under a policy no looser than the global default in any category.
   * `autoApproveRemote` in the file or `GALACTIC_AUTO_APPROVE_REMOTE=1` turns it on.
   */
  autoApproveRemote: boolean;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** True when this call generated the token; `galactic start` prints it once in that case. */
  tokenGenerated: boolean;
}

export const DEFAULT_PORT = 4321;
export const DEFAULT_PROJECTS_DIR = 'GalacticProjects';
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Loads the config: defaults ← `~/.galactic/config.json` ← environment.
 * Generates and persists a token on first start (file mode 0600).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const dataDir = env['GALACTIC_HOME'] ?? join(homedir(), '.galactic');
  const configPath = join(dataDir, 'config.json');

  let file: ConfigFile = {};
  if (existsSync(configPath)) {
    file = ConfigFile.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  }

  let tokenGenerated = false;
  let token = env['GALACTIC_TOKEN'] ?? file.token;
  if (!token) {
    token = generateToken();
    tokenGenerated = true;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const next: ConfigFile = { ...file, token };
    writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  }

  const portEnv = env['GALACTIC_PORT'];
  const port = portEnv !== undefined ? Number(portEnv) : (file.port ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${portEnv ?? file.port}`);
  }

  const extraHosts = [
    ...(file.allowedHosts ?? []),
    ...(env['GALACTIC_ALLOWED_HOSTS']
      ?.split(',')
      .map((h) => h.trim())
      .filter(Boolean) ?? []),
  ];
  const allowedHosts = [...new Set([...DEFAULT_ALLOWED_HOSTS, ...extraHosts])];

  const rootSetting = env['GALACTIC_PROJECTS_ROOT'] ?? file.projectsRoot;
  const projectsRoot = rootSetting
    ? expandHome(rootSetting)
    : join(homedir(), DEFAULT_PROJECTS_DIR);
  if (!isAbsolute(projectsRoot)) {
    throw new Error(`The projects root must be an absolute path: ${rootSetting}`);
  }

  return {
    config: {
      host: '127.0.0.1',
      port,
      token,
      allowedHosts,
      dev: env['GALACTIC_DEV'] === '1' || env['GALACTIC_DEV'] === 'true',
      dataDir,
      configPath,
      dbPath: env['GALACTIC_DB'] ?? join(dataDir, 'galactic.sqlite'),
      projectsRoot: resolve(projectsRoot),
      autoApproveRemote:
        env['GALACTIC_AUTO_APPROVE_REMOTE'] !== undefined
          ? env['GALACTIC_AUTO_APPROVE_REMOTE'] === '1' ||
            env['GALACTIC_AUTO_APPROVE_REMOTE'] === 'true'
          : (file.autoApproveRemote ?? false),
    },
    tokenGenerated,
  };
}

/** `~` and `~/…` name the home directory; anything else is returned as written. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
