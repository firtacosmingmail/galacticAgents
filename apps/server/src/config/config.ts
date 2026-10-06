import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  AgentRuntime,
  BackupSchedule,
  DEFAULT_BUDGET_WARN_PERCENT,
  DEFAULT_TRANSCRIPT_RETENTION,
  IDENTITY_TOKEN,
  PermissionPolicy,
  QualityTier,
  SettingsBudgets,
  SettingsCaps,
  TranscriptRetention,
  type AgentCaps,
  type SettingName,
} from '@galactic/protocol';
import {
  DEFAULT_CAPS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_SPAWN_CAPS,
  type SpawnCaps,
} from '../runtime/caps.js';

/** A DNS name with at least one dot: no scheme, port, path or wildcard (stored lower-case). */
const REMOTE_HOST =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Persisted in `~/.galactic/config.json`. Every field is optional on disk; defaults fill the rest. */
export const ConfigFile = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  /** Never the identity stand-in (`IDENTITY_TOKEN`), which clients send in place of a token. */
  token: z
    .string()
    .min(16)
    .refine((t) => t !== IDENTITY_TOKEN, `"${IDENTITY_TOKEN}" is reserved; pick another token`)
    .optional(),
  /**
   * Extra allowed `Host`/`Origin` host names. Prefer `remoteHost` for the Tailscale name; a
   * `*.ts.net` wildcard is accepted but warned about (it also admits every Funnel page's Origin).
   */
  allowedHosts: z.array(z.string().min(1)).optional(),
  /**
   * The Tailscale Serve name this machine is reached at from the phone (P7-02;
   * `docs/REMOTE_ACCESS.md`), e.g. "mymac.tail1234.ts.net": an exact host name, never a wildcard.
   * Added to the allow-list, used for the phone's address in the settings QR code, and the only
   * `Host` under which Tailscale identity headers are read.
   */
  remoteHost: z
    .string()
    .regex(REMOTE_HOST, 'an exact host name such as mymac.tail1234.ts.net (no scheme, port or *)')
    .optional(),
  /**
   * Opt-in (P7-02): accept Tailscale Serve's `Tailscale-User-Login` header as a remote client's
   * credential, instead of the token, for exactly these logins. Read only over a loopback
   * connection whose `Host` is `remoteHost`. Any process on this Mac can send that header — as it
   * can already obtain the token from `/health`, so this adds no new local exposure
   * (`docs/REMOTE_ACCESS.md` §4).
   */
  tailscaleIdentityLogins: z.array(z.string().min(3)).min(1).optional(),
  /** Where new project folders are created (SPEC §3.5); absolute or `~/…`. */
  projectsRoot: z.string().min(1).optional(),
  /**
   * Let a remote client (Phase 7: the phone PWA through Tailscale Serve) set up auto-approvals:
   * spawn under a policy looser than the global default. Off unless set (TECHNOLOGY §8, P2-04).
   */
  autoApproveRemote: z.boolean().optional(),
  /**
   * Decision 4: how long finished work keeps its body (and a "moved to …" marker stays) before the
   * archival job archives it, in days (fractions allowed). Default 7 (P2-13).
   */
  retentionDays: z.number().positive().optional(),
  /**
   * Transcript retention (P8-02), in days, `null` = keep forever: chunks older than `maxAgeDays`
   * are removed, and the whole transcript of an agent whose work was archived `archivedDays` ago.
   * Defaults 90 and 30 (`DEFAULT_TRANSCRIPT_RETENTION`).
   */
  transcriptRetention: TranscriptRetention.partial().optional(),
  /**
   * Hard caps on spawning (decision 18; P2-17): live Stewards (brains not counted), live
   * Stewards per Waykeeper, spawns per sliding hour in all and per spawning brain.
   */
  caps: z
    .object({
      maxConcurrentAgents: z.number().int().positive().optional(),
      maxStewardsPerWaykeeper: z.number().int().positive().optional(),
      maxSpawnsPerHour: z.number().int().positive().optional(),
      maxSpawnsPerHourPerBrain: z.number().int().positive().optional(),
      /** A new agent's wall-clock and tool-call caps (P1-02; settable from the panel, P25-01). */
      maxWallClockMs: SettingsCaps.shape.maxWallClockMs.optional(),
      maxToolCalls: SettingsCaps.shape.maxToolCalls.optional(),
    })
    .optional(),
  /** The global default permission table (P25-01; SPEC §3.6, decision 22); absent = the SPEC's. */
  defaultPermissionPolicy: PermissionPolicy.optional(),
  /** The renderer's quality tier (SPEC §4.6; used from Phase 3). Default `high`. */
  qualityTier: QualityTier.optional(),
  /**
   * Whether Stewards load the user's own Claude Code settings (`~/.claude`) besides the
   * repository's (SPEC §8 open question). Default `true` (keep loading them).
   */
  stewardsLoadUserSettings: z.boolean().optional(),
  /** Dollar budgets (P8-01): the warning threshold in percent of a budget (default 80). */
  budgets: SettingsBudgets.partial().optional(),
  /**
   * When the panel's first-run setup was finished or skipped (P25-08); absent = not yet. Written
   * as an ISO timestamp, but read leniently: a hand-edited value must not stop the server.
   */
  setupCompletedAt: z.string().min(1).optional(),
  /**
   * Backups (P8-03; docs/BACKUP_RESTORE.md): whether the daily backup runs (default true; also
   * `GALACTIC_BACKUPS=0`), how many are kept, and how much free space a backup must leave on the
   * disk (MiB, default 1024).
   */
  backups: BackupSchedule.partial()
    .extend({ reserveMiB: z.number().int().nonnegative().optional() })
    .optional(),
  /**
   * The runtime new Stewards run on (P8-07; also `GALACTIC_STEWARD_RUNTIME`); absent = the
   * spawning brain's own runtime. Settable from the panel.
   */
  stewardRuntime: AgentRuntime.optional(),
  /**
   * The ACP agent the `acp` runtime starts for every session (P8-07; TECHNOLOGY §3.2), e.g.
   * `{"command": "claude-agent-acp"}`, `{"command": "gemini", "args": ["--acp"]}` or
   * `{"command": "codex-acp"}`; also `GALACTIC_ACP_COMMAND` (a command line split on spaces, or
   * a JSON array `["cmd", "an arg with spaces"]`). Absent: no `acp` runtime. `passEnv` names the
   * server variables the agent needs — every credential (its API key or token): only routing
   * variables pass by default — never a `GALACTIC_*` one. `mode` is the session mode every session
   * is set to; a mode known to run tool calls without asking is refused unless
   * `allowPermissiveMode` (decision 108).
   */
  acp: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      passEnv: z
        .array(
          z
            .string()
            .min(1)
            .refine((k) => !/^GALACTIC_/i.test(k), 'acp.passEnv may not name GALACTIC_* variables'),
        )
        .optional(),
      mode: z.string().min(1).optional(),
      allowPermissiveMode: z.boolean().optional(),
    })
    .optional(),
  /**
   * The command-line agent the `pty` runtime runs under a pseudo-terminal for every session
   * (P8-08; TECHNOLOGY §3.3), e.g. `{"command": "aider", "args": ["--no-auto-commits"],
   * "idlePattern": "^> $"}`; also `GALACTIC_PTY_COMMAND` (like `GALACTIC_ACP_COMMAND`). Absent:
   * no `pty` runtime. `passEnv` names the server variables it needs (credentials by name; never
   * `GALACTIC_*`). `idlePattern` is its input prompt (a regular expression on the cursor's line):
   * the turn is over; `questionPatterns` add question shapes (`kind` `permission` or
   * `clarification`, `yes`/`no` what is typed); `quietMs` is the silence after which the screen
   * is read (default 750); `idleAfterMs` ends a turn after that much silence when there is no
   * prompt to recognise. A terminal agent runs only where the permission table allows what it
   * cannot classify (the trusted preset; decision 112).
   */
  pty: z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      passEnv: z
        .array(
          z
            .string()
            .min(1)
            .refine((k) => !/^GALACTIC_/i.test(k), 'pty.passEnv may not name GALACTIC_* variables'),
        )
        .optional(),
      idlePattern: z.string().min(1).optional(),
      questionPatterns: z
        .array(
          z.object({
            pattern: z.string().min(1),
            flags: z.string().optional(),
            kind: z.enum(['permission', 'clarification']),
            yes: z.string().optional(),
            no: z.string().optional(),
          }),
        )
        .optional(),
      quietMs: z.number().int().min(50).max(60_000).optional(),
      idleAfterMs: z.number().int().min(500).optional(),
    })
    .optional(),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

