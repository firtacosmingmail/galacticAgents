import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_BUDGET_WARN_PERCENT,
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_TRANSCRIPT_RETENTION,
  Timestamp,
  type AgentRuntime,
  type PermissionPolicy,
  type Settings,
  type SettingName,
  type SettingsPatch,
  type SettingsResponse,
} from '@galactic/protocol';
import {
  globalDefaultPolicy,
  policyForWrite,
  setGlobalDefaultPolicy,
  type PolicyWrite,
} from '../domain/permissions.js';
import type { Archival } from '../runtime/archival.js';
import type { CapsEnforcer } from '../runtime/caps.js';
import type { TranscriptRetention } from '../runtime/transcript-retention.js';
import { canonical, unsafeFolder } from '../workspace/workspaces.js';
import { ConfigFile, expandHome, type ServerConfig } from './config.js';

/**
 * The settings page's backend (P25-01; SPEC §4.6): reads the effective settings, validates a
 * patch as a whole, writes `config.json` atomically (keeping the token and every other key), and
 * applies what can be applied live:
 *
 * | Setting | Applied |
 * |---|---|
 * | `defaultPermissionPolicy` | live: the next tool call of every agent on the default (decision 31) |
 * | `retentionDays` | live: the next archival sweep (hourly) |
 * | `transcriptRetention` | live: the next transcript compaction (hourly; P8-02) |
 * | `caps` | live: the next spawn and the next agent's caps; running agents keep theirs |
 * | `qualityTier` | live (stored for the renderer, Phase 3) |
 * | `budgets` | live: every budgeted project and task is judged against the new threshold (P8-01) |
 * | `stewardRuntime` | live: the next Steward a brain spawns (P8-07); only a registered runtime |
 * | `deliverables.ide` | live: the next Open in IDE (P9-03); `auto` or an installed IDE's bundle id |
 * | `projectsRoot` | at the next start (the workspace service and the Harmonizer's cwd hold it) |
 * | `stewardsLoadUserSettings` | at the next start (the Claude adapter's spawn options) |
 *
 * Besides the settings, a patch may mark the panel's first-run setup as done (`setupCompleted`,
 * P25-08): `setupCompletedAt` is stamped once in `config.json` and reported by `response()`.
 *
 * A setting an environment variable decided is read-only (`envOverrides`): the file would be
 * shadowed at the next start, so a patch of it is refused.
 *
 * Remote clients (decision 51, until Phase 7 decides otherwise): settings are written from local
 * requests only. Unless `autoApproveRemote`, a remote request — or one of unknown origin — may
 * change only the quality tier and the default policy, and its default policy is floored at the
 * current default (decision 37, refined by 50): it can tighten the default, never loosen it — the
 * default is the floor of every other remote write. Any other field is refused (403
 * `remote_settings`) before anything is written.
 */

export const DEFAULT_QUALITY_TIER = 'high' as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The settings a running process cannot change (see the table above). */
const RESTART = ['projectsRoot', 'stewardsLoadUserSettings'] as const;

export class SettingsError extends Error {
  constructor(
    readonly code: 'env_override' | 'invalid' | 'remote_settings',
    message: string,
  ) {
    super(message);
  }
}

export interface SettingsServiceOptions {
  config: ServerConfig;
  /** The runtime's caps enforcer (`runtime.caps`): caps apply live through it. */
  caps?: CapsEnforcer;
  /** The archival job: the retention period applies live through it. */
  archival?: Archival;
  /** The transcript retention job (P8-02): its policy applies live through it. */
  transcriptRetention?: TranscriptRetention;
  /** The budget watcher (P8-01): the warning threshold applies live through it. */
  budgets?: { warnAtPercent: number };
  /** The home directory the projects root may not be (default `os.homedir()`; tests). */
  home?: string;
  /**
   * The runtimes the server has adapters for (P8-07): `stewardRuntime` may name only one of
   * them. Absent: any runtime is accepted (tests).
   */
  runtimes?: () => readonly AgentRuntime[];
  /**
   * Whether `stewardRuntime` may be `fake` (the scripted fake adapter): only in dev mode
   * (`GALACTIC_DEV`). Default `config.dev`; tests may pass it explicitly.
   */
  allowFakeRuntime?: boolean;
  /**
   * The IDEs the opener found (P9-03): `deliverables.ide` may name only one of them. The caller
   * runs a detection before a patch that sets it (`Opener.ides()`); `undefined` (none yet, or no
   * opener) refuses every IDE but `auto`.
   */
  ides?: { readonly supported: boolean; installedBundleIds(): readonly string[] | undefined };
}

