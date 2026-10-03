/**
 * What this browser has already been notified about (P25-07): the log it follows, the last event
 * `seq` it looked at, and the ids of the recent notifications. Kept in `localStorage` so a reload
 * or a second tab never notifies twice; every read goes to storage, so tabs share one ledger.
 * Without storage (private mode, blocked site data) it lasts for the page only.
 */

export const LEDGER_KEY = 'galactic.notifications.ledger';
/** Notification ids remembered (oldest dropped): far more than a backfill can return at once. */
export const MAX_SEEN = 500;

export interface Ledger {
  logId: string;
  /** The last event `seq` looked at for notifications. */
  seq: number;
  /** Ids of the notifications handled (shown or suppressed), oldest first. */
  ids: string[];
}

let memory: Ledger | undefined;

export function readLedger(): Ledger | undefined {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Ledger>;
      if (
        typeof parsed.logId === 'string' &&
        typeof parsed.seq === 'number' &&
        Array.isArray(parsed.ids)
      ) {
        return {
          logId: parsed.logId,
          seq: parsed.seq,
          ids: parsed.ids.filter((i) => typeof i === 'string'),
        };
      }
    }
    return memory;
  } catch {
    return memory;
  }
}

export function writeLedger(ledger: Ledger): void {
  const trimmed = { ...ledger, ids: ledger.ids.slice(-MAX_SEEN) };
  memory = trimmed;
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(trimmed));
  } catch {
    // Kept in memory only.
  }
}

/** Forgets the in-memory fallback (tests). */
export function clearLedgerMemory(): void {
  memory = undefined;
}
