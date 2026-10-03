import {
  DEFAULT_PERMISSION_POLICY,
  Settings,
  SettingsCaps,
  type PermissionAction,
  type PermissionDecision,
  type PermissionPolicy,
  type SettingName,
  type SettingsResponse,
} from '@galactic/protocol';
import { ApiError } from '../../console/api.js';

/**
 * The settings page's pure parts (P25-08; SPEC §4.6, decisions 50, 51): labels, client-side
 * validation (a courtesy — the server is the authority), and the wording of a server refusal.
 */

/** Saved now, applied at the next start (decision 51). */
export const RESTART_FIELDS: readonly SettingName[] = ['projectsRoot', 'stewardsLoadUserSettings'];

/** The variables that fix a setting at startup (P25-01's `envOverrides`). */
export const ENV_VARIABLES: Partial<Record<SettingName, string>> = {
  projectsRoot: 'GALACTIC_PROJECTS_ROOT',
  retentionDays: 'GALACTIC_RETENTION_DAYS',
  caps: 'GALACTIC_MAX_* (any of the cap variables)',
};

/** One editable row of the default permission table (SPEC §3.6, decision 49's `unclassified`). */
export interface PolicyRow {
  key: PermissionAction | 'unclassified';
  label: string;
}

/** The §3.6 table, in its order, split into the categories the engine decides. */
export const POLICY_ROWS: readonly PolicyRow[] = [
  { key: 'read_workspace', label: 'Read files inside the workspace' },
  { key: 'edit_workspace', label: 'Edit files inside the workspace' },
  { key: 'run_workspace', label: 'Run tests and builds inside the workspace' },
  {
    key: 'destructive',
    label: 'Destructive actions (delete files or branches, rm -rf, force operations)',
  },
  {
    key: 'outside_workspace',
    label:
      'Anything outside the workspace (including the agent’s own configuration: .claude/, .mcp.json, .git/, .husky/)',
  },
  { key: 'network', label: 'Network access (installs, pushes, external calls)' },
  { key: 'push', label: 'git push and anything that leaves the machine' },
  {
    key: 'unclassified',
    label: 'Calls the engine cannot classify (inline scripts, unknown or MCP tools)',
  },
];

export const DECISIONS: readonly PermissionDecision[] = ['allow', 'ask', 'deny'];

/** A table row's value; an absent `unclassified` is `ask` (decision 49). */
export function policyValue(policy: PermissionPolicy, key: PolicyRow['key']): PermissionDecision {
  if (key === 'unclassified') return policy.unclassified ?? 'ask';
  return policy.rules[key] ?? DEFAULT_PERMISSION_POLICY.rules[key] ?? 'ask';
}

export function withPolicyValue(
  policy: PermissionPolicy,
  key: PolicyRow['key'],
  value: PermissionDecision,
): PermissionPolicy {
  if (key === 'unclassified') return { ...policy, unclassified: value };
  return { ...policy, rules: { ...policy.rules, [key]: value } };
}

/** The value the §3.6 table gives a row (what "reset" returns to). */
export function specDefault(key: PolicyRow['key']): PermissionDecision {
  return policyValue(DEFAULT_PERMISSION_POLICY, key);
}

/** Whether a table decides every row as the §3.6 table does. */
export function isSpecTable(policy: PermissionPolicy): boolean {
  return POLICY_ROWS.every((r) => policyValue(policy, r.key) === specDefault(r.key));
}