/** What a remote client may patch (decision 51): the policy only floored (decision 37). */
const REMOTE_WRITABLE: readonly SettingName[] = ['defaultPermissionPolicy', 'qualityTier'];

/**
 * What a client may change, as `update` decides it (decision 51): `limited` for a remote or
 * unknown-origin request unless `autoApproveRemote`, else `all`. Reported as `writable`.
 */
export function writableFor(write: PolicyWrite): 'all' | 'limited' {
  return write.origin !== 'local' && !write.autoApproveRemote ? 'limited' : 'all';
}

/**
 * The first-run marker as the protocol's timestamp. `config.json` is read leniently (a
 * hand-edited value must not stop the server): a date it can parse is normalised, anything else
 * still counts as done and is reported as the epoch.
 */
function asTimestamp(value: string): string {
  if (Timestamp.safeParse(value).success) return value;
  const at = Date.parse(value);
  return new Date(Number.isNaN(at) ? 0 : at).toISOString();
}

export class SettingsService {
  private readonly config: ServerConfig;
  /** What the running process uses for the settings that need a restart. */
  private readonly running: Pick<Settings, 'projectsRoot' | 'stewardsLoadUserSettings'>;
  private saved: Settings;

  constructor(private readonly opts: SettingsServiceOptions) {
    this.config = opts.config;
    this.saved = this.fromConfig();
    this.running = {
      projectsRoot: this.saved.projectsRoot,
      stewardsLoadUserSettings: this.saved.stewardsLoadUserSettings,
    };
  }

  /** The settings as saved (the live ones are also the applied ones). */
  current(): Settings {
    return structuredClone(this.saved);
  }

  response(extra: Partial<Pick<SettingsResponse, 'floored' | 'writable'>> = {}): SettingsResponse {
    return {
      settings: this.current(),
      envOverrides: [...(this.config.envOverrides ?? [])],
      restartRequired: RESTART.filter((k) => this.saved[k] !== this.running[k]),
      ...(this.config.setupCompletedAt
        ? { setupCompletedAt: asTimestamp(this.config.setupCompletedAt) }
        : {}),
      // Remote access as configured (P7-02), read-only: the page builds the phone's QR code.
      remote: {
        ...(this.config.remoteHost ? { host: this.config.remoteHost } : {}),
        tailscaleIdentity: (this.config.tailscaleIdentityLogins?.length ?? 0) > 0,
      },
      ...extra,
    };
  }

