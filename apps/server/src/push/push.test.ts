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
import { world } from '../test/world.js';
import { isPushServiceEndpoint, pushDeviceId } from './endpoint.js';
import { PushSendError, PushService, webPushTransport, type PushTransport } from './service.js';
import { PushStore } from './store.js';
import { loadOrCreateVapidKeys, vapidSubject, VAPID_FILE } from './vapid.js';

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
      dataDir: tempDir(),
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