export interface ServerConfig {
  /** Always the loopback address in v1 (TECHNOLOGY §8); Tailscale Serve forwards to it. */
  host: '127.0.0.1';
  port: number;
  token: string;
  /** Host names accepted in `Host` and `Origin` headers; `*.ts.net` style wildcards allowed. */
  allowedHosts: string[];
  /**
   * The Tailscale Serve name (P7-02): `remoteHost` in the file or `GALACTIC_REMOTE_HOST`. In
   * `allowedHosts` too; absent = remote access not set up (the settings page shows no QR code).
   */
  remoteHost?: string;
  /**
   * Tailscale logins (lower-case) accepted as a credential through Serve's identity headers
   * (P7-02); absent = off, the default. Only with `remoteHost` (ignored, with a warning, without).
   */
  tailscaleIdentityLogins?: string[];
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
  /**
   * Decision 4's retention period in ms (P2-13): `retentionDays` in the file or
   * `GALACTIC_RETENTION_DAYS`; default 7 days.
   */
  retentionMs: number;
  /**
   * The spawn caps (P2-17): `caps` in the file or `GALACTIC_MAX_CONCURRENT_AGENTS`,
   * `GALACTIC_MAX_STEWARDS_PER_WAYKEEPER`, `GALACTIC_MAX_SPAWNS_PER_HOUR`,
   * `GALACTIC_MAX_SPAWNS_PER_HOUR_PER_BRAIN`; defaults 4, 3, 30 and 20.
   */
  caps: SpawnCaps & { maxConcurrentAgents: number; defaults?: AgentCaps };
  /** Transcript retention (P8-02); absent = `DEFAULT_TRANSCRIPT_RETENTION`. */
  transcriptRetention?: TranscriptRetention;
  /** The global default permission table from the file (P25-01); absent = the SPEC's table. */
  defaultPermissionPolicy?: PermissionPolicy;
  /** The renderer's quality tier (P25-01); absent = `high`. */
  qualityTier?: QualityTier;
  /** Whether Stewards load `~/.claude` too (P25-01; SPEC §8); absent = `true`. */
  stewardsLoadUserSettings?: boolean;
  /** Settings an environment variable decided at startup (P25-01): read-only in the panel. */
  envOverrides?: SettingName[];
  /** When the panel's first-run setup was done (P25-08); absent = the wizard shows. */
  setupCompletedAt?: string;
  /**
   * Dollar budgets (P8-01): `budgets.warnAtPercent` in the file or `GALACTIC_BUDGET_WARN_PERCENT`;
   * absent = 80.
   */
  budgets?: { warnAtPercent: number };
  /** Backups (P8-03): the rotation and the free space a backup leaves; absent = the defaults. */
  backups?: Partial<BackupSchedule> & { reserveBytes?: number };
  /** The runtime new Stewards run on (P8-07); absent = the spawning brain's own. */
  stewardRuntime?: AgentRuntime;
  /** The ACP agent command (P8-07); absent = no `acp` runtime registered. */
  acp?: {
    command: string;
    args?: string[] | undefined;
    passEnv?: string[] | undefined;
    mode?: string | undefined;
    allowPermissiveMode?: boolean | undefined;
  };
  /** The terminal agent (P8-08); absent = no `pty` runtime registered. */
  pty?: NonNullable<ConfigFile['pty']>;
}

