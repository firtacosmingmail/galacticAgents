import webpush from 'web-push';
import {
  isPushKind,
  notificationOf,
  type EventEnvelope,
  type PanelNotification,
  type PushKind,
  type PushPayload,
} from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';
import { notificationLookup } from '../runtime/notifications.js';
import { redactSecrets } from '../runtime/redact.js';
import { loadOrCreateVapidKeys, type VapidKeys } from './vapid.js';
import type { PushStore, StoredSubscription } from './store.js';

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
  private keys: VapidKeys | undefined;
  private inFlight = 0;
  private readonly pushed = new Set<string>();
  private readonly lastTest = new Map<string, number>();
  private readonly running = new Set<Promise<unknown>>();
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

  /** The key pair, made on first need. */
  vapidKeys(): VapidKeys {
    this.keys ??= loadOrCreateVapidKeys({
      dataDir: this.opts.dataDir,
      ...(this.log ? { warn: (m: string) => this.log!.warn(`push: ${m}`) } : {}),
    });
    return this.keys;
  }

  publicKey(): string {
    return this.vapidKeys().publicKey;
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
    const devices = this.store.forKind(n.kind);
    if (devices.length === 0) return;
    this.remember(n.id);
    for (const sub of devices) {
      const payload = pushPayloadFor(n, sub.device.details);
      this.track(this.deliver(sub, payload, PUSH_DELIVERY[n.kind]));
    }
  }

  /** "Send a test push" from a device's settings. `undefined` when the device is unknown. */
  async test(endpoint: string): Promise<DeliveryResult | 'too_soon' | undefined> {
    const sub = this.store.byEndpoint(endpoint);
    if (!sub) return undefined;
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
    if (this.inFlight >= this.maxInFlight) {
      this.log?.warn(`push: too many pushes in flight; one for device ${id} was dropped`);
      return 'dropped';
    }
    this.inFlight++;
    try {
      const body = JSON.stringify(payload);
      for (let attempt = 1; ; attempt++) {
        try {
          await this.transport({ endpoint: sub.endpoint, keys: sub.keys }, body, opts);
          this.store.markSent(id);
          return 'sent';
        } catch (error) {
          const status = error instanceof PushSendError ? error.statusCode : undefined;
          if (status === 404 || status === 410) {
            this.store.remove(id);
            this.log?.info(`push: device ${id} is no longer subscribed (${status}); removed`);
            return 'gone';
          }
          const retryable = status === undefined || status === 429 || status >= 500;
          if (!retryable || attempt >= attempts) {
            const what = status ? `HTTP ${status}` : 'network';
            this.store.markFailed(id, what);
            this.log?.warn(`push: device ${id} failed (${what})`);
            return 'failed';
          }
          const hinted = error instanceof PushSendError ? error.retryAfterMs : undefined;
          await this.sleep(Math.min(hinted ?? 1_000 * 4 ** (attempt - 1), 30_000));
          // Unsubscribed meanwhile: nothing more to send.
          if (!this.store.get(id)) return 'gone';
        }
      }
    } finally {
      this.inFlight--;
    }
  }
}
