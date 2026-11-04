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
  DEFAULT_DECLARATION_LIMITS,
  DEFAULT_PERMISSION_POLICY,
  DEFAULT_RUN_SETTINGS,
  DEFAULT_TRANSCRIPT_RETENTION,
  PROVIDER_LABEL,
  PROVIDER_RUNTIME,
  Timestamp,
  type RunSettings,
  type AgentRuntime,
  type BrainUserMcp,
  type DeclarationLimits,
  type PermissionPolicy,
  type Provider,
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
 * | `defaultProvider` | live: the next Steward spawned without a provider of its own (P11-03); only a registered provider |
 * | `providers` | live: the next Steward of that provider spawned without a model (P11-03); merged provider by provider, `model: null` clears |
 * | `deliverables.ide` | live: the next Open in IDE (P9-03); `auto` or an installed IDE's bundle id |
 * | `deliverables.declarations` | live: the next agent declaration (P9-04, decision 120) |
 * | `deliverables.runs` | live: the next run's start (`maxConcurrent`), the run's own output cap at its next write, retention's next run (P9-08, decision 130) |
 * | `projectsRoot` | at the next start (the workspace service and the Harmonizer's cwd hold it) |
 * | `stewardsLoadUserSettings` | at the next start (the Claude adapter's spawn options) |
 * | `brainUserMcp` | at the next start (the Claude adapter's spawn options) |
 *
 * `stewardRuntime` is no longer a setting (P11-03, removed from the protocol in P11-09): the next
 * write removes the key from the file after `loadConfig` upgraded it to `defaultProvider`.
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
/** Which brains get the user's MCP servers when `config.json` does not say (Cosmin, 2026-11-03). */
export const DEFAULT_BRAIN_USER_MCP: BrainUserMcp = 'waykeepers';
const DAY_MS = 24 * 60 * 60 * 1000;
/** The settings a running process cannot change (see the table above). */
const RESTART = ['projectsRoot', 'stewardsLoadUserSettings', 'brainUserMcp'] as const;

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
   * The runtimes the server has adapters for: `defaultProvider` may name only a provider whose
   * runtime is one of them (P11-03). Absent: any provider is accepted (tests).
   */
  runtimes?: () => readonly AgentRuntime[];
  /** Where an ignored deprecated field is reported (default `console.warn`). */
  warn?: (message: string) => void;
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
  private readonly running: Pick<
    Settings,
    'projectsRoot' | 'stewardsLoadUserSettings' | 'brainUserMcp'
  >;
  private saved: Settings;

  constructor(private readonly opts: SettingsServiceOptions) {
    this.config = opts.config;
    this.saved = this.fromConfig();
    this.running = {
      projectsRoot: this.saved.projectsRoot,
      stewardsLoadUserSettings: this.saved.stewardsLoadUserSettings,
      brainUserMcp: this.saved.brainUserMcp,
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
  update(given: SettingsPatch, write: PolicyWrite = {}): SettingsResponse {
    const patch = given;
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
    if (patch.brainUserMcp !== undefined) next.brainUserMcp = patch.brainUserMcp;
    if (patch.budgets?.warnAtPercent !== undefined) {
      next.budgets = { ...next.budgets, warnAtPercent: patch.budgets.warnAtPercent };
    }
    if (patch.defaultProvider === null) delete next.defaultProvider;
    else if (patch.defaultProvider !== undefined) {
      next.defaultProvider = this.checkProvider(patch.defaultProvider);
    }
    if (patch.providers) {
      const providers = { ...next.providers };
      for (const [provider, entry] of Object.entries(patch.providers) as [
        Provider,
        { model?: string | null },
      ][]) {
        if (entry.model === null) delete providers[provider];
        else if (entry.model !== undefined) providers[provider] = { model: entry.model };
      }
      if (Object.keys(providers).length > 0) next.providers = providers;
      else delete next.providers;
    }
    if (patch.deliverables?.ide !== undefined) {
      next.deliverables = { ...next.deliverables, ide: this.checkIde(patch.deliverables.ide) };
    }
    if (patch.deliverables?.declarations) {
      next.deliverables = {
        ...next.deliverables,
        ide: next.deliverables?.ide ?? 'auto',
        declarations: {
          ...declarationLimits(this.config),
          ...definedOnly(patch.deliverables.declarations),
        },
      };
    }
    if (patch.deliverables?.runs) {
      const current = runSettings(this.config);
      const { output, ...top } = patch.deliverables.runs;
      next.deliverables = {
        ...next.deliverables,
        ide: next.deliverables?.ide ?? 'auto',
        runs: {
          ...current,
          ...definedOnly(top),
          output: { ...current.output, ...definedOnly(output ?? {}) },
        },
      };
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

  /** A provider whose runtime this server has an adapter for (P11-03). */
  private checkProvider(provider: Provider): Provider {
    const known = this.opts.runtimes?.();
    if (known && !known.includes(PROVIDER_RUNTIME[provider])) {
      const available = (Object.keys(PROVIDER_RUNTIME) as Provider[])
        .filter((p) => known.includes(PROVIDER_RUNTIME[p]))
        .map((p) => PROVIDER_LABEL[p]);
      throw new SettingsError(
        'invalid',
        `${PROVIDER_LABEL[provider]} is not set up on this server (available: ${available.join(', ') || 'none'})`,
      );
    }
    return provider;
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
      brainUserMcp: c.brainUserMcp ?? DEFAULT_BRAIN_USER_MCP,
      transcriptRetention: { ...(c.transcriptRetention ?? DEFAULT_TRANSCRIPT_RETENTION) },
      budgets: { warnAtPercent: c.budgets?.warnAtPercent ?? DEFAULT_BUDGET_WARN_PERCENT },
      ...(c.defaultProvider ? { defaultProvider: c.defaultProvider } : {}),
      ...(c.providers && Object.keys(c.providers).length > 0
        ? { providers: structuredClone(c.providers) }
        : {}),
      deliverables: {
        ide: c.deliverables?.ide ?? 'auto',
        declarations: declarationLimits(c),
        runs: runSettings(c),
      },
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
    if (patch.brainUserMcp !== undefined) raw['brainUserMcp'] = next.brainUserMcp;
    if (patch.budgets?.warnAtPercent !== undefined) {
      raw['budgets'] = { ...((raw['budgets'] as object | undefined) ?? {}), ...next.budgets };
    }
    if (patch.defaultProvider === null) delete raw['defaultProvider'];
    else if (patch.defaultProvider !== undefined) raw['defaultProvider'] = next.defaultProvider;
    if (patch.providers) {
      if (next.providers) raw['providers'] = next.providers;
      else delete raw['providers'];
    }
    // The upgraded Steward runtime (P11-03): the old key goes, what it became is kept.
    if ('stewardRuntime' in raw) {
      delete raw['stewardRuntime'];
      if (raw['defaultProvider'] === undefined && next.defaultProvider) {
        raw['defaultProvider'] = next.defaultProvider;
      }
    }
    if (patch.deliverables?.ide !== undefined) {
      raw['deliverables'] = {
        ...((raw['deliverables'] as object | undefined) ?? {}),
        ide: next.deliverables?.ide,
      };
    }
    if (patch.deliverables?.declarations) {
      raw['deliverables'] = {
        ...((raw['deliverables'] as object | undefined) ?? {}),
        declarations: next.deliverables?.declarations,
      };
    }
    if (patch.deliverables?.runs) {
      raw['deliverables'] = {
        ...((raw['deliverables'] as object | undefined) ?? {}),
        runs: next.deliverables?.runs,
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
    // Read at every Steward spawn (`index.ts` hands the provider catalogue this config).
    if (patch.defaultProvider !== undefined) {
      if (next.defaultProvider) this.config.defaultProvider = next.defaultProvider;
      else delete this.config.defaultProvider;
    }
    if (patch.providers) {
      if (next.providers) this.config.providers = structuredClone(next.providers);
      else delete this.config.providers;
    }
    if (patch.deliverables?.ide !== undefined && next.deliverables) {
      this.config.deliverables = { ...this.config.deliverables, ide: next.deliverables.ide };
    }
    // Read by `DeliverableService` at every declaration (`index.ts` hands it this config).
    if (patch.deliverables?.declarations && next.deliverables?.declarations) {
      this.config.deliverables = {
        ...this.config.deliverables,
        declarations: { ...next.deliverables.declarations },
      };
    }
    // Read by `RunService` at every start and output write, and by retention (P9-08).
    if (patch.deliverables?.runs && next.deliverables?.runs) {
      this.config.deliverables = {
        ...this.config.deliverables,
        runs: { ...next.deliverables.runs, output: { ...next.deliverables.runs.output } },
      };
    }
  }
}

/**
 * The managed runs' limits as configured now (P9-08, decision 130): the file's keys over
 * `DEFAULT_RUN_SETTINGS`, the output's key by key. Read at every start, so a change applies at once.
 */
export function runSettings(config: Pick<ServerConfig, 'deliverables'>): RunSettings {
  const runs = config.deliverables?.runs ?? {};
  const { output, ...top } = runs;
  return {
    ...DEFAULT_RUN_SETTINGS,
    ...definedOnly(top),
    output: { ...DEFAULT_RUN_SETTINGS.output, ...definedOnly(output ?? {}) },
  };
}

/**
 * The agents' declaration limits as configured now (P9-04, decision 120): the file's keys over
 * `DEFAULT_DECLARATION_LIMITS`. Read at every declaration, so a changed setting applies at once.
 */
export function declarationLimits(config: Pick<ServerConfig, 'deliverables'>): DeclarationLimits {
  return { ...DEFAULT_DECLARATION_LIMITS, ...definedOnly(config.deliverables?.declarations ?? {}) };
}

function definedOnly<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
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
