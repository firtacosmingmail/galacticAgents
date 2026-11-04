import type { ProviderUsage, UsageWindow } from '@galactic/protocol';

/**
 * Antigravity quotas (P11-05; P11-01 notes, agy 7; research §6). `agy -p "/usage" --output-format
 * json` answers without a model turn: `command.data.groups[]` (`Gemini Models`, `Claude and GPT
 * models`), each with weekly buckets `{id, name, window, remaining_fraction, reset_time}`. A plan
 * or quota error in print mode exits 3 with a stderr line `AGY_ERROR: {…}` (from the changelog;
 * the exact text was not reachable in P11-01), so a quota error is recognised by its canonical
 * status (`RESOURCE_EXHAUSTED`), HTTP 429, or the words "quota", "usage limit" or "credits".
 */

export const LIMIT_ERROR = 'Gemini usage limit reached';

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The JSON of the last `AGY_ERROR: {…}` line in `stderr`, if any. */
export function agyErrorOf(stderr: string): Record<string, unknown> | undefined {
  const lines = stderr.split('\n').filter((l) => l.includes('AGY_ERROR'));
  for (const line of lines.reverse()) {
    const at = line.indexOf('{');
    if (at < 0) continue;
    try {
      const value: unknown = JSON.parse(line.slice(at));
      if (value && typeof value === 'object') return value as Record<string, unknown>;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

const QUOTA_WORDS = /resource[_ ]exhausted|quota|usage limit|credits balance|rate limit exceeded/i;

/**
 * Whether a run's final `result` reports the quota: `status: "ERROR"` with an `error` in the
 * quota's words (print mode puts the model error there as well as on stderr).
 */
export function isQuotaResult(result: Record<string, unknown>): boolean {
  if (result['status'] !== 'ERROR') return false;
  const error = result['error'];
  const text = typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return QUOTA_WORDS.test(text);
}

/** Whether an exit-3 run's stderr reports the subscription's quota (not a transient error). */
export function isQuotaError(stderr: string): boolean {
  const error = agyErrorOf(stderr);
  if (!error) return false;
  const text = JSON.stringify(error);
  const code = error['code'] ?? error['http_code'] ?? error['httpCode'] ?? error['status_code'];
  return code === 429 || QUOTA_WORDS.test(text);
}

interface Bucket {
  group: string;
  window: string;
  remaining: number;
  resetsAt: string | undefined;
}

/** The buckets of a `/usage` JSON answer (the whole stdout, or the parsed object). */
function bucketsOf(raw: unknown): Bucket[] {
  let value = raw;
  if (typeof raw === 'string') {
    const at = raw.indexOf('{');
    if (at < 0) return [];
    try {
      value = JSON.parse(raw.slice(at));
    } catch {
      return [];
    }
  }
  const groups = asRecord(asRecord(asRecord(value)['command'])['data'])['groups'];
  if (!Array.isArray(groups)) return [];
  const out: Bucket[] = [];
  for (const g of groups) {
    const group = asRecord(g);
    const buckets = group['buckets'];
    if (!Array.isArray(buckets)) continue;
    for (const b of buckets) {
      const bucket = asRecord(b);
      const remaining = bucket['remaining_fraction'];
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) continue;
      const reset = bucket['reset_time'];
      const at = typeof reset === 'string' ? Date.parse(reset) : NaN;
      out.push({
        group: typeof group['name'] === 'string' ? group['name'] : 'Antigravity',
        window: typeof bucket['window'] === 'string' ? bucket['window'] : 'window',
        remaining: Math.min(1, Math.max(0, remaining)),
        resetsAt: Number.isNaN(at) ? undefined : new Date(at).toISOString(),
      });
    }
  }
  return out;
}

/** Whether `/usage` answered as a logged-in account does (`status: SUCCESS` with groups). */
export function usageSucceeded(raw: string): boolean {
  const at = raw.indexOf('{');
  if (at < 0) return false;
  try {
    return asRecord(JSON.parse(raw.slice(at)))['status'] === 'SUCCESS';
  } catch {
    return false;
  }
}

/** The `/usage` answer as the provider's windows ("Gemini Models · weekly"). */
export function usageFrom(raw: unknown): ProviderUsage | undefined {
  const buckets = bucketsOf(raw);
  if (buckets.length === 0) return undefined;
  const windows: UsageWindow[] = buckets.map((b) => ({
    label: `${b.group} · ${b.window}`,
    remainingFraction: b.remaining,
    ...(b.resetsAt ? { resetsAt: b.resetsAt } : {}),
  }));
  return { windows };
}

/**
 * When the quota that stopped the run resets: an exhausted bucket's reset time (the earliest),
 * else the bucket of the model's group (Gemini models, or the Claude and GPT group), else none.
 */
export function limitResetsAt(raw: unknown, model?: string): string | undefined {
  const buckets = bucketsOf(raw).filter((b) => b.resetsAt);
  const earliest = (list: Bucket[]) =>
    list.map((b) => b.resetsAt!).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const exhausted = buckets.filter((b) => b.remaining <= 0);
  if (exhausted.length > 0) return earliest(exhausted);
  const gemini = model === undefined || model.startsWith('gemini');
  const group = buckets.filter((b) => /gemini/i.test(b.group) === gemini);
  return group.length > 0 ? earliest(group) : undefined;
}