  /**
   * Validates, persists and applies `patch` (already shape-checked by `SettingsPatch`). Throws
   * `SettingsError` before anything is written when a field is env-decided or invalid.
   */
  update(patch: SettingsPatch, write: PolicyWrite = {}): SettingsResponse {
    const remote = writableFor(write) === 'limited';
    const refused = (Object.keys(patch) as SettingName[]).filter(
      (k) => patch[k] !== undefined && !REMOTE_WRITABLE.includes(k),
    );
    if (remote && refused.length > 0) {
      throw new SettingsError(
        'remote_settings',
        `settings can be changed only on this machine (a remote client may change the quality ` +
          `tier and tighten the default permission table): ${refused.join(', ')}`,
      );
    }
    const locked = (Object.keys(patch) as SettingName[]).filter(
      (k) => patch[k] !== undefined && this.config.envOverrides?.includes(k),
    );
    if (locked.length > 0) {
      throw new SettingsError(
        'env_override',
        `set by an environment variable, so not editable here: ${locked.join(', ')} ` +
          '(unset the GALACTIC_* variable and restart to edit it in the panel)',
      );
    }

    const next = this.current();
    if (patch.projectsRoot !== undefined) {
      next.projectsRoot = checkProjectsRoot(patch.projectsRoot, {
        home: canonical(this.opts.home ?? homedir()),
        dataDirs: [
          this.config.dataDir,
          dirname(this.config.configPath),
          ...(isAbsolute(this.config.dbPath) ? [dirname(this.config.dbPath)] : []),
        ],
      });
    }
    let floored = false;
    let policyOnDisk: PermissionPolicy | undefined | null; // undefined: unchanged, null: removed
    if (patch.defaultPermissionPolicy !== undefined) {
      const wanted = merged(patch.defaultPermissionPolicy ?? DEFAULT_PERMISSION_POLICY);
      const stored = merged(policyForWrite(wanted, write));
      floored = !sameTable(stored, wanted);
      next.defaultPermissionPolicy = stored;
      policyOnDisk = patch.defaultPermissionPolicy === null && !floored ? null : stored;
    }
    if (patch.retentionDays !== undefined) next.retentionDays = patch.retentionDays;
    if (patch.caps) {
      next.caps = {
        ...next.caps,
        ...Object.fromEntries(Object.entries(patch.caps).filter(([, v]) => v !== undefined)),
      };
    }
    if (patch.transcriptRetention) {
      next.transcriptRetention = {
        ...(next.transcriptRetention ?? DEFAULT_TRANSCRIPT_RETENTION),
        ...Object.fromEntries(
          Object.entries(patch.transcriptRetention).filter(([, v]) => v !== undefined),
        ),
      };
    }
    if (patch.qualityTier !== undefined) next.qualityTier = patch.qualityTier;
    if (patch.stewardsLoadUserSettings !== undefined)
      next.stewardsLoadUserSettings = patch.stewardsLoadUserSettings;
    if (patch.budgets?.warnAtPercent !== undefined) {
      next.budgets = { ...next.budgets, warnAtPercent: patch.budgets.warnAtPercent };
    }
    if (patch.stewardRuntime === null) delete next.stewardRuntime;
    else if (patch.stewardRuntime !== undefined) {
      if (
        patch.stewardRuntime === 'fake' &&
        !(this.opts.allowFakeRuntime ?? this.opts.config.dev)
      ) {
        throw new SettingsError(
          'invalid',
          'the fake runtime is for development only (GALACTIC_DEV): choose a real runtime',
        );
      }
      const known = this.opts.runtimes?.();
      if (known && !known.includes(patch.stewardRuntime)) {
        throw new SettingsError(
          'invalid',
          `no ${patch.stewardRuntime} runtime is set up on this server (available: ${known.join(', ')})`,
        );
      }
      next.stewardRuntime = patch.stewardRuntime;
    }
    if (patch.deliverables?.ide !== undefined) {
      next.deliverables = { ...next.deliverables, ide: this.checkIde(patch.deliverables.ide) };
    }

    // The first-run marker (P25-08): stamped once, never moved back.
    const setupCompletedAt =
      patch.setupCompleted && !this.config.setupCompletedAt ? new Date().toISOString() : undefined;

    this.persist(patch, next, policyOnDisk, setupCompletedAt);
    this.apply(patch, next);
    if (setupCompletedAt) this.config.setupCompletedAt = setupCompletedAt;
    this.saved = next;
    return this.response(patch.defaultPermissionPolicy !== undefined ? { floored } : {});
  }

  /** `auto`, or the bundle id of an IDE the last detection found (decision 127). */
  private checkIde(ide: string): string {
    if (ide === 'auto') return ide;
    if (this.opts.ides && !this.opts.ides.supported) {
      throw new SettingsError(
        'invalid',
        'Mission Control does not run on a Mac here, so it opens nothing: the IDE stays Automatic.',
      );
    }
    const installed = this.opts.ides?.installedBundleIds();
    if (!installed?.includes(ide)) {
      throw new SettingsError(
        'invalid',
        installed && installed.length > 0
          ? `${ide} is not an IDE installed on this Mac (installed: ${installed.join(', ')}).`
          : `${ide} is not an IDE installed on this Mac (none was found).`,
      );
    }
    return ide;
  }

