import type { ProviderUsage, UsageWindow } from '@galactic/protocol';

/**
 * ChatGPT subscription limits as Codex reports them (P11-01 notes, Codex 7–8). A plan limit
 * arrives as an `error` notification with `codexErrorInfo: "usageLimitExceeded"` (message "You've
 * hit your usage limit…"), then `turn/completed` with `status: failed`; the reset time is not in
 * the error, so it is read from `account/rateLimits/read`. A transient `rateLimitExceeded` is not
 * a plan limit.
 */

const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The `agent.failed` error text of a plan limit. */
export const LIMIT_ERROR = 'ChatGPT usage limit reached';

/** Whether an `error` notification's params are the subscription's usage limit. */
export function isUsageLimit(params: unknown): boolean {
  const error = asRecord(asRecord(params)['error']);
  const info = error['codexErrorInfo'];
  if (info === 'usageLimitExceeded') return true;
  if (info !== null && typeof info === 'object' && 'usageLimitExceeded' in info) return true;
  const message = typeof error['message'] === 'string' ? error['message'] : '';
  return /^you've hit your usage limit/i.test(message.replace(/’/g, "'"));
}

interface Window {
  usedPercent: number;
  resetsAt?: number;
  windowDurationMins?: number;
}

function windowsOf(snapshot: unknown): Window[] {
  const s = asRecord(snapshot);
  const out: Window[] = [];
  for (const key of ['primary', 'secondary']) {
    const w = asRecord(s[key]);
    if (typeof w['usedPercent'] !== 'number') continue;
    out.push({
      usedPercent: w['usedPercent'],
      ...(typeof w['resetsAt'] === 'number' ? { resetsAt: w['resetsAt'] } : {}),
      ...(typeof w['windowDurationMins'] === 'number'
        ? { windowDurationMins: w['windowDurationMins'] }
        : {}),
    });
  }
  return out;
}

/** The `rateLimits` snapshot of an `account/rateLimits/read` result (or of the update push). */
const snapshotOf = (result: unknown): unknown => asRecord(result)['rateLimits'];

const iso = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString();

/**
 * When the limit that was hit resets (ISO): the latest reset of the exhausted windows, else the
 * latest reset of any window; absent when Codex reports none.
 */
export function limitResetsAt(rateLimitsResult: unknown): string | undefined {
  const windows = windowsOf(snapshotOf(rateLimitsResult)).filter((w) => w.resetsAt !== undefined);
  const exhausted = windows.filter((w) => w.usedPercent >= 100);
  const pool = exhausted.length > 0 ? exhausted : windows;
  if (pool.length === 0) return undefined;
  return iso(Math.max(...pool.map((w) => w.resetsAt!)));
}

/** "5 hours", "7 days", "30 days" — a window by its length. */
export function windowLabel(mins: number | undefined): string {
  if (mins === undefined || mins <= 0) return 'usage window';
  if (mins % 1440 === 0) {
    const days = mins / 1440;
    return days === 1 ? '1 day' : `${days} days`;
  }
  if (mins % 60 === 0) {
    const hours = mins / 60;
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return `${mins} minutes`;
}

/**
 * `account/rateLimits/read` + `account/read` → the subscription's plan and windows. The account's
 * email is never read out of the result.
 */
export function usageFrom(rateLimitsResult: unknown, accountResult: unknown): ProviderUsage {
  const account = asRecord(asRecord(accountResult)['account']);
  const snapshot = asRecord(snapshotOf(rateLimitsResult));
  const plan =
    typeof account['planType'] === 'string'
      ? account['planType']
      : typeof snapshot['planType'] === 'string'
        ? snapshot['planType']
        : undefined;
  const windows: UsageWindow[] = windowsOf(snapshot).map((w) => ({
    label: windowLabel(w.windowDurationMins),
    remainingFraction: Math.min(1, Math.max(0, 1 - w.usedPercent / 100)),
    ...(w.resetsAt !== undefined ? { resetsAt: iso(w.resetsAt) } : {}),
  }));
  return { ...(plan ? { plan } : {}), windows };
}
