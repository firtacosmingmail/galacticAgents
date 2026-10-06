import webpush from 'web-push';
import {
  isPushKind,
  notificationOf,
  type EventEnvelope,
  type PanelNotification,
  type PushKind,
  type PushPayload,
} from '@galactic/protocol';
import { isStorageFailure } from '../db/database.js';
import type { EventLog } from '../domain/event-log.js';
import { notificationLookup } from '../runtime/notifications.js';
import { redactSecrets } from '../runtime/redact.js';
import {
  loadOrCreateVapidKeys,
  vapidKeyId,
  type StoredVapidKeys,
  type VapidKeys,
} from './vapid.js';
import type { PushStore, StoredSubscription, UpsertInput } from './store.js';

/**
 * Web Push sending (P7-04; SPEC §4.5, decision 59). Every committed event is folded through the
 * protocol's `notificationOf` — the trigger rules the page's desktop notifications use, so the
 * ids match — and the push kinds (a question or permission held by the user, a project finished
 * or failed) go to every device that keeps that kind on.
 *
 * Best effort: a push service that answers 404 or 410 means the subscription is gone and the
 * device is removed; 429, 5xx and network errors are retried (at most three attempts, backing off,
 * `Retry-After` honoured up to 30 s); any other answer is recorded on the device and dropped. At
 * most `maxInFlight` deliveries run at once; beyond that a push is dropped with a warning rather
 * than queued without bound. A question reaches a device once per server life however often it is
 * escalated or reassigned to the user (its id is the same, like the page's ledger).
 *
 * Delivery and bookkeeping are separate (P8-12): once the push service accepted a push, a failure
 * to record it (`last_sent_at`, `last_error`, removing a device the push service says is gone —
 * any database write) never sends it again. A storage refusal (`isStorageFailure`: a full disk) is
 * logged once per episode, until a bookkeeping write works again; the in-memory "already pushed"
 * ledger keeps the same notification from being pushed twice in this server life either way. A
 * device whose removal (404/410) could not be written is skipped from then on and its removal
 * retried on the next push.
 *
 * Logs name a device by its id and the HTTP status only: never the endpoint (a capability URL),
 * its keys, the payload, or the VAPID private key.
 */

/** Why a send failed: the push service's HTTP status, or none for a network error. */
export class PushSendError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly retryAfterMs?: number,
  ) {
    super(statusCode ? `push service answered ${statusCode}` : 'push service unreachable');
    this.name = 'PushSendError';
  }
}

export interface PushSendOptions {
  /** Seconds the push service keeps the message while the device is offline. */
  ttl: number;
  urgency: 'high' | 'normal';
}

/** Sends one encrypted push; throws `PushSendError`. Tests pass a fake. */
export type PushTransport = (
  target: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  opts: PushSendOptions,
) => Promise<void>;