export interface LoadedConfig {
  config: ServerConfig;
  /** True when this call generated the token; `galactic start` prints it once in that case. */
  tokenGenerated: boolean;
  /** Configuration that works but deserves a word at startup (P7-02); never carries the token. */
  warnings: string[];
}

export const DEFAULT_PORT = 4321;
export const DEFAULT_PROJECTS_DIR = 'GalacticProjects';
export const DEFAULT_RETENTION_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const CAP_ENV = [
  ['maxConcurrentAgents', 'GALACTIC_MAX_CONCURRENT_AGENTS'],
  ['maxStewardsPerWaykeeper', 'GALACTIC_MAX_STEWARDS_PER_WAYKEEPER'],
  ['maxSpawnsPerHour', 'GALACTIC_MAX_SPAWNS_PER_HOUR'],
  ['maxSpawnsPerHourPerBrain', 'GALACTIC_MAX_SPAWNS_PER_HOUR_PER_BRAIN'],
] as const;

export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Loads the config: defaults ← `~/.galactic/config.json` ← environment.
 * Generates and persists a token on first start (file mode 0600).
 */
/**
 * Where the data lives (`~/.galactic`, or `$GALACTIC_HOME`; the database `$GALACTIC_DB`), without
 * reading or writing anything: the export and import commands (P8-03) use it.
 */
