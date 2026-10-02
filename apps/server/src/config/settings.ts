import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_PERMISSION_POLICY,
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
 * | `caps` | live: the next spawn and the next agent's caps; running agents keep theirs |
 * | `qualityTier` | live (stored for the renderer, Phase 3) |
 * | `projectsRoot` | at the next start (the workspace service and the Harmonizer's cwd hold it) |
 * | `stewardsLoadUserSettings` | at the next start (the Claude adapter's spawn options) |
 *
 * A setting an environment variable decided is read-only (`envOverrides`): the file would be
 * shadowed at the next start, so a patch of it is refused. A remote client's default policy is
 * floored at the current default unless `autoApproveRemote` (decision 37): it can tighten the
 * default, never loosen it — the default is the floor of every other remote write.
 */

export const DEFAULT_QUALITY_TIER = 'high' as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The settings a running process cannot change (see the table above). */
const RESTART = ['projectsRoot', 'stewardsLoadUserSettings'] as const;

export class SettingsError extends Error {
  constructor(
    readonly code: 'env_override' | 'invalid',
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

  response(extra: Partial<Pick<SettingsResponse, 'floored'>> = {}): SettingsResponse {
    return {
      settings: this.current(),
      envOverrides: [...(this.config.envOverrides ?? [])],
      restartRequired: RESTART.filter((k) => this.saved[k] !== this.running[k]),
      ...extra,
    };
  }

  /**
   * Validates, persists and applies `patch` (already shape-checked by `SettingsPatch`). Throws
   * `SettingsError` before anything is written when a field is env-decided or invalid.
   */
  update(patch: SettingsPatch, write: PolicyWrite = {}): SettingsResponse {
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
    if (patch.projectsRoot !== undefined) next.projectsRoot = checkProjectsRoot(patch.projectsRoot);
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
    if (patch.qualityTier !== undefined) next.qualityTier = patch.qualityTier;
    if (patch.stewardsLoadUserSettings !== undefined)
      next.stewardsLoadUserSettings = patch.stewardsLoadUserSettings;

    this.persist(patch, next, policyOnDisk);
    this.apply(patch, next);
    this.saved = next;
    return this.response(patch.defaultPermissionPolicy !== undefined ? { floored } : {});
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
    };
  }

  /** Writes the changed keys into `config.json`, keeping everything else (the token first of all). */
  private persist(
    patch: SettingsPatch,
    next: Settings,
    policy: PermissionPolicy | undefined | null,
  ): void {
    const path = this.config.configPath;
    const raw: Record<string, unknown> = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
      : {};
    if (patch.projectsRoot !== undefined) raw['projectsRoot'] = patch.projectsRoot;
    if (policy === null) delete raw['defaultPermissionPolicy'];
    else if (policy !== undefined) raw['defaultPermissionPolicy'] = policy;
    if (patch.retentionDays !== undefined) raw['retentionDays'] = next.retentionDays;
    if (patch.caps) raw['caps'] = { ...((raw['caps'] as object | undefined) ?? {}), ...next.caps };
    if (patch.qualityTier !== undefined) raw['qualityTier'] = next.qualityTier;
    if (patch.stewardsLoadUserSettings !== undefined)
      raw['stewardsLoadUserSettings'] = next.stewardsLoadUserSettings;
    const checked = ConfigFile.safeParse(raw);
    if (!checked.success) {
      throw new SettingsError(
        'invalid',
        `config.json would not be valid: ${checked.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, path);
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
    if (patch.qualityTier !== undefined) this.config.qualityTier = next.qualityTier;
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

/** The projects root a patch may set: absolute (or `~/…`), not `/`, not an existing file. */
function checkProjectsRoot(value: string): string {
  const abs = expandHome(value.trim());
  if (!isAbsolute(abs)) {
    throw new SettingsError(
      'invalid',
      `the projects root must be an absolute path or ~/…: ${value}`,
    );
  }
  const path = resolve(abs);
  if (path === '/') throw new SettingsError('invalid', 'the projects root cannot be /');
  if (existsSync(path) && !statSync(path).isDirectory()) {
    throw new SettingsError('invalid', `the projects root is a file, not a folder: ${path}`);
  }
  return path;
}
