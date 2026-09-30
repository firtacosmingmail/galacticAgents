import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Persisted in `~/.galactic/config.json`. Every field is optional on disk; defaults fill the rest. */
export const ConfigFile = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  token: z.string().min(16).optional(),
  /** Extra allowed `Host`/`Origin` host names, e.g. "mymac.tailnet-name.ts.net" or "*.ts.net". */
  allowedHosts: z.array(z.string().min(1)).optional(),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

export interface ServerConfig {
  /** Always the loopback address in v1 (TECHNOLOGY §8); Tailscale Serve forwards to it. */
  host: '127.0.0.1';
  port: number;
  token: string;
  /** Host names accepted in `Host` and `Origin` headers; `*.ts.net` style wildcards allowed. */
  allowedHosts: string[];
  /** `~/.galactic` (or `$GALACTIC_HOME`): config, database, logs. */
  dataDir: string;
  configPath: string;
  dbPath: string;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** True when this call generated the token; `galactic start` prints it once in that case. */
  tokenGenerated: boolean;
}

export const DEFAULT_PORT = 4321;
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

  return {
    config: {
      host: '127.0.0.1',
      port,
      token,
      allowedHosts,
      dataDir,
      configPath,
      dbPath: env['GALACTIC_DB'] ?? join(dataDir, 'galactic.sqlite'),
    },
    tokenGenerated,
  };
}