const retryAfterMs = (headers: Record<string, string> | undefined): number | undefined => {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

/** The real transport: `web-push` (aes128gcm, VAPID-signed), 10 s per request. */
export function webPushTransport(vapid: () => VapidKeys & { subject: string }): PushTransport {
  return async (target, payload, opts) => {
    const { subject, publicKey, privateKey } = vapid();
    try {
      await webpush.sendNotification(target, payload, {
        vapidDetails: { subject, publicKey, privateKey },
        TTL: opts.ttl,
        urgency: opts.urgency,
        timeout: 10_000,
        contentEncoding: 'aes128gcm',
      });
    } catch (error) {
      // A WebPushError carries the endpoint in its fields: only the status is kept.
      if (error instanceof webpush.WebPushError) {
        throw new PushSendError(error.statusCode, retryAfterMs(error.headers));
      }
      throw new PushSendError(undefined);
    }
  };
}

export interface PushLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface PushServiceOptions {
  store: PushStore;
  dataDir: string;
  subject: string;
  /** Defaults to `webPushTransport` over the stored keys. */
  transport?: PushTransport;
  log?: PushLog;
  /** Waits between retries (tests make it instant). */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  maxAttempts?: number;
  maxInFlight?: number;
  /** The least time between two test pushes to one device. */
  testIntervalMs?: number;
}

export type DeliveryResult = 'sent' | 'gone' | 'failed' | 'dropped';

/** How long a push may wait for an offline device, and how urgently it is delivered. */
export const PUSH_DELIVERY: Record<PushKind | 'test', PushSendOptions> = {
  // An answer given meanwhile makes a late push misleading: questions expire sooner.
  permission: { ttl: 6 * 3600, urgency: 'high' },
  question: { ttl: 6 * 3600, urgency: 'high' },
  project_completed: { ttl: 24 * 3600, urgency: 'normal' },
  project_failed: { ttl: 24 * 3600, urgency: 'normal' },
  test: { ttl: 60, urgency: 'high' },
};

const BODY_MAX = 120;
const clip = (text: string) => (text.length > BODY_MAX ? `${text.slice(0, BODY_MAX - 1)}…` : text);
const PUSHED_MEMORY = 2000;
/** A device's last test push is remembered this long (the rate limit needs only `testIntervalMs`). */
const TEST_MEMORY_MS = 60_000;

/**
 * What one device is sent for a notification: the kind's own title ("A question for you",
 * "Project finished"), and the question's text or the project's name only on a device that chose
 * details — the lock screen shows whatever the notification says. Secrets are redacted either way.
 */
export function pushPayloadFor(n: PanelNotification, details: boolean): PushPayload {
  const kind = n.kind as PushKind;
  return {
    v: 1,
    id: n.id,
    kind,
    title: n.title,
    ...(details && n.body ? { body: clip(redactSecrets(n.body)) } : {}),
    target: n.target,
    at: n.at,
  };
}

export class PushService {
  private readonly store: PushStore;
  private readonly log: PushLog | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly maxAttempts: number;
  private readonly maxInFlight: number;
  private readonly testIntervalMs: number;
  private readonly transport: PushTransport;
  private keys: StoredVapidKeys | undefined;
  private inFlight = 0;
  private readonly pushed = new Set<string>();
  private readonly lastTest = new Map<string, number>();
  private readonly running = new Set<Promise<unknown>>();
  /**
   * Devices the push service called gone whose removal the database refused (P8-12), each with
   * the `updated_at` of the row that was gone: a device subscribed again since (a newer row) is
   * neither skipped nor removed.
   */
  private readonly goneIds = new Map<string, string>();
  /**
   * While set, the subscriptions bound to replaced keys are not cleared yet: rows last written at
   * or before this time (the current key's creation) are skipped until the clearing works. It is
   * worked out from `settings` on loading the keys, so a restart still clears them (P8-12, S5).
   */
  private clearCutoff: string | undefined;
  /** A bookkeeping write was refused by the storage and none has worked since (P8-12). */
  private storageEpisode = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly opts: PushServiceOptions) {
    this.store = opts.store;
    this.log = opts.log;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()));
    this.now = opts.now ?? (() => Date.now());
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.maxInFlight = opts.maxInFlight ?? 32;
    this.testIntervalMs = opts.testIntervalMs ?? 5_000;
    this.transport =
      opts.transport ?? webPushTransport(() => ({ ...this.vapidKeys(), subject: opts.subject }));
  }

  /**
   * The key pair, made on first need. When it had to be made anew (no `vapid.json`, or one that
   * could not be read), every subscription stored before is bound to the old public key and can
   * never be delivered again: they are cleared, with a warning that names only how many. Which key
   * they were last cleared for is kept in `settings`, so a clearing the database refused is still
   * done after a restart; only rows written at or before the key was made are cleared, so a device
   * that subscribed with the new key meanwhile is kept.
   */
  vapidKeys(): VapidKeys {
    if (!this.keys) {
      const keys = loadOrCreateVapidKeys({
        dataDir: this.opts.dataDir,
        ...(this.log ? { warn: (m: string) => this.log!.warn(`push: ${m}`) } : {}),
      });
      this.keys = keys;
      let clearedFor: string | undefined;
      try {
        clearedFor = this.store.clearedForKey();
      } catch {
        clearedFor = undefined; // clearing again is harmless: it removes only older rows
      }
      if (clearedFor !== vapidKeyId(keys.publicKey)) this.clearCutoff = keys.createdAt;
    }
    this.clearOldSubscriptions();
    return { publicKey: this.keys.publicKey, privateKey: this.keys.privateKey };
  }

  /**
   * Clears the subscriptions bound to replaced keys. When the database refuses it (a full disk),
   * the keys stay made — the file is written — and the clearing is retried on the next need (or
   * after a restart), so a refused clear never leaves dead subscriptions behind for good.
   */
  private clearOldSubscriptions(): void {
    const cutoff = this.clearCutoff;
    if (cutoff === undefined || !this.keys) return;
    const keyId = vapidKeyId(this.keys.publicKey);
    const removed = this.bookkeep('clearing the old subscriptions', () =>
      this.store.clearBoundToOldKeys(cutoff, keyId),
    );
    if (removed === undefined) return;
    this.clearCutoff = undefined;
    if (removed > 0) {
      this.log?.warn(
        `push: new push keys were made; ${removed} device subscription${removed === 1 ? '' : 's'} bound to the old keys removed (each device turns push on again)`,
      );
    }
  }

  /**
   * One bookkeeping write. Its failure never reaches delivery: a storage refusal is logged once per
   * episode (the next write that works ends it), any other failure each time by its name only.
   * Returns the write's result, or undefined when it failed.
   */
  private bookkeep<T>(what: string, write: () => T): T | undefined {
    try {
      const result = write();
      if (this.storageEpisode) {
        this.storageEpisode = false;
        this.log?.info('push: the database takes writes again; push records are kept again');
      }
      return result;
    } catch (error) {
      if (isStorageFailure(error)) {
        if (!this.storageEpisode) {
          this.storageEpisode = true;
          const code = (error as { code: string }).code;
          this.log?.warn(
            `push: the database refused ${what} (${code}); pushes are still sent once each, their records are not kept until it takes writes again`,
          );
        }
      } else {
        this.log?.warn(`push: ${what} failed (${(error as Error).name})`);
      }
      return undefined;
    }
  }

  /**
   * A device the push service called gone: removed, or skipped until its removal can be written.
   * Only the row that was gone (`updatedAt`) is removed: one subscribed again since is kept.
   */
  private prune(id: string, updatedAt: string): boolean {
    const removal = this.bookkeep(`removing device ${id}`, () => this.store.remove(id, updatedAt));
    if (removal === undefined) {
      this.goneIds.set(id, updatedAt);
      return false;
    }
    this.goneIds.delete(id);
    return true;
  }

  /** Retries the removals the database refused before. */
  private retryPrunes(): void {
    for (const [id, updatedAt] of [...this.goneIds]) this.prune(id, updatedAt);
  }

  /** Whether a stored subscription may be sent to: not gone, and not bound to replaced keys. */
  private deliverable(sub: StoredSubscription): boolean {
    const goneAt = this.goneIds.get(sub.device.id);
    if (goneAt !== undefined) {
      if (goneAt === sub.device.updatedAt) return false;
      this.goneIds.delete(sub.device.id); // subscribed again since it was gone
    }
    return this.clearCutoff === undefined || sub.device.updatedAt > this.clearCutoff;
  }

  publicKey(): string {
    return this.vapidKeys().publicKey;
  }

  /**
   * Subscribes a device or updates it (`PUT /api/push/subscription`). Subscriptions bound to
   * replaced keys are cleared first (so this write is not mistaken for one), and a device the push
   * service called gone before is no longer skipped or removed: it subscribed again.
   */
  subscribe(input: UpsertInput): StoredSubscription {
    this.vapidKeys();
    const stored = this.store.upsert(input);
    this.goneIds.delete(stored.device.id);
    return stored;
  }

  /** Follows the log: each committed event that is worth a push is sent. Returns a stop. */
  start(log: EventLog): () => void {
    const lookup = notificationLookup(log);
    this.unsubscribe = log.subscribe((envelope) => {
      try {
        this.onEvent(envelope, lookup);
      } catch (error) {
        this.log?.warn(`push: ${(error as Error).name}`);
      }
    });
    return () => this.stop();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Resolves when every delivery started so far has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  onEvent(envelope: EventEnvelope, lookup = {}): void {
    const n = notificationOf(envelope, lookup);
    if (!n || !isPushKind(n.kind)) return;
    if (this.pushed.has(n.id)) return;
    this.retryPrunes();
    const kind = n.kind;
    const candidates = () => this.store.forKind(kind).filter((s) => this.deliverable(s));
    if (candidates().length === 0) return;
    // Loading the keys clears the subscriptions bound to replaced ones (also after a restart);
    // those not cleared yet are skipped by `deliverable`: nothing can reach them.
    this.vapidKeys();
    const devices = candidates();
    if (devices.length === 0) return;
    this.remember(n.id);
    for (const sub of devices) {
      const payload = pushPayloadFor(n, sub.device.details);
      this.track(this.deliver(sub, payload, PUSH_DELIVERY[n.kind]));
    }
  }

  /** "Send a test push" from a device's settings. `undefined` when the device is unknown. */
  async test(endpoint: string): Promise<DeliveryResult | 'too_soon' | undefined> {
    this.retryPrunes();
    if (!this.store.byEndpoint(endpoint)) return undefined;
    this.vapidKeys();
    const sub = this.store.byEndpoint(endpoint);
    if (!sub || !this.deliverable(sub)) return undefined;
    this.pruneTests();
    const last = this.lastTest.get(sub.device.id);
    if (last !== undefined && this.now() - last < this.testIntervalMs) return 'too_soon';
    this.lastTest.set(sub.device.id, this.now());
    const payload: PushPayload = {
      v: 1,
      id: 'galactic:test',
      kind: 'test',
      title: 'GalacticAgents',
      body: 'Push notifications work on this device.',
      at: new Date(this.now()).toISOString(),
    };
    return this.track(this.deliver(sub, payload, PUSH_DELIVERY.test, 1));
  }

  /** Forgets test times that can no longer limit anything: older than a minute, or a removed device. */
  private pruneTests() {
    const cutoff = this.now() - Math.max(this.testIntervalMs, TEST_MEMORY_MS);
    for (const [id, at] of this.lastTest) {
      if (at < cutoff || !this.store.get(id)) this.lastTest.delete(id);
    }
  }

  /** How many test times are remembered (tests). */
  get rememberedTests(): number {
    return this.lastTest.size;
  }

  private remember(id: string) {
    this.pushed.add(id);
    if (this.pushed.size > PUSHED_MEMORY) {
      const oldest = this.pushed.values().next().value;
      if (oldest !== undefined) this.pushed.delete(oldest);
    }
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.running.add(p);
    void p.finally(() => this.running.delete(p)).catch(() => undefined);
    return p;
  }

  private async deliver(
    sub: StoredSubscription,
    payload: PushPayload,
    opts: PushSendOptions,
    attempts = this.maxAttempts,
  ): Promise<DeliveryResult> {
    const id = sub.device.id;
    // A delivery holds its slot through its retries and back-offs (up to ~30 s each): during a
    // push service outage the slots can fill up and further pushes are dropped. Best effort by
    // design (SPEC decision 95) — bounded memory and connections beat a queue that grows.
    if (this.inFlight >= this.maxInFlight) {
      this.log?.warn(`push: too many pushes in flight; one for device ${id} was dropped`);
      return 'dropped';
    }
    this.inFlight++;
    try {
      const body = JSON.stringify(payload);
      for (let attempt = 1; ; attempt++) {
        // Only the send is guarded here: what follows a send is bookkeeping, and a failure to
        // record it must never be taken for a failed send (P8-12).
        let failure: unknown;
        try {
          await this.transport({ endpoint: sub.endpoint, keys: sub.keys }, body, opts);
        } catch (error) {
          failure = error ?? new PushSendError(undefined);
        }
        if (failure === undefined) {
          this.bookkeep(`recording the push to device ${id}`, () => this.store.markSent(id));
          return 'sent';
        }
        const status = failure instanceof PushSendError ? failure.statusCode : undefined;
        if (status === 404 || status === 410) {
          const removed = this.prune(id, sub.device.updatedAt);
          this.log?.info(
            `push: device ${id} is no longer subscribed (${status}); ${removed ? 'removed' : 'skipped until its removal can be saved'}`,
          );
          return 'gone';
        }
        const retryable = status === undefined || status === 429 || status >= 500;
        if (!retryable || attempt >= attempts) {
          const what = status ? `HTTP ${status}` : 'network';
          this.bookkeep(`recording the failure of device ${id}`, () =>
            this.store.markFailed(id, what),
          );
          this.log?.warn(`push: device ${id} failed (${what})`);
          return 'failed';
        }
        const hinted = failure instanceof PushSendError ? failure.retryAfterMs : undefined;
        await this.sleep(Math.min(hinted ?? 1_000 * 4 ** (attempt - 1), 30_000));
        // Unsubscribed meanwhile: nothing more to send. A read the storage refuses keeps trying
        // (bounded by the attempts): the device was there when the delivery started.
        if (this.goneIds.has(id)) return 'gone';
        let present = true;
        try {
          present = this.store.get(id) !== undefined;
        } catch (error) {
          if (!isStorageFailure(error)) throw error;
        }
        if (!present) return 'gone';
      }
    } finally {
      this.inFlight--;
    }
  }
}
