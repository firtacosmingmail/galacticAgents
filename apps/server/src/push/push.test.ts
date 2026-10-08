import { createECDH, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import webpush from 'web-push';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PushPayload,
  allPushKindsOn,
  type Event,
  type PushSubscriptionJson,
  type Question,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { isStorageFailure, type Database } from '../db/database.js';
import { world } from '../test/world.js';
import { isPushServiceEndpoint, pushDeviceId } from './endpoint.js';
import { PushSendError, PushService, webPushTransport, type PushTransport } from './service.js';
import { PushStore } from './store.js';
import { loadOrCreateVapidKeys, vapidKeyId, vapidSubject, VAPID_FILE } from './vapid.js';

/**
 * Web Push on the server (P7-04): the key pair, the device table, what is sent for which event,
 * retries and pruning — with a fake transport — plus one real `web-push` request decrypted the way
 * a browser would, to show the payload is encrypted to the device and signed with our key.
 */

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'galactic-push-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * A data directory whose VAPID keys were made long ago, as on a server where devices subscribe
 * after the keys exist (subscriptions written at or before the keys' creation are bound to older
 * keys and cleared).
 */
const keyedDir = (createdAt = '2000-01-01T00:00:00.000Z') => {
  const d = tempDir();
  writeFileSync(
    join(d, VAPID_FILE),
    JSON.stringify({ ...webpush.generateVAPIDKeys(), createdAt }),
    { mode: 0o600 },
  );
  return d;
};

/** A browser-like subscription: a real P-256 key pair and auth secret, on an allowed service. */
function fakeSubscription(n = 1, host = 'fcm.googleapis.com') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const subscription: PushSubscriptionJson = {
    endpoint: `https://${host}/fcm/send/device-${n}-${randomBytes(4).toString('hex')}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') },
  };
  return { subscription, ecdh, auth };
}

const question = (id: string, over: Partial<Question> = {}): Question => ({
  id,
  kind: 'clarification',
  originAgentId: 'h1',
  holder: { type: 'user' },
  status: 'open',
  context: { text: `Deploy with key sk-ant-api03-${'x'.repeat(40)}?` },
  version: 0,
  createdAt: '2026-10-05T10:00:00.000Z',
  updatedAt: '2026-10-05T10:00:00.000Z',
  ...over,
});

describe('VAPID keys', () => {
  it('are made on first need with mode 0600, then reused', () => {
    const dataDir = tempDir();
    const keys = loadOrCreateVapidKeys({ dataDir });
    const path = join(dataDir, VAPID_FILE);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(loadOrCreateVapidKeys({ dataDir })).toEqual(keys);
  });

  it('a file readable by others is tightened; a damaged one is replaced; warnings carry no key', () => {
    const dataDir = tempDir();
    const keys = loadOrCreateVapidKeys({ dataDir });
    const path = join(dataDir, VAPID_FILE);
    chmodSync(path, 0o644);
    const warnings: string[] = [];
    expect(loadOrCreateVapidKeys({ dataDir, warn: (m) => warnings.push(m) })).toEqual(keys);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, '{broken');
    const fresh = loadOrCreateVapidKeys({ dataDir, warn: (m) => warnings.push(m) });
    expect(fresh.publicKey).not.toBe(keys.publicKey);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(warnings).toHaveLength(2);
    for (const w of warnings) {
      expect(w).not.toContain(keys.privateKey);
      expect(w).not.toContain(fresh.privateKey);
    }
  });

  it('tells the caller when a new pair was made (none yet, or a damaged file), not on reuse', () => {
    const dataDir = tempDir();
    let created = 0;
    const onCreate = () => void created++;
    loadOrCreateVapidKeys({ dataDir, onCreate });
    expect(created).toBe(1);
    loadOrCreateVapidKeys({ dataDir, onCreate });
    expect(created).toBe(1);
    writeFileSync(join(dataDir, VAPID_FILE), '{broken');
    loadOrCreateVapidKeys({ dataDir, onCreate });
    expect(created).toBe(2);
  });

  it('the subject is the Serve name, else a placeholder; the environment may override it', () => {
    expect(vapidSubject({}, 'mac.tail1.ts.net')).toBe('https://mac.tail1.ts.net');
    expect(vapidSubject({}, undefined)).toMatch(/^mailto:/);
    expect(vapidSubject({ GALACTIC_PUSH_SUBJECT: 'mailto:me@example.com' }, 'x.ts.net')).toBe(
      'mailto:me@example.com',
    );
    expect(vapidSubject({ GALACTIC_PUSH_SUBJECT: 'javascript:alert(1)' }, undefined)).toMatch(
      /^mailto:mission-control/,
    );
  });
});

describe('push endpoints', () => {
  it('only the browsers’ push services are accepted', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://web.push.apple.com/QGx',
      'https://updates.push.services.mozilla.com/wpush/v2/x',
      'https://wns2-par02p.notify.windows.com/w/?token=x',
    ]) {
      expect(isPushServiceEndpoint(ok)).toBe(true);
    }
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/abc',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://evilfcm.googleapis.com.attacker.net/x',
      'https://fcm.googleapis.com:8443/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://mac.tail1.ts.net/api/control',
      'not a url',
    ]) {
      expect(isPushServiceEndpoint(bad)).toBe(false);
    }
  });

  it('a device id is the SHA-256 prefix of its endpoint', () => {
    expect(pushDeviceId('https://fcm.googleapis.com/x')).toMatch(/^[0-9a-f]{32}$/);
    expect(pushDeviceId('a')).not.toBe(pushDeviceId('b'));
  });
});

describe('PushStore', () => {
  it('upserts by endpoint, keeps toggles not given, lists devices without endpoints', () => {
    const { log } = world();
    const store = new PushStore(log.db);
    const { subscription } = fakeSubscription();
    const a = store.upsert({ subscription, origin: 'remote', label: 'iPhone' });
    expect(a.device).toMatchObject({ label: 'iPhone', details: false, origin: 'remote' });
    expect(a.device.kinds).toEqual(allPushKindsOn());
    const b = store.upsert({
      subscription,
      origin: 'remote',
      kinds: { ...allPushKindsOn(), project_completed: false },
    });
    expect(b.device.id).toBe(a.device.id);
    expect(b.device.label).toBe('iPhone');
    expect(store.list()).toHaveLength(1);
    expect(JSON.stringify(store.list().map((s) => s.device))).not.toContain(subscription.endpoint);
    expect(store.forKind('project_completed')).toHaveLength(0);
    expect(store.forKind('question')).toHaveLength(1);
    expect(store.remove(a.device.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    store.upsert({ subscription, origin: 'remote' });
    store.upsert({ subscription: fakeSubscription(2).subscription, origin: 'local' });
    expect(store.clear()).toBe(2);
    expect(store.list()).toHaveLength(0);
  });

  it('clears only rows written at or before a cutoff, records the key, and removes by version', () => {
    const { log } = world();
    let clock = '2026-01-01T00:00:00.000Z';
    const store = new PushStore(log.db, () => clock);
    const old = store.upsert({ subscription: fakeSubscription(1).subscription, origin: 'local' });
    clock = '2026-02-01T00:00:00.000Z';
    const fresh = store.upsert({ subscription: fakeSubscription(2).subscription, origin: 'local' });
    expect(store.clearedForKey()).toBeUndefined();
    expect(store.clearBoundToOldKeys('2026-01-01T00:00:00.000Z', 'key-a')).toBe(1);
    expect(store.clearedForKey()).toBe('key-a');
    expect(store.get(old.device.id)).toBeUndefined();
    // A removal of an older version of the row leaves the newer one.
    expect(store.remove(fresh.device.id, '2026-01-01T00:00:00.000Z')).toBe(false);
    expect(store.remove(fresh.device.id, fresh.device.updatedAt)).toBe(true);
  });
});

describe('PushService', () => {
  let w: ReturnType<typeof world>;
  let store: PushStore;
  let sent: { endpoint: string; payload: PushPayload; opts: unknown }[];
  let transport: ReturnType<typeof vi.fn<PushTransport>>;
  let logs: string[];
  let sleeps: number[];
  let service: PushService;

  const make = (over: Partial<ConstructorParameters<typeof PushService>[0]> = {}) => {
    service = new PushService({
      store,
      dataDir: keyedDir(),
      subject: 'mailto:test@example.com',
      transport,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      sleep: async (ms) => void sleeps.push(ms),
      ...over,
    });
    service.start(w.log);
    return service;
  };
  const emit = (event: Event) => w.log.runCommand((ctx) => ctx.emit(event));

  beforeEach(() => {
    w = world();
    store = new PushStore(w.log.db);
    sent = [];
    logs = [];
    sleeps = [];
    transport = vi.fn<PushTransport>(async (target, payload, opts) => {
      sent.push({
        endpoint: target.endpoint,
        payload: PushPayload.parse(JSON.parse(payload)),
        opts,
      });
    });
  });

  it('sends a question, a permission and a project’s end to every device with the kind on', async () => {
    const phone = fakeSubscription(1);
    const mac = fakeSubscription(2);
    store.upsert({ subscription: phone.subscription, origin: 'remote' });
    store.upsert({
      subscription: mac.subscription,
      origin: 'local',
      kinds: { ...allPushKindsOn(), question: false },
    });
    make();
    emit({ type: 'question.opened', question: question('q1') });
    emit({ type: 'question.opened', question: question('q2', { kind: 'permission' }) });
    emit({ type: 'project.state_changed', projectId: 'p1', from: 'in_progress', to: 'completed' });
    emit({ type: 'project.state_changed', projectId: 'p2', from: 'in_progress', to: 'failed' });
    await service.idle();
    const to = (s: { subscription: PushSubscriptionJson }) =>
      sent.filter((x) => x.endpoint === s.subscription.endpoint).map((x) => x.payload.kind);
    expect(to(phone)).toEqual(['question', 'permission', 'project_completed', 'project_failed']);
    expect(to(mac)).toEqual(['permission', 'project_completed', 'project_failed']);
    const q = sent.find((x) => x.payload.id === 'question:q1')!;
    expect(q.payload).toMatchObject({
      title: 'A question for you',
      target: { kind: 'question', id: 'q1' },
    });
    expect(q.opts).toEqual({ ttl: 6 * 3600, urgency: 'high' });
    expect(store.list().every((s) => s.device.lastSentAt)).toBe(true);
  });

  it('the lock screen gets no text unless the device chose details, and secrets are redacted', async () => {
    const plain = fakeSubscription(1);
    const detailed = fakeSubscription(2);
    store.upsert({ subscription: plain.subscription, origin: 'remote' });
    store.upsert({ subscription: detailed.subscription, origin: 'remote', details: true });
    make();
    emit({ type: 'question.opened', question: question('q1') });
    await service.idle();
    const byEndpoint = (s: { subscription: PushSubscriptionJson }) =>
      sent.find((x) => x.endpoint === s.subscription.endpoint)!.payload;
    expect(byEndpoint(plain).body).toBeUndefined();
    const body = byEndpoint(detailed).body!;
    expect(body).toContain('Deploy with key');
    expect(body).not.toContain('sk-ant-api03');
    for (const x of sent) {
      const raw = JSON.stringify(x.payload);
      expect(raw).not.toContain(x.endpoint);
      expect(raw).not.toMatch(/token|Bearer/i);
    }
  });

  it('a project’s end counts its deliverables; the lock screen gets the count, never a title', async () => {
    const plain = fakeSubscription(1);
    const detailed = fakeSubscription(2);
    store.upsert({ subscription: plain.subscription, origin: 'remote' });
    store.upsert({ subscription: detailed.subscription, origin: 'remote', details: true });
    const t = w.log.tables;
    const bodyId = t.bodies.all().find((b) => b.kind === 'planet' && !b.meta?.['reserved'])!.id;
    t.projects.insert({ ...fx.project, id: 'p-del', name: 'Shop site', bodyId });
    const row = { ...fx.deliverable, projectId: 'p-del', taskId: undefined };
    t.deliverables.insert({ ...row, id: 'd-a', title: 'Secret plan.pdf' });
    t.deliverables.insert({ ...row, id: 'd-b', title: 'Screenshot' });
    t.deliverables.insert({ ...row, id: 'd-gone', removedAt: fx.deliverable.createdAt });
    t.deliverables.insert({ ...fx.commandDeliverable, id: 'd-dev', projectId: 'p-del' });
    make();
    emit({
      type: 'project.state_changed',
      projectId: 'p-del',
      from: 'in_progress',
      to: 'completed',
    });
    emit({ type: 'project.state_changed', projectId: 'p1', from: 'in_progress', to: 'completed' });
    await service.idle();
    const of = (s: { subscription: PushSubscriptionJson }, id: string) =>
      sent.find((x) => x.endpoint === s.subscription.endpoint && x.payload.id.startsWith(id))!
        .payload;
    // Two counted: the removed row and the detected command do not count.
    expect(of(plain, 'project:p-del')).toMatchObject({
      title: 'Project finished · 2 deliverables',
    });
    expect(of(plain, 'project:p-del').body).toBeUndefined();
    expect(JSON.stringify(of(plain, 'project:p-del'))).not.toMatch(/Secret plan|Screenshot|Shop/);
    expect(of(detailed, 'project:p-del')).toMatchObject({
      title: 'Project finished · 2 deliverables',
      body: 'Shop site',
    });
    // None: the title is unchanged.
    expect(of(plain, 'project:p1').title).toBe('Project finished');
  });

  it('nothing for tasks, interrupted work, a parked request or a question held by an agent', async () => {
    store.upsert({ subscription: fakeSubscription().subscription, origin: 'local' });
    make();
    emit({ type: 'task.state_changed', taskId: 't1', from: 'in_progress', to: 'completed' });
    emit({ type: 'recovery.needs_attention', agentId: 'a1', reason: 'gone' });
    emit({
      type: 'proposal.parked',
      proposalId: 'pr1',
      reason: 'no free planet',
      waitingFor: 'planet',
      occupied: [],
      offers: [],
    });
    emit({
      type: 'question.opened',
      question: question('q9', { holder: { type: 'agent', id: 'w1' } }),
    });
    emit({ type: 'project.state_changed', projectId: 'p1', from: 'approved', to: 'in_progress' });
    await service.idle();
    expect(transport).not.toHaveBeenCalled();
  });

  it('a question reaches a device once however often it is escalated to the user', async () => {
    store.upsert({ subscription: fakeSubscription().subscription, origin: 'local' });
    make();
    emit({
      type: 'question.opened',
      question: question('q1', { holder: { type: 'agent', id: 'w1' } }),
    });
    const escalate = (version: number) =>
      emit({
        type: 'question.escalated',
        questionId: 'q1',
        from: { type: 'agent', id: 'w1' },
        to: { type: 'user' },
        version,
      });
    escalate(1);
    escalate(2);
    await service.idle();
    expect(sent.map((x) => x.payload.id)).toEqual(['question:q1']);
  });

  it('404 and 410 remove the device; 429/5xx/network retry, bounded; other 4xx are recorded', async () => {
    const gone = fakeSubscription(1);
    const expired = fakeSubscription(2);
    const flaky = fakeSubscription(3);
    const down = fakeSubscription(4);
    const refused = fakeSubscription(5);
    for (const s of [gone, expired, flaky, down, refused]) {
      store.upsert({ subscription: s.subscription, origin: 'remote' });
    }
    const calls = new Map<string, number>();
    transport.mockImplementation(async (target) => {
      const n = (calls.get(target.endpoint) ?? 0) + 1;
      calls.set(target.endpoint, n);
      if (target.endpoint === gone.subscription.endpoint) throw new PushSendError(404);
      if (target.endpoint === expired.subscription.endpoint) throw new PushSendError(410);
      if (target.endpoint === flaky.subscription.endpoint && n === 1) {
        throw new PushSendError(429, 7_000);
      }
      if (target.endpoint === flaky.subscription.endpoint && n === 2) {
        throw new PushSendError(undefined);
      }
      if (target.endpoint === down.subscription.endpoint) throw new PushSendError(503);
      if (target.endpoint === refused.subscription.endpoint) throw new PushSendError(403);
    });
    make();
    emit({ type: 'question.opened', question: question('q1') });
    await service.idle();
    const count = (s: { subscription: PushSubscriptionJson }) => calls.get(s.subscription.endpoint);
    expect(count(gone)).toBe(1);
    expect(count(expired)).toBe(1);
    expect(count(flaky)).toBe(3);
    expect(count(down)).toBe(3); // bounded: three attempts in all
    expect(count(refused)).toBe(1);
    expect(sleeps).toContain(7_000); // Retry-After honoured
    const left = new Map(store.list().map((s) => [s.endpoint, s.device]));
    expect(left.has(gone.subscription.endpoint)).toBe(false);
    expect(left.has(expired.subscription.endpoint)).toBe(false);
    expect(left.get(flaky.subscription.endpoint)!.lastError).toBeUndefined();
    expect(left.get(flaky.subscription.endpoint)!.lastSentAt).toBeDefined();
    expect(left.get(down.subscription.endpoint)!.lastError).toBe('HTTP 503');
    expect(left.get(refused.subscription.endpoint)!.lastError).toBe('HTTP 403');
    // Logs name devices by id, never by endpoint.
    const all = logs.join('\n');
    for (const s of [gone, expired, flaky, down, refused]) {
      expect(all).not.toContain(s.subscription.endpoint);
    }
    expect(all).toContain(pushDeviceId(gone.subscription.endpoint));
  });

  it('a device unsubscribed while a retry waits is not sent to again', async () => {
    const s = fakeSubscription();
    const stored = store.upsert({ subscription: s.subscription, origin: 'remote' });
    transport.mockRejectedValue(new PushSendError(500));
    make({
      sleep: async () => {
        store.remove(stored.device.id);
      },
    });
    emit({ type: 'question.opened', question: question('q1') });
    await service.idle();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('too many deliveries at once drops the excess with a warning', async () => {
    for (let i = 0; i < 3; i++) {
      store.upsert({ subscription: fakeSubscription(i).subscription, origin: 'remote' });
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    transport.mockImplementation(() => gate);
    make({ maxInFlight: 2 });
    emit({ type: 'question.opened', question: question('q1') });
    release();
    await service.idle();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => /dropped/.test(l))).toBe(true);
  });

  it('a test push goes to the device that asks, at most once per interval', async () => {
    const s = fakeSubscription();
    store.upsert({ subscription: s.subscription, origin: 'remote' });
    let now = 1_000_000;
    make({ now: () => now });
    expect(await service.test('https://fcm.googleapis.com/unknown')).toBeUndefined();
    expect(await service.test(s.subscription.endpoint)).toBe('sent');
    expect(sent[0]!.payload).toMatchObject({ id: 'galactic:test', kind: 'test' });
    expect(await service.test(s.subscription.endpoint)).toBe('too_soon');
    now += 5_000;
    expect(await service.test(s.subscription.endpoint)).toBe('sent');
  });

  it('new keys clear every stored subscription (bound to the old key), warning without secrets', () => {
    const dataDir = tempDir();
    const first = make({ dataDir });
    const keys = first.vapidKeys();
    const a = fakeSubscription(1);
    const b = fakeSubscription(2);
    store.upsert({ subscription: a.subscription, origin: 'remote' });
    store.upsert({ subscription: b.subscription, origin: 'local' });
    first.stop();
    // A restart that reads the same file keeps them.
    const again = make({ dataDir });
    expect(again.vapidKeys()).toEqual(keys);
    expect(store.list()).toHaveLength(2);
    again.stop();
    // The file is lost or damaged: new keys, and the old subscriptions can never work again.
    writeFileSync(join(dataDir, VAPID_FILE), '{broken');
    const fresh = make({ dataDir }).vapidKeys();
    expect(fresh.publicKey).not.toBe(keys.publicKey);
    expect(store.list()).toHaveLength(0);
    const warning = logs.find((l) => /2 device subscriptions .*removed/.test(l));
    expect(warning).toBeDefined();
    const all = logs.join('\n');
    for (const secret of [keys.privateKey, fresh.privateKey, a.subscription.endpoint]) {
      expect(all).not.toContain(secret);
    }
  });

  it('test push times are forgotten after a minute or when the device is removed', async () => {
    const a = fakeSubscription(1);
    const b = fakeSubscription(2);
    const stored = store.upsert({ subscription: a.subscription, origin: 'remote' });
    store.upsert({ subscription: b.subscription, origin: 'remote' });
    let now = 1_000_000;
    make({ now: () => now });
    await service.test(a.subscription.endpoint);
    expect(service.rememberedTests).toBe(1);
    store.remove(stored.device.id);
    await service.test(b.subscription.endpoint);
    expect(service.rememberedTests).toBe(1); // a's entry went with its device
    now += 61_000;
    store.upsert({ subscription: a.subscription, origin: 'remote' });
    await service.test(a.subscription.endpoint);
    expect(service.rememberedTests).toBe(1); // b's is older than a minute
  });

  it('makes no keys while nobody is subscribed, and stops following the log on stop', async () => {
    const dataDir = tempDir();
    make({ dataDir });
    emit({ type: 'question.opened', question: question('q1') });
    expect(existsSync(join(dataDir, VAPID_FILE))).toBe(false);
    store.upsert({ subscription: fakeSubscription().subscription, origin: 'local' });
    service.stop();
    emit({ type: 'question.opened', question: question('q2') });
    await service.idle();
    expect(transport).not.toHaveBeenCalled();
  });
});

/** SQLITE_FULL, as better-sqlite3 throws it. */
const diskFull = () =>
  Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });

/**
 * The database cannot grow and has no free page left — not even slack on the subscriptions' own
 * page, so a row that grows (`last_sent_at` from NULL to a time) fails too: every such write fails
 * with a real SQLITE_FULL until the returned function gives the space back (the disk-full drill's
 * technique, P8-04).
 */
function fillDisk(db: Database, deviceId: string): () => void {
  const pages = db.pragma('page_count', { simple: true }) as number;
  db.pragma(`max_page_count = ${pages}`);
  const fill = (write: (n: number, filler: string) => void) => {
    let n = 0;
    for (const size of [4_000, 400, 40, 1]) {
      for (;;) {
        try {
          write(n++, 'x'.repeat(size));
        } catch (error) {
          if (!isStorageFailure(error)) throw error;
          break;
        }
      }
    }
  };
  const insert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
  fill((n, filler) => insert.run(`push-filler-${n}`, filler));
  const grow = db.prepare('UPDATE push_subscriptions SET label = label || ? WHERE id = ?');
  fill((_n, filler) => grow.run(filler, deviceId));
  return () => void db.pragma('max_page_count = 1073741823');
}

/** A store whose writes (records, pruning, clearing) fail with SQLITE_FULL while `full`. */
class FullStore extends PushStore {
  full = false;
  writes = 0;
  private guard<T>(write: () => T): T {
    this.writes++;
    if (this.full) throw diskFull();
    return write();
  }
  override markSent(id: string) {
    this.guard(() => super.markSent(id));
  }
  override markFailed(id: string, error: string) {
    this.guard(() => super.markFailed(id, error));
  }
  override remove(id: string, ifUpdatedAt?: string) {
    return this.guard(() => super.remove(id, ifUpdatedAt));
  }
  override clearBoundToOldKeys(cutoff: string, keyId: string) {
    return this.guard(() => super.clearBoundToOldKeys(cutoff, keyId));
  }
}

describe('PushService on a full disk (P8-12)', () => {
  let w: ReturnType<typeof world>;
  let logs: string[];
  let calls: string[];
  let transport: ReturnType<typeof vi.fn<PushTransport>>;

  const make = (
    store: PushStore,
    over: Partial<ConstructorParameters<typeof PushService>[0]> = {},
  ) => {
    const service = new PushService({
      store,
      dataDir: keyedDir(),
      subject: 'mailto:test@example.com',
      transport,
      log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
      sleep: async () => undefined,
      ...over,
    });
    service.start(w.log);
    return service;
  };
  const emit = (event: Event) => w.log.runCommand((ctx) => ctx.emit(event));
  const storageLines = () => logs.filter((l) => /database refused/.test(l));
  const idOf = (payload: string) => (JSON.parse(payload) as PushPayload).id;

  beforeEach(() => {
    w = world();
    logs = [];
    calls = [];
    transport = vi.fn<PushTransport>(async (target, payload) => {
      calls.push(`${target.endpoint} ${idOf(payload)}`);
    });
  });

  it('a delivered push whose record the full database refuses is sent once, not retried', async () => {
    const store = new PushStore(w.log.db);
    const a = fakeSubscription(1);
    const b = fakeSubscription(2);
    store.upsert({ subscription: a.subscription, origin: 'remote' });
    const filler = store.upsert({ subscription: b.subscription, origin: 'local' });
    const service = make(store);
    // The event commits, then the disk fills before the deliveries record themselves: their
    // `markSent` meets a real SQLITE_FULL.
    emit({ type: 'question.opened', question: question('q1') });
    const giveBack = fillDisk(w.log.db, filler.device.id);
    await service.idle();
    expect(calls.sort()).toEqual(
      [`${a.subscription.endpoint} question:q1`, `${b.subscription.endpoint} question:q1`].sort(),
    );
    expect(store.list().every((s) => s.device.lastSentAt === undefined)).toBe(true);
    // One line for the episode, naming the code, never an endpoint.
    expect(storageLines()).toHaveLength(1);
    expect(storageLines()[0]).toContain('SQLITE_FULL');
    expect(logs.join('\n')).not.toContain(a.subscription.endpoint);
    giveBack();
    // Escalated to the user again in this server life: still not pushed twice.
    emit({
      type: 'question.escalated',
      questionId: 'q1',
      from: { type: 'agent', id: 'w1' },
      to: { type: 'user' },
      version: 1,
    });
    await service.idle();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('with every record refused, each push of a busy stretch is delivered exactly once', async () => {
    const store = new FullStore(w.log.db);
    const devices = [1, 2, 3].map((n) => fakeSubscription(n));
    for (const d of devices) store.upsert({ subscription: d.subscription, origin: 'remote' });
    const flaky = devices[2]!.subscription.endpoint;
    let flakyCalls = 0;
    transport.mockImplementation(async (target, payload) => {
      if (target.endpoint === flaky && ++flakyCalls === 1) throw new PushSendError(503);
      calls.push(`${target.endpoint} ${idOf(payload)}`);
    });
    const service = make(store);
    service.publicKey(); // the keys are loaded (and checked) before the disk fills
    store.writes = 0;
    store.full = true;
    emit({ type: 'question.opened', question: question('q1') });
    emit({ type: 'question.opened', question: question('q2', { kind: 'permission' }) });
    emit({ type: 'project.state_changed', projectId: 'p1', from: 'in_progress', to: 'completed' });
    await service.idle();
    // Every (device, notification) pair exactly once: the 503 was retried, the refused records not.
    const counts = new Map<string, number>();
    for (const c of calls) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(9);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(store.writes).toBe(9);
    expect(storageLines()).toHaveLength(1);
    // A test push on the full disk is still "sent".
    expect(await service.test(devices[0]!.subscription.endpoint)).toBe('sent');
    expect(storageLines()).toHaveLength(1);
  });

  it('a 410 whose removal the database refuses is not sent again, and the removal is retried', async () => {
    const store = new FullStore(w.log.db);
    const gone = fakeSubscription(1);
    const ok = fakeSubscription(2);
    const stored = store.upsert({ subscription: gone.subscription, origin: 'remote' });
    store.upsert({ subscription: ok.subscription, origin: 'remote' });
    transport.mockImplementation(async (target, payload) => {
      calls.push(`${target.endpoint} ${idOf(payload)}`);
      if (target.endpoint === gone.subscription.endpoint) throw new PushSendError(410);
    });
    const service = make(store);
    service.publicKey(); // the keys are loaded (and checked) before the disk fills
    store.full = true;
    emit({ type: 'question.opened', question: question('q1') });
    await service.idle();
    const toGone = () => calls.filter((c) => c.startsWith(gone.subscription.endpoint));
    expect(toGone()).toHaveLength(1);
    expect(store.get(stored.device.id)).toBeDefined(); // the removal could not be saved
    expect(logs.some((l) => /skipped until its removal can be saved/.test(l))).toBe(true);
    // The next push skips the gone device while the disk is still full…
    emit({ type: 'question.opened', question: question('q2') });
    await service.idle();
    expect(toGone()).toHaveLength(1);
    expect(await service.test(gone.subscription.endpoint)).toBeUndefined();
    // …and once there is space, the removal is saved on the next push and records resume.
    store.full = false;
    emit({ type: 'question.opened', question: question('q3') });
    await service.idle();
    expect(toGone()).toHaveLength(1);
    expect(store.get(stored.device.id)).toBeUndefined();
    expect(logs.some((l) => /the database takes writes again/.test(l))).toBe(true);
    expect(store.byEndpoint(ok.subscription.endpoint)!.device.lastSentAt).toBeDefined();
  });

  it('after the storage recovers, records are kept again and a new episode is logged again', async () => {
    const store = new FullStore(w.log.db);
    const s = fakeSubscription();
    store.upsert({ subscription: s.subscription, origin: 'remote' });
    transport.mockImplementation(async (_target, payload) => {
      const id = idOf(payload);
      calls.push(id);
      if (id === 'question:q2') throw new PushSendError(403);
    });
    const service = make(store);
    service.publicKey(); // the keys are loaded (and checked) before the disk fills
    store.full = true;
    emit({ type: 'question.opened', question: question('q1') });
    await service.idle();
    expect(store.list()[0]!.device.lastSentAt).toBeUndefined();
    store.full = false;
    emit({ type: 'question.opened', question: question('q2') });
    await service.idle();
    expect(store.list()[0]!.device.lastError).toBe('HTTP 403');
    emit({ type: 'question.opened', question: question('q3') });
    await service.idle();
    expect(store.list()[0]!.device.lastSentAt).toEqual(expect.any(String));
    expect(store.list()[0]!.device.lastError).toBeUndefined();
    store.full = true;
    emit({ type: 'question.opened', question: question('q4') });
    await service.idle();
    expect(calls).toEqual(['question:q1', 'question:q2', 'question:q3', 'question:q4']);
    expect(storageLines()).toHaveLength(2);
    expect(logs.filter((l) => /the database takes writes again/.test(l))).toHaveLength(1);
  });

  it('new keys whose clearing the database refuses: old subscriptions are skipped, then cleared', async () => {
    const store = new FullStore(w.log.db);
    const dataDir = tempDir();
    const first = make(store, { dataDir });
    first.vapidKeys();
    store.upsert({ subscription: fakeSubscription(1).subscription, origin: 'remote' });
    first.stop();
    writeFileSync(join(dataDir, VAPID_FILE), '{broken');
    store.full = true;
    const fresh = make(store, { dataDir });
    expect(fresh.publicKey()).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(store.list()).toHaveLength(1);
    emit({ type: 'question.opened', question: question('q1') });
    await fresh.idle();
    expect(transport).not.toHaveBeenCalled(); // bound to the replaced key: nothing could reach it
    store.full = false;
    fresh.publicKey();
    expect(store.list()).toHaveLength(0);
    expect(logs.some((l) => /1 device subscription bound to the old keys removed/.test(l))).toBe(
      true,
    );
  });

  /** A store whose clock the test sets (`updated_at` of each write). */
  const clocked = () => {
    const at = { now: '2026-10-06T10:00:00.000Z' };
    return { store: new FullStore(w.log.db, () => at.now), at };
  };

  it('a device gone (410, removal refused) that writes its subscription again is kept and sent to', async () => {
    const { store, at } = clocked();
    const s = fakeSubscription(1);
    const first = store.upsert({ subscription: s.subscription, origin: 'remote' });
    let gone = true;
    transport.mockImplementation(async (target, payload) => {
      calls.push(`${target.endpoint} ${idOf(payload)}`);
      if (gone) throw new PushSendError(410);
    });
    const service = make(store);
    service.publicKey();
    store.full = true;
    emit({ type: 'question.opened', question: question('q1') });
    await service.idle();
    expect(store.get(first.device.id)).toBeDefined(); // removal refused: on the gone list
    // The browser writes the same endpoint again (a later row) without going through the service.
    gone = false;
    at.now = '2026-10-06T10:05:00.000Z';
    store.upsert({ subscription: s.subscription, origin: 'remote' });
    store.full = false;
    emit({ type: 'question.opened', question: question('q2') });
    await service.idle();
    // The retried removal was for the old row only: the device stays and gets the push.
    expect(store.get(first.device.id)).toBeDefined();
    expect(calls).toEqual([
      `${s.subscription.endpoint} question:q1`,
      `${s.subscription.endpoint} question:q2`,
    ]);
  });

  it('subscribing through the service takes a gone device off the gone list at once', async () => {
    const { store, at } = clocked();
    const s = fakeSubscription(1);
    store.upsert({ subscription: s.subscription, origin: 'remote' });
    let gone = true;
    transport.mockImplementation(async (target, payload) => {
      calls.push(`${target.endpoint} ${idOf(payload)}`);
      if (gone) throw new PushSendError(404);
    });
    const service = make(store);
    service.publicKey();
    store.full = true;
    emit({ type: 'question.opened', question: question('q1') });
    await service.idle();
    expect(await service.test(s.subscription.endpoint)).toBeUndefined(); // skipped while gone
    gone = false;
    at.now = '2026-10-06T10:05:00.000Z';
    const again = service.subscribe({ subscription: s.subscription, origin: 'remote' });
    // Still on a full disk: the test push goes, and a later retry does not remove the device.
    expect(await service.test(s.subscription.endpoint)).toBe('sent');
    store.full = false;
    emit({ type: 'question.opened', question: question('q2') });
    await service.idle();
    expect(store.get(again.device.id)).toBeDefined();
    expect(calls.filter((c) => c.endsWith('question:q2'))).toHaveLength(1);
  });

  it('new keys keep a device subscribed with them while the old ones wait to be cleared', async () => {
    const { store, at } = clocked();
    const dataDir = tempDir();
    const first = make(store, { dataDir });
    first.vapidKeys();
    at.now = '2001-01-01T00:00:00.000Z'; // before the next keys are made
    const old = store.upsert({ subscription: fakeSubscription(1).subscription, origin: 'remote' });
    first.stop();
    writeFileSync(join(dataDir, VAPID_FILE), '{broken');
    store.full = true;
    const fresh = make(store, { dataDir });
    fresh.publicKey(); // new keys; clearing refused
    at.now = '2999-01-01T00:00:00.000Z'; // after the new keys: bound to them
    const mine = fakeSubscription(2);
    const kept = fresh.subscribe({ subscription: mine.subscription, origin: 'remote' });
    emit({ type: 'question.opened', question: question('q1') });
    await fresh.idle();
    expect(calls).toEqual([`${mine.subscription.endpoint} question:q1`]);
    store.full = false;
    fresh.publicKey();
    expect(store.get(old.device.id)).toBeUndefined();
    expect(store.get(kept.device.id)).toBeDefined();
  });

  it('a clearing refused before a restart is done after it, keeping newer subscriptions', async () => {
    const { store, at } = clocked();
    const dataDir = tempDir();
    const first = make(store, { dataDir });
    first.vapidKeys();
    at.now = '2001-01-01T00:00:00.000Z';
    const old = store.upsert({ subscription: fakeSubscription(1).subscription, origin: 'remote' });
    first.stop();
    writeFileSync(join(dataDir, VAPID_FILE), '{broken');
    store.full = true;
    const fresh = make(store, { dataDir });
    const keys = fresh.vapidKeys(); // new keys; clearing refused, then the server stops
    fresh.stop();
    at.now = '2999-01-01T00:00:00.000Z';
    const mine = fakeSubscription(2);
    const kept = store.upsert({ subscription: mine.subscription, origin: 'remote' });
    store.full = false;
    // Restart: the file is intact now (no new keys), but the old subscriptions were never cleared.
    const restarted = make(store, { dataDir });
    emit({ type: 'question.opened', question: question('q1') });
    await restarted.idle();
    expect(restarted.vapidKeys()).toEqual(keys);
    expect(store.get(old.device.id)).toBeUndefined();
    expect(store.get(kept.device.id)).toBeDefined();
    expect(calls).toEqual([`${mine.subscription.endpoint} question:q1`]);
    expect(store.clearedForKey()).toBe(vapidKeyId(keys.publicKey));
    // A further restart does not clear again.
    restarted.stop();
    at.now = '2000-06-01T00:00:00.000Z';
    store.upsert({ subscription: fakeSubscription(3).subscription, origin: 'remote' });
    make(store, { dataDir }).vapidKeys();
    expect(store.list()).toHaveLength(2);
  });
});

describe('the real web-push transport', () => {
  it('encrypts the payload to the device (aes128gcm) and signs with our VAPID key', async () => {
    const dataDir = tempDir();
    const keys = loadOrCreateVapidKeys({ dataDir });
    const { subscription, ecdh, auth } = fakeSubscription();
    const payload = JSON.stringify({ v: 1, id: 'question:q1', kind: 'question', title: 'Hi' });
    const target = { endpoint: subscription.endpoint, keys: subscription.keys };
    const details = webpush.generateRequestDetails(target, payload, {
      vapidDetails: { subject: 'mailto:test@example.com', ...keys },
      TTL: 60,
      urgency: 'high',
      contentEncoding: 'aes128gcm',
    });
    expect(details.endpoint).toBe(subscription.endpoint);
    expect(details.headers['Content-Encoding']).toBe('aes128gcm');
    expect(String(details.headers['Authorization'])).toContain(`k=${keys.publicKey}`);
    // Only the device's private key and auth secret open it.
    const ece = createRequire(import.meta.url)('http_ece') as {
      decrypt(buf: Buffer, params: Record<string, unknown>): Buffer;
    };
    const plain = ece.decrypt(details.body as Buffer, {
      version: 'aes128gcm',
      privateKey: ecdh,
      authSecret: auth.toString('base64url'),
    });
    expect(plain.toString('utf8')).toBe(payload);
    expect((details.body as Buffer).toString('utf8')).not.toContain('question:q1');
  });

  it('maps web-push errors to their status only (no endpoint in the error)', async () => {
    const { subscription } = fakeSubscription();
    const keys = loadOrCreateVapidKeys({ dataDir: tempDir() });
    const send = vi.spyOn(webpush, 'sendNotification');
    send.mockRejectedValueOnce(
      new webpush.WebPushError(
        'Received unexpected response code',
        410,
        {},
        'gone',
        subscription.endpoint,
      ),
    );
    send.mockRejectedValueOnce(
      new webpush.WebPushError(
        'slow down',
        429,
        { 'retry-after': '12' },
        '',
        subscription.endpoint,
      ),
    );
    send.mockRejectedValueOnce(new Error(`connect ECONNREFUSED ${subscription.endpoint}`));
    const transport = webPushTransport(() => ({ ...keys, subject: 'mailto:a@b.c' }));
    const fail = (p: Promise<void>) =>
      p.then(
        () => undefined,
        (e: unknown) => e as PushSendError,
      );
    const gone = await fail(transport(subscription, '{}', { ttl: 1, urgency: 'high' }));
    expect(gone).toBeInstanceOf(PushSendError);
    expect(gone!.statusCode).toBe(410);
    expect(gone!.message).not.toContain(subscription.endpoint);
    const slow = await fail(transport(subscription, '{}', { ttl: 1, urgency: 'high' }));
    expect(slow!.retryAfterMs).toBe(12_000);
    const net = await fail(transport(subscription, '{}', { ttl: 1, urgency: 'high' }));
    expect(net!.statusCode).toBeUndefined();
    expect(net!.message).not.toContain(subscription.endpoint);
    expect(send.mock.calls[0]![2]).toMatchObject({ TTL: 1, urgency: 'high', timeout: 10_000 });
  });
});