  /** The settings the process started with (the config, the global default policy as set). */
  private fromConfig(): Settings {
    const c = this.config;
    return {
      projectsRoot: c.projectsRoot,
      defaultPermissionPolicy: merged(globalDefaultPolicy()),
      retentionDays: c.retentionMs / DAY_MS,
      caps: {
        maxConcurrentAgents: c.caps.maxConcurrentAgents,
        maxStewardsPerWaykeeper: c.caps.maxStewardsPerWaykeeper,
        maxSpawnsPerHour: c.caps.maxSpawnsPerHour,
        maxSpawnsPerHourPerBrain: c.caps.maxSpawnsPerHourPerBrain,
        maxWallClockMs:
          c.caps.defaults?.maxWallClockMs ??
          this.opts.caps?.defaults.maxWallClockMs ??
          2 * 60 * 60 * 1000,
        maxToolCalls: c.caps.defaults?.maxToolCalls ?? this.opts.caps?.defaults.maxToolCalls ?? 500,
      },
      qualityTier: c.qualityTier ?? DEFAULT_QUALITY_TIER,
      stewardsLoadUserSettings: c.stewardsLoadUserSettings ?? true,
      transcriptRetention: { ...(c.transcriptRetention ?? DEFAULT_TRANSCRIPT_RETENTION) },
      budgets: { warnAtPercent: c.budgets?.warnAtPercent ?? DEFAULT_BUDGET_WARN_PERCENT },
      ...(c.stewardRuntime ? { stewardRuntime: c.stewardRuntime } : {}),
      deliverables: { ide: c.deliverables?.ide ?? 'auto' },
    };
  }

