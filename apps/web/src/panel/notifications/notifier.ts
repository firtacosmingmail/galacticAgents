import {
  notificationOf,
  NotificationsResponse,
  type EventEnvelope,
  type NotificationLookup,
  type NotificationTarget,
  type PanelNotification,
  type ServerMessage,
} from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { WorldState } from '../../state/reduce.js';
import { readLedger, writeLedger, type Ledger } from './ledger.js';
import { notificationApi, notificationsActive, shouldShow } from './prefs.js';
import { focusTarget } from './focus.js';

/**
 * Desktop notifications from the stream (P25-07, SPEC §4.5).
 *
 * Every committed event the page receives is folded through the protocol's `notificationOf`, the
 * same pure function the server's `GET /api/notifications` feed uses, so a notification has the
 * same id from either source and dedup is by id. The ledger (`ledger.ts`) keeps the last `seq`
 * looked at and the recent ids per browser:
 *
 * - **First sight of a log** (a fresh browser, cleared storage, a new database): the snapshot sets
 *   the baseline and nothing older is raised — opening the page never replays history.
 * - **Live events** past the ledger's `seq` are looked at once; an id already handled is skipped.
 * - **A snapshot of the same log** past the ledger's `seq` (a reload, or a reconnect that could
 *   not resume) backfills `GET /api/notifications?after=<seq>`: only what is still current (the
 *   server leaves out questions answered meanwhile), at most a day old, the five most important
 *   shown one by one and the rest folded into one summary.
 * - While notifications are off (not enabled, refused by the browser) the ledger still advances,
 *   so turning them on later raises only what happens from then on. A kind switched off is marked
 *   handled too: it is not raised later.
 */

export const BACKFILL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BACKFILL_MAX_SHOWN = 5;
const BACKFILL_PAGE = 100;
const BACKFILL_MAX_PAGES = 10;

export interface NotifierOptions {
  token: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Notifier {
  /** Call after the store applied the message (the world's names are then up to date). */
  onMessage: (message: ServerMessage) => void;
  stop: () => void;
  /** Resolves when the running backfill (if any) has finished (tests). */
  idle: () => Promise<void>;
}

const lookupOf = (world: WorldState): NotificationLookup => ({
  task: (id) => world.tasks[id],
  project: (id) => world.projects[id],
  question: (id) => world.questions[id],
  agent: (id) => world.agents[id],
});

const importance = (n: PanelNotification) =>
  n.kind === 'permission' ? 0 : n.kind === 'question' ? 1 : n.kind === 'interrupted' ? 2 : 3;

/**
 * The notifications on screen, held until they close: a Notification nobody references may be
 * garbage-collected while still shown, and its `onclick` lost with it.
 */
const liveNotifications = new Set<Notification>();

/** How many shown notifications are still held (tests). */
export const liveNotificationCount = () => liveNotifications.size;

type Shown = {
  id: string;
  title: string;
  body?: string | undefined;
  /** Without one, the click opens the Harmonizer with the inbox in view. */
  target?: NotificationTarget | undefined;
};

/**
 * Shows it through the service worker (P7-04) when one is registered: then it shares its tag
 * space with Web Push, so the page and a push about the same thing make one notification, not
 * two; and mobile browsers, which refuse `new Notification`, show it too. A tap goes through the
 * worker's `notificationclick` (`pwa/notification-clicks.ts`). False when there is no worker.
 */
async function showThroughWorker(n: Shown): Promise<boolean> {
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
  if (!sw) return false;
  const reg = await sw.getRegistration().catch(() => undefined);
  if (!reg || typeof reg.showNotification !== 'function') return false;
  // A push already put this one on screen: leave it.
  const existing = await reg.getNotifications({ tag: n.id }).catch(() => []);
  if (existing.length > 0) return true;
  await reg.showNotification(n.title, {
    tag: n.id,
    icon: '/icons/icon-192.png',
    ...(n.body ? { body: n.body } : {}),
    data: { id: n.id, ...(n.target ? { target: n.target } : {}) },
  });
  return true;
}

/** Shows one desktop notification; its click focuses the window and selects the item. */
export function showNotification(n: Shown) {
  const Api = notificationApi();
  if (!Api) return;
  if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
    void showThroughWorker(n)
      .catch(() => false)
      .then((done) => {
        if (!done) showFromPage(Api, n);
      });
    return;
  }
  showFromPage(Api, n);
}