export function dataPaths(env: NodeJS.ProcessEnv = process.env): {
  dataDir: string;
  configPath: string;
  dbPath: string;
} {
  const dataDir = env['GALACTIC_HOME'] ?? join(homedir(), '.galactic');
  return {
    dataDir,
    configPath: join(dataDir, 'config.json'),
    dbPath: env['GALACTIC_DB'] ?? join(dataDir, 'galactic.sqlite'),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const { dataDir, configPath, dbPath } = dataPaths(env);

  let file: ConfigFile = {};
  if (existsSync(configPath)) {
    file = ConfigFile.parse(JSON.parse(readFileSync(configPath, 'utf8')));
  }

  let tokenGenerated = false;
  let token = env['GALACTIC_TOKEN'] ?? file.token;
  if (token === IDENTITY_TOKEN) {
    throw new Error(`GALACTIC_TOKEN "${IDENTITY_TOKEN}" is reserved; pick another token`);
  }
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
  const warnings: string[] = [];
  const remoteSetting = env['GALACTIC_REMOTE_HOST'] ?? file.remoteHost;
  const remoteHost = remoteSetting?.trim().toLowerCase() || undefined;
  if (remoteHost !== undefined && !REMOTE_HOST.test(remoteHost)) {
    throw new Error(
      `Invalid remote host (an exact name such as mymac.tail1234.ts.net): ${remoteSetting}`,
    );
  }
  if (remoteHost) {
    // REMOTE_ACCESS §1/§3: a request is remote by its proxy headers; a tunnel that adds none
    // makes every one of its users local.
    warnings.push(
      `Remote access via ${remoteHost}: point only HTTP-mode Tailscale Serve at this port ` +
        `(tailscale serve --https=443 http://127.0.0.1:${port}). A TCP Serve, ssh -L/-R, VS Code ` +
        `port forwarding or any tunnel that adds no X-Forwarded-For makes its users local.`,
    );
  }
  const allowedHosts = [
    ...new Set([...DEFAULT_ALLOWED_HOSTS, ...extraHosts, ...(remoteHost ? [remoteHost] : [])]),
  ];
  for (const h of extraHosts) {
    if (h.startsWith('*.')) {
      warnings.push(
        `allowedHosts has the wildcard ${h}: every name under it passes the Host and Origin checks ` +
          `(for *.ts.net, any Tailscale Funnel page too). Prefer remoteHost with your machine's exact name.`,
      );
    }
  }
  let tailscaleIdentityLogins: string[] | undefined;
  if (file.tailscaleIdentityLogins) {
    if (remoteHost) {
      tailscaleIdentityLogins = [
        ...new Set(file.tailscaleIdentityLogins.map((l) => l.trim().toLowerCase())),
      ];
      warnings.push(
        `Tailscale identity headers are accepted for ${tailscaleIdentityLogins.join(', ')}: any ` +
          `process on this machine can send them, as it can already ask /health for the token ` +
          `(docs/REMOTE_ACCESS.md §4).`,
      );
    } else {
      warnings.push('tailscaleIdentityLogins is ignored: it needs remoteHost.');
    }
  }

  const rootSetting = env['GALACTIC_PROJECTS_ROOT'] ?? file.projectsRoot;
  const projectsRoot = rootSetting
    ? expandHome(rootSetting)
    : join(homedir(), DEFAULT_PROJECTS_DIR);
  if (!isAbsolute(projectsRoot)) {
    throw new Error(`The projects root must be an absolute path: ${rootSetting}`);
  }

  const retentionEnv = env['GALACTIC_RETENTION_DAYS'];
  const retentionDays =
    retentionEnv !== undefined
      ? Number(retentionEnv)
      : (file.retentionDays ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`Invalid retention period (days): ${retentionEnv ?? file.retentionDays}`);
  }

  const caps = {
    maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
    ...DEFAULT_SPAWN_CAPS,
  };
  for (const [key, envName] of CAP_ENV) {
    const raw = env[envName];
    const value = raw !== undefined ? Number(raw) : (file.caps?.[key] ?? caps[key]);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid cap ${key}: ${raw ?? file.caps?.[key]}`);
    }
    caps[key] = value;
  }

  const defaults: AgentCaps = {
    maxWallClockMs: file.caps?.maxWallClockMs ?? DEFAULT_CAPS.maxWallClockMs,
    maxToolCalls: file.caps?.maxToolCalls ?? DEFAULT_CAPS.maxToolCalls,
  };
  const warnEnv = env['GALACTIC_BUDGET_WARN_PERCENT'];
  const warnAtPercent =
    warnEnv !== undefined
      ? Number(warnEnv)
      : (file.budgets?.warnAtPercent ?? DEFAULT_BUDGET_WARN_PERCENT);
  if (!SettingsBudgets.shape.warnAtPercent.safeParse(warnAtPercent).success) {
    throw new Error(
      `Invalid budget warning threshold (1–100 %): ${warnEnv ?? file.budgets?.warnAtPercent}`,
    );
  }
  const runtimeEnv = env['GALACTIC_STEWARD_RUNTIME'];
  let stewardRuntime = file.stewardRuntime;
  if (runtimeEnv !== undefined) {
    const parsed = AgentRuntime.safeParse(runtimeEnv.trim());
    if (!parsed.success) throw new Error(`Invalid Steward runtime: ${runtimeEnv}`);
    stewardRuntime = parsed.data;
  }
  const dev = env['GALACTIC_DEV'] === '1' || env['GALACTIC_DEV'] === 'true';
  if (stewardRuntime === 'fake' && !dev) {
    // The scripted fake adapter is for development and tests only (P8 wave 3 review).
    warnings.push(
      `stewardRuntime is fake, which is for development only (GALACTIC_DEV): ` +
        `new Stewards run on their brain's runtime.`,
    );
    stewardRuntime = undefined;
  }
  const acpEnv = parseAcpCommand(env['GALACTIC_ACP_COMMAND']);
  const acp =
    acpEnv && acpEnv.length > 0
      ? {
          ...file.acp,
          command: acpEnv[0]!,
          args: acpEnv.slice(1),
        }
      : file.acp;
  const ptyEnv = parseAcpCommand(env['GALACTIC_PTY_COMMAND'], 'GALACTIC_PTY_COMMAND');
  const pty =
    ptyEnv && ptyEnv.length > 0
      ? { ...file.pty, command: ptyEnv[0]!, args: ptyEnv.slice(1) }
      : file.pty;
  const envOverrides: SettingName[] = [];
  if (runtimeEnv !== undefined) envOverrides.push('stewardRuntime');
  if (warnEnv !== undefined) envOverrides.push('budgets');
  if (env['GALACTIC_PROJECTS_ROOT'] !== undefined) envOverrides.push('projectsRoot');
  if (retentionEnv !== undefined) envOverrides.push('retentionDays');
  if (CAP_ENV.some(([, name]) => env[name] !== undefined)) envOverrides.push('caps');

  return {
    config: {
      host: '127.0.0.1',
      port,
      token,
      allowedHosts,
      ...(remoteHost ? { remoteHost } : {}),
      ...(tailscaleIdentityLogins ? { tailscaleIdentityLogins } : {}),
      dev,
      dataDir,
      configPath,
      dbPath,
      projectsRoot: resolve(projectsRoot),
      autoApproveRemote:
        env['GALACTIC_AUTO_APPROVE_REMOTE'] !== undefined
          ? env['GALACTIC_AUTO_APPROVE_REMOTE'] === '1' ||
            env['GALACTIC_AUTO_APPROVE_REMOTE'] === 'true'
          : (file.autoApproveRemote ?? false),
      retentionMs: Math.round(retentionDays * DAY_MS),
      ...(file.transcriptRetention
        ? {
            transcriptRetention: {
              ...DEFAULT_TRANSCRIPT_RETENTION,
              ...Object.fromEntries(
                Object.entries(file.transcriptRetention).filter(([, v]) => v !== undefined),
              ),
            },
          }
        : {}),
      caps: { ...caps, defaults },
      ...(file.defaultPermissionPolicy
        ? { defaultPermissionPolicy: file.defaultPermissionPolicy }
        : {}),
      ...(file.qualityTier ? { qualityTier: file.qualityTier } : {}),
      ...(file.stewardsLoadUserSettings !== undefined
        ? { stewardsLoadUserSettings: file.stewardsLoadUserSettings }
        : {}),
      envOverrides,
      budgets: { warnAtPercent },
      ...(file.setupCompletedAt ? { setupCompletedAt: file.setupCompletedAt } : {}),
      ...backupsOf(file.backups, env['GALACTIC_BACKUPS']),
      ...(stewardRuntime ? { stewardRuntime } : {}),
      ...(acp ? { acp } : {}),
      ...(pty ? { pty } : {}),
    },
    tokenGenerated,
    warnings,
  };
}

