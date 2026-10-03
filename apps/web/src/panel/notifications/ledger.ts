/**
 * What this browser has already been notified about (P25-07): the log it follows, the last event
 * `seq` it looked at, and the ids of the recent notifications. Kept in `localStorage` so a reload
 * does not notify twice; every read goes to storage, so tabs share one ledger. Across tabs open
 * at the same moment this is best effort (two tabs can read before either writes); the
 * notification's tag then makes the OS replace rather than stack the second copy.
 * Without storage (private mode, blocked site data) — or once a write to it fails (quota) — it
 * lasts for the page only: from the first failed write the memory copy wins, since what storage
 * still holds is stale.
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
/** Set when a write to storage threw: storage reads would return a stale ledger from then on. */
let storageBroken = false;

export function readLedger(): Ledger | undefined {
  if (storageBroken) return memory;
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
    // Kept in memory only, from now on.
    storageBroken = true;
  }
}

/** Forgets the in-memory fallback and any failed write (tests). */
export function clearLedgerMemory(): void {
  memory = undefined;
  storageBroken = false;
}