  /** Writes the changed keys into `config.json`, keeping everything else (the token first of all). */
  private persist(
    patch: SettingsPatch,
    next: Settings,
    policy: PermissionPolicy | undefined | null,
    setupCompletedAt?: string,
  ): void {
    const path = this.config.configPath;
    const raw: Record<string, unknown> = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
    if (patch.projectsRoot !== undefined) raw['projectsRoot'] = next.projectsRoot;
    if (policy === null) delete raw['defaultPermissionPolicy'];
    else if (policy !== undefined) raw['defaultPermissionPolicy'] = policy;
    if (patch.retentionDays !== undefined) raw['retentionDays'] = next.retentionDays;
    if (patch.caps) raw['caps'] = { ...((raw['caps'] as object | undefined) ?? {}), ...next.caps };
    if (patch.transcriptRetention) raw['transcriptRetention'] = next.transcriptRetention;
    if (patch.qualityTier !== undefined) raw['qualityTier'] = next.qualityTier;
    if (patch.stewardsLoadUserSettings !== undefined)
      raw['stewardsLoadUserSettings'] = next.stewardsLoadUserSettings;
    if (patch.budgets?.warnAtPercent !== undefined) {
      raw['budgets'] = { ...((raw['budgets'] as object | undefined) ?? {}), ...next.budgets };
    }
    if (patch.stewardRuntime === null) delete raw['stewardRuntime'];
    else if (patch.stewardRuntime !== undefined) raw['stewardRuntime'] = next.stewardRuntime;
    if (patch.deliverables?.ide !== undefined) {
      raw['deliverables'] = {
        ...((raw['deliverables'] as object | undefined) ?? {}),
        ide: next.deliverables?.ide,
      };
    }
    if (setupCompletedAt) raw['setupCompletedAt'] = setupCompletedAt;
    const checked = ConfigFile.safeParse(raw);
    if (!checked.success) {
      throw new SettingsError(
        'invalid',
        `config.json would not be valid: ${checked.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
      renameSync(tmp, path);
    } catch (error) {
      // A full disk (ENOSPC) leaves a truncated temp file: config.json itself is untouched, and
      // nothing is applied (the route answers 507 storage_full).
      rmSync(tmp, { force: true });
      throw error;
    }
  }

  private apply(patch: SettingsPatch, next: Settings): void {
    if (patch.defaultPermissionPolicy !== undefined) {
      setGlobalDefaultPolicy(next.defaultPermissionPolicy);
      this.config.defaultPermissionPolicy = next.defaultPermissionPolicy;
    }
    if (patch.retentionDays !== undefined) {
      this.config.retentionMs = Math.round(next.retentionDays * DAY_MS);
      if (this.opts.archival) this.opts.archival.retentionMs = this.config.retentionMs;
    }
    if (patch.caps) {
      const { maxWallClockMs, maxToolCalls, ...spawn } = next.caps;
      const defaults = { maxWallClockMs, maxToolCalls };
      this.config.caps = { ...spawn, defaults };
      this.opts.caps?.update({ ...spawn, defaults });
    }
    if (patch.transcriptRetention && next.transcriptRetention) {
      this.config.transcriptRetention = { ...next.transcriptRetention };
      if (this.opts.transcriptRetention)
        this.opts.transcriptRetention.policy = { ...next.transcriptRetention };
    }
    if (patch.qualityTier !== undefined) this.config.qualityTier = next.qualityTier;
    if (patch.budgets?.warnAtPercent !== undefined && next.budgets) {
      this.config.budgets = { warnAtPercent: next.budgets.warnAtPercent };
      if (this.opts.budgets) this.opts.budgets.warnAtPercent = next.budgets.warnAtPercent;
    }
    // Read by the brains' Steward spawns at every spawn (`index.ts` hands them this config).
    if (patch.stewardRuntime !== undefined) {
      if (next.stewardRuntime) this.config.stewardRuntime = next.stewardRuntime;
      else delete this.config.stewardRuntime;
    }
    if (patch.deliverables?.ide !== undefined && next.deliverables) {
      this.config.deliverables = { ...this.config.deliverables, ide: next.deliverables.ide };
    }
  }
}

/** A policy with every category filled (the SPEC's table under it), as the settings show it. */
function merged(policy: PermissionPolicy): PermissionPolicy {
  const unclassified = policy.unclassified ?? DEFAULT_PERMISSION_POLICY.unclassified;
  return {
    rules: { ...DEFAULT_PERMISSION_POLICY.rules, ...policy.rules },
    ...(unclassified !== undefined ? { unclassified } : {}),
  };
}

/** Whether two complete tables decide alike (an absent `unclassified` is `ask`). */
function sameTable(a: PermissionPolicy, b: PermissionPolicy): boolean {
  return (
    (a.unclassified ?? 'ask') === (b.unclassified ?? 'ask') &&
    Object.keys(DEFAULT_PERMISSION_POLICY.rules).every(
      (k) => a.rules[k as keyof typeof a.rules] === b.rules[k as keyof typeof b.rules],
    )
  );
}

/**
 * The projects root a patch may set, as it is saved: absolute (or `~/…`, expanded), trimmed and
 * normalised; not an existing file; and, on its symlink-free path, none of the folders a
 * workspace may not be either (`unsafeFolder`: `/`, the home directory itself, inside or
 * containing the data directory) — after a restart it is the Harmonizer's cwd and every new
 * project's parent.
 */
function checkProjectsRoot(value: string, places: { home: string; dataDirs: string[] }): string {
  const abs = expandHome(value.trim());
  if (!isAbsolute(abs)) {
    throw new SettingsError(
      'invalid',
      `the projects root must be an absolute path or ~/…: ${value}`,
    );
  }
  const path = resolve(abs);
  const real = canonical(path);
  for (const dataDir of new Set(places.dataDirs.map((d) => canonical(d)))) {
    const unsafe = unsafeFolder(real, { home: places.home, dataDir }, 'the projects root');
    if (unsafe) throw new SettingsError('invalid', unsafe);
  }
  if (existsSync(path) && !statSync(path).isDirectory()) {
    throw new SettingsError('invalid', `the projects root is a file, not a folder: ${path}`);
  }
  return path;
}
