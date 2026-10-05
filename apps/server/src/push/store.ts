import {
  PushKinds,
  allPushKindsOn,
  type PushDevice,
  type PushKind,
  type PushSubscriptionJson,
} from '@galactic/protocol';
import type { Database } from '../db/database.js';
import { pushDeviceId } from './endpoint.js';

/** A stored subscription: the device as listed, plus what sending needs (never listed). */
export interface StoredSubscription {
  device: PushDevice;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface Row {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  kinds: string;
  details: number;
  label: string;
  origin: 'local' | 'remote';
  created_at: string;
  updated_at: string;
  last_sent_at: string | null;
  last_error: string | null;
}

const parseKinds = (raw: string): PushKinds => {
  try {
    const parsed = PushKinds.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through: a damaged row sends everything rather than nothing
  }
  return allPushKindsOn();
};

const toStored = (r: Row): StoredSubscription => ({
  endpoint: r.endpoint,
  keys: { p256dh: r.p256dh, auth: r.auth },
  device: {
    id: r.id,
    label: r.label,
    kinds: parseKinds(r.kinds),
    details: r.details === 1,
    origin: r.origin,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.last_sent_at ? { lastSentAt: r.last_sent_at } : {}),
    ...(r.last_error ? { lastError: r.last_error } : {}),
  },
});

export interface UpsertInput {
  subscription: PushSubscriptionJson;
  kinds?: PushKinds | undefined;
  details?: boolean | undefined;
  label?: string | undefined;
  origin: 'local' | 'remote';
}

/**
 * The `push_subscriptions` table (migration 0010): device configuration, not domain state, so no
 * event describes it and it is never in a snapshot.
 */
export class PushStore {
  constructor(
    private readonly db: Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  list(): StoredSubscription[] {
    return (
      this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at, id').all() as Row[]
    ).map(toStored);
  }

  get(id: string): StoredSubscription | undefined {
    const row = this.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as
      Row | undefined;
    return row ? toStored(row) : undefined;
  }

  byEndpoint(endpoint: string): StoredSubscription | undefined {
    return this.get(pushDeviceId(endpoint));
  }

  /** Who sends for `kind`. */
  forKind(kind: PushKind): StoredSubscription[] {
    return this.list().filter((s) => s.device.kinds[kind]);
  }

  /**
   * Subscribes a device or updates it (keyed by its endpoint). Fields left out keep their stored
   * value; a new device starts with every kind on and no details.
   */
  upsert(input: UpsertInput): StoredSubscription {
    const { endpoint, keys } = input.subscription;
    const id = pushDeviceId(endpoint);
    const existing = this.get(id);
    const now = this.now();
    const kinds = input.kinds ?? existing?.device.kinds ?? allPushKindsOn();
    const details = input.details ?? existing?.device.details ?? false;
    const label = input.label ?? existing?.device.label ?? 'A browser';
    this.db
      .prepare(
        `INSERT INTO push_subscriptions
           (id, endpoint, p256dh, auth, kinds, details, label, origin, created_at, updated_at)
         VALUES (@id, @endpoint, @p256dh, @auth, @kinds, @details, @label, @origin, @now, @now)
         ON CONFLICT(id) DO UPDATE SET
           p256dh = excluded.p256dh, auth = excluded.auth, kinds = excluded.kinds,
           details = excluded.details, label = excluded.label, origin = excluded.origin,
           updated_at = excluded.updated_at`,
      )
      .run({
        id,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        kinds: JSON.stringify(kinds),
        details: details ? 1 : 0,
        label,
        origin: input.origin,
        now,
      });
    return this.get(id)!;
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0;
  }

  markSent(id: string): void {
    this.db
      .prepare('UPDATE push_subscriptions SET last_sent_at = ?, last_error = NULL WHERE id = ?')
      .run(this.now(), id);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare('UPDATE push_subscriptions SET last_error = ? WHERE id = ?').run(error, id);
  }
}