/** The backups setting (P8-03): the file's values, the environment's on/off over them. */
function backupsOf(
  file: ConfigFile['backups'],
  envFlag: string | undefined,
): { backups?: NonNullable<ServerConfig['backups']> } {
  const { reserveMiB, ...schedule } = file ?? {};
  const backups: NonNullable<ServerConfig['backups']> = {
    // Keys present with `undefined` are dropped (an absent key means the default).
    ...(Object.fromEntries(
      Object.entries(schedule).filter(([, v]) => v !== undefined),
    ) as Partial<BackupSchedule>),
    ...(reserveMiB !== undefined ? { reserveBytes: reserveMiB * 2 ** 20 } : {}),
    ...(envFlag !== undefined ? { enabled: envFlag === '1' || envFlag === 'true' } : {}),
  };
  return Object.keys(backups).length > 0 ? { backups } : {};
}

/** `~` and `~/…` name the home directory; anything else is returned as written. */
export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * `GALACTIC_ACP_COMMAND`: a JSON array of strings (`["cmd", "an arg with spaces"]`), or a command
 * line split on whitespace (no quoting). `undefined` when unset or empty.
 */
export function parseAcpCommand(
  value: string | undefined,
  name = 'GALACTIC_ACP_COMMAND',
): string[] | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${name} is not a JSON array: ${text}`);
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      !parsed.every((p) => typeof p === 'string') ||
      !(parsed[0] as string).trim()
    ) {
      throw new Error(`${name} must be a non-empty JSON array of strings`);
    }
    return parsed as string[];
  }
  return text.split(/\s+/).filter(Boolean);
}
