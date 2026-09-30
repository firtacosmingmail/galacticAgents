import { request } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HealthResponse } from '@galactic/protocol';
import { connectWs, startTestApp, TEST_TOKEN } from './test/harness.js';
import { CLOSE_BAD_HELLO, CLOSE_UNAUTHORIZED } from './ws/gateway.js';

let t: Awaited<ReturnType<typeof startTestApp>>;
const sessions: string[] = [];

beforeEach(async () => {
  sessions.length = 0;
  t = await startTestApp({
    onSession: (socket, hello) => {
      sessions.push(hello.token);
      socket.send(JSON.stringify({ type: 'pong' }));
    },
  });
});
afterEach(() => t.stop());

describe('health endpoint', () => {
  it('answers with the token for loopback callers', async () => {
    const res = await fetch(`${t.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body.token).toBe(TEST_TOKEN);
    expect(body.protocolVersion).toBe(1);
  });

  it('withholds the token from a foreign Origin', async () => {
    const res = await fetch(`${t.baseUrl}/health`, {
      headers: { origin: 'http://evil.example.com' },
    });
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body.token).toBeUndefined();
  });

  it('refuses a wrong Host header', async () => {
    // fetch() silently drops a custom Host header, so use http.request.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request(
        { host: '127.0.0.1', port: t.port, path: '/health', headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
  });
});

describe('websocket gateway', () => {
  it('accepts a valid hello and hands the socket to the session handler', async () => {
    const out = await connectWs(t.wsUrl, {
      send: [{ type: 'hello', token: TEST_TOKEN }],
      until: (m) => m.length >= 1,
    });
    expect(out.error).toBeUndefined();
    expect(out.messages).toEqual([{ type: 'pong' }]);
    expect(sessions).toEqual([TEST_TOKEN]);
  });

  it('refuses a wrong token', async () => {
    const out = await connectWs(t.wsUrl, { send: [{ type: 'hello', token: 'nope' }] });
    expect(out.closeCode).toBe(CLOSE_UNAUTHORIZED);
    expect(out.messages).toEqual([{ type: 'error', code: 'unauthorized', message: 'bad token' }]);
    expect(sessions).toEqual([]);
  });

  it('refuses a first frame that is not hello', async () => {
    const out = await connectWs(t.wsUrl, { send: [{ type: 'ping' }] });
    expect(out.closeCode).toBe(CLOSE_BAD_HELLO);
    expect(out.messages[0]?.type).toBe('error');
    const garbage = await connectWs(t.wsUrl, { send: ['not json'] });
    expect(garbage.closeCode).toBe(CLOSE_BAD_HELLO);
  });

  it('refuses the upgrade with a wrong Host header', async () => {
    const out = await connectWs(t.wsUrl, {
      headers: { host: 'evil.example.com' },
      send: [{ type: 'hello', token: TEST_TOKEN }],
    });
    expect(out.error).toBe('http 403');
    expect(sessions).toEqual([]);
  });

  it('refuses the upgrade from a foreign Origin, allows an allowed one', async () => {
    const foreign = await connectWs(t.wsUrl, {
      origin: 'http://evil.example.com',
      send: [{ type: 'hello', token: TEST_TOKEN }],
    });
    expect(foreign.error).toBe('http 403');

    const local = await connectWs(t.wsUrl, {
      origin: 'http://localhost:5173',
      send: [{ type: 'hello', token: TEST_TOKEN }],
      until: (m) => m.length >= 1,
    });
    expect(local.error).toBeUndefined();
    expect(local.messages).toEqual([{ type: 'pong' }]);
  });

  it('refuses an unknown path', async () => {
    const out = await connectWs(`${t.baseUrl.replace('http', 'ws')}/nope`);
    expect(out.error).toBe('http 404');
  });
});