function showFromPage(Api: typeof Notification, n: Shown) {
  try {
    // The tag makes the OS replace rather than stack a second copy (another tab, a race).
    const shown = new Api(n.title, { tag: n.id, ...(n.body ? { body: n.body } : {}) });
    liveNotifications.add(shown);
    shown.onclose = () => {
      liveNotifications.delete(shown);
    };
    shown.onclick = () => {
      focusTarget(n.target);
      shown.close();
      liveNotifications.delete(shown);
    };
  } catch {
    // Some browsers allow notifications only from a service worker; nothing to show then.
  }
}

export function createNotifier(opts: NotifierOptions): Notifier {
  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = opts.now ?? (() => Date.now());
  let logId: string | undefined;
  let stopped = false;
  let running: Promise<void> = Promise.resolve();

  const update = (change: (l: Ledger) => Ledger) => {
    const current = readLedger();
    if (!current || current.logId !== logId) return;
    writeLedger(change(current));
  };

  /** Marks the notification handled; true when it had not been handled before. */
  const claim = (id: string): boolean => {
    const current = readLedger();
    if (!current || current.logId !== logId) return false;
    if (current.ids.includes(id)) return false;
    writeLedger({ ...current, ids: [...current.ids, id] });
    return true;
  };

  const onEvent = (envelope: EventEnvelope) => {
    if (!logId) return;
    const current = readLedger();
    if (!current || current.logId !== logId || envelope.seq <= current.seq) return;
    writeLedger({ ...current, seq: envelope.seq });
    const n = notificationOf(envelope, lookupOf(useAppStore.getState().world));
    if (!n) return;
    // Decide on the current preferences (another tab may have just turned them on) before
    // claiming: the claim then means "shown or deliberately suppressed by what the user chose".
    const show = shouldShow(n.kind);
    if (claim(n.id) && show) showNotification(n);
  };

  const backfill = async (after: number) => {
    const found: PanelNotification[] = [];
    let cursor = after;
    // A page that fails drops the rest of the backfill (by design): the ledger's seq has already
    // advanced, so it is not retried — losing a catch-up beats raising it twice.
    for (let page = 0; page < BACKFILL_MAX_PAGES && !stopped; page++) {
      let parsed;
      try {
        const res = await fetchImpl(`/api/notifications?after=${cursor}&limit=${BACKFILL_PAGE}`, {
          headers: { authorization: `Bearer ${opts.token}` },
        });
        if (!res.ok) return;
        parsed = NotificationsResponse.safeParse(await res.json());
      } catch {
        return;
      }
      if (!parsed.success) return;
      found.push(...parsed.data.notifications);
      if (!parsed.data.hasMore || parsed.data.seq <= cursor) break;
      cursor = parsed.data.seq;
    }
    if (stopped) return;
    const fresh = found.filter((n) => now() - Date.parse(n.at) <= BACKFILL_MAX_AGE_MS);
    const toShow: PanelNotification[] = [];
    for (const n of fresh) {
      const show = shouldShow(n.kind);
      if (claim(n.id) && show) toShow.push(n);
    }
    toShow.sort((a, b) => importance(a) - importance(b) || b.seq - a.seq);
    for (const n of toShow.slice(0, BACKFILL_MAX_SHOWN)) showNotification(n);
    const rest = toShow.length - BACKFILL_MAX_SHOWN;
    if (rest > 0) {
      showNotification({
        id: 'galactic:backfill-summary',
        title: `${rest} more update${rest === 1 ? '' : 's'} while the page was closed`,
        body: 'Open the panel to see them.',
      });
    }
  };

  const onSnapshot = (snapshotLogId: string, seq: number) => {
    logId = snapshotLogId;
    const current = readLedger();
    if (!current || current.logId !== snapshotLogId) {
      writeLedger({ logId: snapshotLogId, seq, ids: [] });
      return;
    }
    if (current.seq >= seq) return;
    const after = current.seq;
    // Advance first: a reload during the backfill loses it rather than raising it twice.
    update((l) => ({ ...l, seq: Math.max(l.seq, seq) }));
    if (!notificationsActive()) return;
    running = running.then(() => backfill(after));
  };

  return {
    onMessage: (message) => {
      if (stopped) return;
      if (message.type === 'snapshot') onSnapshot(message.logId, message.seq);
      else if (message.type === 'event') {
        const { type: _type, ...envelope } = message;
        onEvent(envelope);
      }
    },
    stop: () => {
      stopped = true;
    },
    idle: () => running,
  };
}