/** The projects root as typed: absolute or `~/…` (the server also refuses `/`, home, its data). */
export function validateProjectsRoot(value: string): string | undefined {
  const v = value.trim();
  if (!v) return 'Enter a folder.';
  if (!/^(\/|~(\/|$))/.test(v)) return 'Use an absolute path (starting with /) or one under ~/.';
  if (v === '/' || /^\/+$/.test(v)) return 'The projects root cannot be the root folder /.';
  if (/^~\/*$/.test(v)) return 'The projects root cannot be your home folder itself.';
  return Settings.shape.projectsRoot.safeParse(v).success ? undefined : 'Enter a folder.';
}

/** A retention period as typed, in days. */
export function validateRetention(value: string): string | undefined {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) return 'Enter a number of days.';
  if (!Settings.shape.retentionDays.safeParse(n).success)
    return 'Enter more than 0 and at most 3650 days.';
  return undefined;
}

/** One cap field: the form shows `ms` caps in minutes. */
export interface CapField {
  key: keyof SettingsCaps;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** Form value → stored value. */
  scale: number;
}

const MINUTE = 60_000;

export const CAP_FIELDS: readonly CapField[] = [
  {
    key: 'maxWallClockMs',
    label: 'Wall-clock time per agent',
    unit: 'minutes',
    min: 1,
    max: 7 * 24 * 60,
    scale: MINUTE,
  },
  {
    key: 'maxToolCalls',
    label: 'Tool calls per agent',
    unit: 'calls',
    min: 1,
    max: 100_000,
    scale: 1,
  },
  {
    key: 'maxConcurrentAgents',
    label: 'Stewards working at once',
    unit: 'Stewards',
    min: 1,
    max: 64,
    scale: 1,
  },
  {
    key: 'maxStewardsPerWaykeeper',
    label: 'Stewards per Waykeeper',
    unit: 'Stewards',
    min: 1,
    max: 64,
    scale: 1,
  },
  {
    key: 'maxSpawnsPerHour',
    label: 'Agents started per hour (all)',
    unit: 'per hour',
    min: 1,
    max: 10_000,
    scale: 1,
  },
  {
    key: 'maxSpawnsPerHourPerBrain',
    label: 'Agents started per hour by one supervisor',
    unit: 'per hour',
    min: 1,
    max: 10_000,
    scale: 1,
  },
];

export type CapsDraft = Record<keyof SettingsCaps, string>;

/** A stored value in the form's unit: minutes may be fractional (90 000 ms is 1.5). */
const formValue = (f: CapField, stored: number) =>
  String(f.scale === 1 ? stored : Math.round((stored / f.scale) * 10_000) / 10_000);

export function capsDraft(caps: SettingsCaps): CapsDraft {
  return Object.fromEntries(CAP_FIELDS.map((f) => [f.key, formValue(f, caps[f.key])])) as CapsDraft;
}

/**
 * The caps a draft stands for, or the problems found, per field. Minutes may be decimal; the
 * stored value (`Math.round(minutes × 60 000)` ms) is checked against the protocol's bounds, so
 * any value the server accepts (90 000 ms = 1.5 min) is accepted here. Given the saved caps
 * (`base`), a field whose text was not touched keeps its stored value exactly.
 */
export function parseCaps(
  draft: CapsDraft,
  base?: SettingsCaps,
): { caps: SettingsCaps; errors?: undefined } | { caps?: undefined; errors: Partial<CapsDraft> } {
  const errors: Partial<CapsDraft> = {};
  const caps: Partial<SettingsCaps> = {};
  for (const f of CAP_FIELDS) {
    const raw = draft[f.key].trim();
    if (base && raw === formValue(f, base[f.key])) {
      caps[f.key] = base[f.key];
      continue;
    }
    const n = Number(raw);
    const value = f.scale === 1 ? n : Math.round(n * f.scale);
    const whole = f.scale === 1;
    if (
      raw === '' ||
      !Number.isFinite(n) ||
      (whole && !Number.isInteger(n)) ||
      !SettingsCaps.shape[f.key].safeParse(value).success
    ) {
      errors[f.key] = whole
        ? `Whole number from ${f.min} to ${f.max.toLocaleString('en')}.`
        : `From ${f.min} to ${f.max.toLocaleString('en')} ${f.unit}.`;
    } else {
      caps[f.key] = value;
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  const checked = SettingsCaps.safeParse(caps);
  if (!checked.success)
    return { errors: { maxToolCalls: checked.error.issues[0]?.message ?? 'Invalid' } };
  return { caps: checked.data };
}

/** Only the caps that differ from the saved ones (the server merges a caps patch key by key). */
export function changedCaps(caps: SettingsCaps, base: SettingsCaps): Partial<SettingsCaps> {
  return Object.fromEntries(
    CAP_FIELDS.filter((f) => caps[f.key] !== base[f.key]).map((f) => [f.key, caps[f.key]]),
  ) as Partial<SettingsCaps>;
}

/**
 * A server refusal worded for the field it concerns (P25-01's errors): 400 `invalid_body` (the
 * schema's issues), 400 `invalid` (with the server's message), 403 `remote_settings`, 409
 * `env_override`; anything else as "could not save".
 */
export function refusalMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return `Could not reach Mission Control: ${(error as Error)?.message ?? String(error)}`;
  }
  const issues = error.body?.['issues'];
  switch (error.code) {
    case 'invalid_body': {
      const list = Array.isArray(issues)
        ? (issues as { path?: unknown[]; message?: string }[])
            .map((i) => `${(i.path ?? []).join('.') || 'value'}: ${i.message ?? 'invalid'}`)
            .join('; ')
        : '';
      return `Not accepted by the server${list ? ` — ${list}` : ''}.`;
    }
    case 'invalid':
      return `Not accepted: ${error.message}`;
    case 'remote_settings':
      return `Only on the computer running Mission Control: ${error.message}`;
    case 'env_override':
      return `Fixed by an environment variable: ${error.message}`;
    default:
      return `Could not save (${error.status}): ${error.message}`;
  }
}

/** Whether a response is a usable settings reply (an older server, or a stub, may give `{}`). */
export function isSettingsResponse(value: unknown): value is SettingsResponse {
  const v = value as Partial<SettingsResponse> | undefined;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.settings === 'object' &&
    Array.isArray(v.envOverrides) &&
    Array.isArray(v.restartRequired)
  );
}
