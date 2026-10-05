import { createECDH, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PushDeviceResponse,
  PushStatusResponse,
  allPushKindsOn,
  type PushSubscriptionJson,
} from '@galactic/protocol';
import { buildApp, type App } from '../app.js';
import type { ServerConfig } from '../config/config.js';
import { openDatabase } from '../db/database.js';
import { testConfig, TEST_TOKEN } from '../test/harness.js';
import { createPush, type Push } from './index.js';
import { MAX_PUSH_DEVICES } from './routes.js';
import type { PushTransport } from './service.js';
import { VAPID_FILE } from './vapid.js';

/**
 * The push endpoints (P7-04): bearer-guarded, per device, the phone manages its own device but
 * not others (decision 90), and nothing secret is listed or logged.
 */

const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
/** What Tailscale Serve adds to a phone's request (P7-02). */
const PHONE = {
  ...BEARER,
  host: 'mymac.tail1234.ts.net',
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-proto': 'https',
};

function subscription(n = 1): PushSubscriptionJson {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://web.push.apple.com/device-${n}-${randomBytes(6).toString('hex')}`,
    expirationTime: null,
    keys: { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

let app: App | undefined;
let config: (ServerConfig & { cleanup: () => void }) | undefined;
let logged = '';

async function start(over: Partial<ServerConfig> = {}) {
  logged = '';
  config = testConfig({
    allowedHosts: ['localhost', '127.0.0.1', 'mymac.tail1234.ts.net'],
    ...over,
  });
  const transport = vi.fn<PushTransport>(async () => undefined);
  const push: Push = createPush(openDatabase(':memory:'), config, { transport, env: {} });
  app = buildApp({
    config,
    push,
    logger: { level: 'trace', stream: { write: (line: string) => void (logged += line) } },
  });
  await app.fastify.ready();
  return { push, transport, config };
}

afterEach(async () => {
  await app?.close();
  config?.cleanup();
  app = undefined;
  config = undefined;
});

const inject = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) =>
  app!.fastify.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

describe('push routes (P7-04)', () => {
  it('every route needs the token', async () => {
    await start();
    const sub = subscription();
    for (const [method, url, body] of [
      ['GET', '/api/push', undefined],
      ['PUT', '/api/push/subscription', { subscription: sub }],
      ['POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }],
      ['POST', '/api/push/test', { endpoint: sub.endpoint }],
      ['DELETE', '/api/push/devices/0123456789abcdef0123456789abcdef', undefined],
    ] as const) {
      const res = await inject(method, url, {}, body);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    expect(existsSync(join(config!.dataDir, VAPID_FILE))).toBe(false);
  });

  it('GET makes the key pair on first need (0600) and lists devices without endpoints', async () => {
    const { config } = await start();
    const res = await inject('GET', '/api/push', BEARER);
    expect(res.statusCode).toBe(200);
    const body = PushStatusResponse.parse(res.json());
    const file = join(config.dataDir, VAPID_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(readFileSync(file, 'utf8')) as {
      publicKey: string;
      privateKey: string;
    };
    expect(body.publicKey).toBe(stored.publicKey);
    expect(res.body).not.toContain(stored.privateKey);
    expect(body.devices).toEqual([]);
    expect(body.canRemoveOthers).toBe(true);

    const sub = subscription();
    await inject('PUT', '/api/push/subscription', BEARER, {
      subscription: sub,
      label: 'Mac · Chrome',
    });
    const listed = await inject('GET', '/api/push', BEARER);
    expect(listed.body).not.toContain(sub.endpoint);
    expect(listed.body).not.toContain(sub.keys.auth);
    expect(PushStatusResponse.parse(listed.json()).devices[0]).toMatchObject({
      label: 'Mac · Chrome',
      origin: 'local',
      details: false,
    });
    // Neither the private key nor an endpoint reaches the log.
    expect(logged).not.toContain(stored.privateKey);
    expect(logged).not.toContain(sub.endpoint);
  });

  it('the phone subscribes, changes its toggles, tests and unsubscribes its own device', async () => {
    const { transport } = await start();
    const sub = subscription();
    const created = await inject('PUT', '/api/push/subscription', PHONE, {
      subscription: sub,
      label: 'iPhone · Safari (Home Screen)',
    });
    expect(created.statusCode).toBe(200);
    const device = PushDeviceResponse.parse(created.json()).device;
    expect(device).toMatchObject({ origin: 'remote', kinds: allPushKindsOn(), details: false });

    const changed = await inject('PUT', '/api/push/subscription', PHONE, {
      subscription: sub,
      kinds: { ...allPushKindsOn(), project_completed: false },
      details: true,
    });
    expect(PushDeviceResponse.parse(changed.json()).device).toMatchObject({
      id: device.id,
      label: 'iPhone · Safari (Home Screen)',
      details: true,
      kinds: { project_completed: false },
    });

    const test = await inject('POST', '/api/push/test', PHONE, { endpoint: sub.endpoint });
    expect(test.json()).toEqual({ ok: true, result: 'sent' });
    expect(transport).toHaveBeenCalledTimes(1);
    const again = await inject('POST', '/api/push/test', PHONE, { endpoint: sub.endpoint });
    expect(again.statusCode).toBe(429);

    const gone = await inject('POST', '/api/push/unsubscribe', PHONE, { endpoint: sub.endpoint });
    expect(gone.json()).toEqual({ ok: true, removed: true });
    const missing = await inject('POST', '/api/push/test', PHONE, { endpoint: sub.endpoint });
    expect(missing.statusCode).toBe(404);
  });

  it('refuses an endpoint that is not a browser push service, and bad bodies', async () => {
    await start();
    const sub = subscription();
    for (const endpoint of [
      'https://127.0.0.1/x',
      'https://mymac.tail1234.ts.net/api/control',
      'https://example.com/push',
    ]) {
      const res = await inject('PUT', '/api/push/subscription', BEARER, {
        subscription: { ...sub, endpoint },
      });
      expect(res.statusCode, endpoint).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_endpoint' });
    }
    const http = await inject('PUT', '/api/push/subscription', BEARER, {
      subscription: { ...sub, endpoint: 'http://fcm.googleapis.com/x' },
    });
    expect(http.json()).toMatchObject({ error: 'invalid_body' });
    const junk = await inject('PUT', '/api/push/subscription', BEARER, { subscription: 'x' });
    expect(junk.statusCode).toBe(400);
  });

  it('removing another device is the Mac’s (decision 90), unless autoApproveRemote', async () => {
    const { push } = await start();
    const mac = push.store.upsert({ subscription: subscription(1), origin: 'local' });
    const phoneList = PushStatusResponse.parse((await inject('GET', '/api/push', PHONE)).json());
    expect(phoneList.canRemoveOthers).toBe(false);
    const refused = await inject('DELETE', `/api/push/devices/${mac.device.id}`, PHONE);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: 'remote_control' });
    expect(push.store.list()).toHaveLength(1);
    const ok = await inject('DELETE', `/api/push/devices/${mac.device.id}`, BEARER);
    expect(ok.json()).toEqual({ ok: true });
    const again = await inject('DELETE', `/api/push/devices/${mac.device.id}`, BEARER);
    expect(again.statusCode).toBe(404);

    await app!.close();
    config!.cleanup();
    const trusted = await start({ autoApproveRemote: true });
    const other = trusted.push.store.upsert({ subscription: subscription(2), origin: 'local' });
    const res = await inject('DELETE', `/api/push/devices/${other.device.id}`, PHONE);
    expect(res.statusCode).toBe(200);
  });

  it(`at most ${MAX_PUSH_DEVICES} devices; an existing one may still update`, async () => {
    const { push } = await start();
    const first = subscription(0);
    push.store.upsert({ subscription: first, origin: 'local' });
    for (let i = 1; i < MAX_PUSH_DEVICES; i++) {
      push.store.upsert({ subscription: subscription(i), origin: 'local' });
    }
    const full = await inject('PUT', '/api/push/subscription', BEARER, {
      subscription: subscription(99),
    });
    expect(full.statusCode).toBe(409);
    const update = await inject('PUT', '/api/push/subscription', BEARER, {
      subscription: first,
      details: true,
    });
    expect(update.statusCode).toBe(200);
  });
});
