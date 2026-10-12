import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RemoteActionResponse, RemoteStatus } from '@galactic/protocol';
import { RemoteService, REMOTE_OFF_FILE, REMOTE_SERVE_FILE } from '../remote/service.js';
import { fakeTailscale, forwarding, TS_BIN, TS_NAME } from '../test/fake-tailscale.js';
import { startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';
import type { ServerConfig } from '../config/config.js';
import type { PeerCheck } from './peer-guard.js';

/**
 * Phone access over the routes (P9-16; SPEC decision 137): the status every client reads, and
 * start / stop on the Mac only — with a fake `tailscale` (`test/fake-tailscale.ts`); the real one
 * and the user's Serve configuration are never touched.
 */

const SERVE_HEADERS = {
  host: TS_NAME,
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-host': TS_NAME,
  'x-forwarded-proto': 'https',
};
const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };

let t: Awaited<ReturnType<typeof startTestApp>> | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

async function start(
  opts: {
    ts?: ReturnType<typeof fakeTailscale>;
    config?: Partial<ServerConfig>;
    file?: Record<string, unknown>;
    peer?: PeerCheck;
  } = {},
) {
  const ts = opts.ts ?? fakeTailscale();
  const config = testConfig({
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', TS_NAME],
    ...opts.config,
  });
  if (opts.file) writeFileSync(config.configPath, JSON.stringify(opts.file));
  const ref: {
    port?: number;
    gateway?: { remoteClients(): { connected: number; lastSeenAt?: string } };
  } = {};
  const remote = new RemoteService({
    dataDir: config.dataDir,
    configPath: config.configPath,
    port: () => ref.port,
    remoteHost: config.remoteHost,
    remoteClients: () => ref.gateway?.remoteClients() ?? { connected: 0 },
    exec: ts.exec,
    locate: ts.locate,
    cacheMs: 0,
  });
  t = await startTestApp({
    config,
    remote: { service: remote, ...(opts.peer ? { peer: opts.peer } : {}) },
    onSession: () => undefined,
  });
  ref.port = t.port;
  ref.gateway = t.app.gateway;
  return { ts, config, port: t.port, remote };
}

async function call(
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
) {
  const res = await fetch(`${t!.baseUrl}${path}`, {
    method,
    headers: {
      ...BEARER,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const status = async (headers: Record<string, string> = {}) => {
  const res = await call('GET', '/api/remote/status', headers);
  expect(res.status).toBe(200);
  return RemoteStatus.parse(res.body);
};

describe('GET /api/remote/status (P9-16)', () => {
  it('needs the token', async () => {
    await start();
    const res = await fetch(`${t!.baseUrl}/api/remote/status`);
    expect(res.status).toBe(401);
  });

  it('says why the phone cannot reach it: not installed, stopped, signed out, no MagicDNS', async () => {
    const ts = fakeTailscale({ installed: false });
    await start({ ts });
    expect(await status()).toMatchObject({
      tailscale: 'not_installed',
      ready: false,
      reason: 'not_installed',
    });
    ts.state.installed = true;
    ts.state.backendState = 'Stopped';
    expect(await status()).toMatchObject({ tailscale: 'stopped', reason: 'not_running' });
    ts.state.backendState = 'NeedsLogin';
    expect(await status()).toMatchObject({ tailscale: 'needs_login', reason: 'needs_login' });
    ts.state.backendState = 'Running';
    ts.state.dnsName = undefined;
    expect(await status()).toMatchObject({ tailscale: 'running', reason: 'no_magicdns' });
    expect(ts.writes()).toEqual([]);
  });

  it('is ready when Serve forwards to this port and remoteHost matches; the phone may read it', async () => {
    const ts = fakeTailscale();
    const { port } = await start({ ts, config: { remoteHost: TS_NAME } });
    ts.state.serve = forwarding(port);
    const s = await status(SERVE_HEADERS);
    expect(s).toMatchObject({
      tailscale: 'running',
      name: TS_NAME,
      url: `https://${TS_NAME}`,
      remoteHost: { state: 'matches', value: TS_NAME },
      serve: 'forwarding_to_us',
      serveOwned: false,
      ready: true,
      restartNeeded: false,
    });
    expect(s.reason).toBeUndefined();
  });

  it('reports 443 taken, Funnel on and a remoteHost naming another machine', async () => {
    const ts = fakeTailscale({ serve: forwarding(5173) });
    await start({ ts, config: { remoteHost: TS_NAME } });
    expect(await status()).toMatchObject({ serve: 'taken_by_other', reason: 'port_443_taken' });
    ts.state.serve = { AllowFunnel: { [`${TS_NAME}:443`]: true } };
    expect(await status()).toMatchObject({ serve: 'absent', funnel: true, reason: 'funnel_on' });
    await t!.stop();
    t = undefined;
    await start({ ts: fakeTailscale(), config: { remoteHost: 'other.tail1234.ts.net' } });
    expect(await status()).toMatchObject({
      remoteHost: { state: 'mismatch' },
      reason: 'remote_host_mismatch',
    });
  });

  it('counts the remote sockets connected', async () => {
    await start({ config: { remoteHost: TS_NAME } });
    expect((await status()).remoteClients).toEqual({ connected: 0 });
    const ws = new WebSocket(t!.wsUrl, { headers: SERVE_HEADERS });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'hello', token: TEST_TOKEN, protocolVersion: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const s = await status();
    expect(s.remoteClients.connected).toBe(1);
    expect(s.remoteClients.lastSeenAt).toBeTypeOf('string');
    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await status()).remoteClients.connected).toBe(0);
  });
});

describe('POST /api/remote/start and /stop (P9-16)', () => {
  it('are refused to a remote client, even with autoApproveRemote', async () => {
    const ts = fakeTailscale();
    await start({ ts, config: { remoteHost: TS_NAME, autoApproveRemote: true } });
    for (const action of ['start', 'stop']) {
      const res = await call('POST', `/api/remote/${action}`, SERVE_HEADERS);
      expect(res.status).toBe(403);
      expect(res.body['error']).toBe('remote_control');
    }
    expect(ts.writes()).toEqual([]);
  });

  it('start adds remoteHost, starts HTTP-mode Serve to this port, records it; stop turns it off', async () => {
    const ts = fakeTailscale();
    const { port, config } = await start({ ts, file: { token: 'x' } });
    const res = await call('POST', '/api/remote/start');
    expect(res.status).toBe(200);
    const body = RemoteActionResponse.parse(res.body);
    expect(body.ok).toBe(true);
    expect(ts.writes()).toEqual([
      [TS_BIN, 'serve', '--bg', '--https=443', `http://127.0.0.1:${port}`],
    ]);
    expect(JSON.parse(readFileSync(config.configPath, 'utf8'))).toEqual({
      token: 'x',
      remoteHost: TS_NAME,
    });
    // remoteHost was added after this server started: not ready until a restart.
    expect(body.status).toMatchObject({
      serve: 'forwarding_to_us',
      serveOwned: true,
      restartNeeded: true,
      ready: false,
      reason: 'restart_needed',
    });
    expect(existsSync(join(config.dataDir, REMOTE_SERVE_FILE))).toBe(true);

    // Started again: nothing changes.
    expect((await call('POST', '/api/remote/start')).status).toBe(200);
    expect(ts.writes()).toHaveLength(1);

    const stop = await call('POST', '/api/remote/stop');
    expect(stop.status).toBe(200);
    expect(ts.writes()[1]).toEqual([TS_BIN, 'serve', '--https=443', 'off']);
    expect(existsSync(join(config.dataDir, REMOTE_SERVE_FILE))).toBe(false);
    expect(RemoteActionResponse.parse(stop.body).status.serve).toBe('absent');
  });

  it('with remoteHost already loaded, start makes it ready at once', async () => {
    const ts = fakeTailscale();
    await start({ ts, config: { remoteHost: TS_NAME } });
    const body = RemoteActionResponse.parse((await call('POST', '/api/remote/start')).body);
    expect(body.status).toMatchObject({ ready: true, serveOwned: true, restartNeeded: false });
  });

  it('never stops a Serve someone else started', async () => {
    const ts = fakeTailscale();
    const { port } = await start({ ts, config: { remoteHost: TS_NAME } });
    ts.state.serve = forwarding(port);
    const res = await call('POST', '/api/remote/stop');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'remote_refused', reason: 'not_owned' });
    expect(ts.writes()).toEqual([]);
  });

  it('refuses, changing nothing: Tailscale off, 443 taken, Funnel on, remoteHost mismatch', async () => {
    const ts = fakeTailscale({ backendState: 'Stopped' });
    const { config } = await start({ ts, file: {} });
    const expectRefusal = async (reason: string) => {
      const res = await call('POST', '/api/remote/start');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false, reason });
      expect(String(res.body['message'])).not.toBe('');
    };
    await expectRefusal('not_running');
    ts.state.backendState = 'Running';
    ts.state.serve = forwarding(5173);
    await expectRefusal('port_443_taken');
    ts.state.serve = { AllowFunnel: { [`${TS_NAME}:443`]: true } };
    await expectRefusal('funnel_on');
    expect(ts.writes()).toEqual([]);
    expect(JSON.parse(readFileSync(config.configPath, 'utf8'))).toEqual({});

    writeFileSync(config.configPath, JSON.stringify({ remoteHost: 'other.tail1234.ts.net' }));
    ts.state.serve = {};
    await expectRefusal('remote_host_mismatch');
    expect(ts.writes()).toEqual([]);
  });

  it('a failing serve command is a refusal with its error, and records nothing', async () => {
    const ts = fakeTailscale({ failServe: true });
    const { config } = await start({ ts, config: { remoteHost: TS_NAME } });
    const res = await call('POST', '/api/remote/start');
    expect(res.status).toBe(409);
    expect(String(res.body['message'])).toContain('serve config denied');
    expect(existsSync(join(config.dataDir, REMOTE_SERVE_FILE))).toBe(false);
  });
});

describe('phone access review fixes (P9-16 review)', () => {
  it('B1: start and stop are refused to an agent’s or a run’s process; status is not guarded', async () => {
    const ts = fakeTailscale();
    let asked = 0;
    const peer: PeerCheck = async () => {
      asked += 1;
      return { refused: 'from an agent' };
    };
    await start({ ts, config: { remoteHost: TS_NAME }, peer });
    for (const action of ['start', 'stop']) {
      const res = await call('POST', `/api/remote/${action}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'agent_peer', message: 'from an agent' });
    }
    expect(asked).toBe(2);
    expect((await status()).tailscale).toBe('running');
    expect(asked).toBe(2);
    expect(ts.writes()).toEqual([]);
  });

  it('B1: a peer that cannot be identified (or a failing check) is allowed', async () => {
    const ts = fakeTailscale();
    let n = 0;
    const peer: PeerCheck = async () => {
      n += 1;
      if (n === 1) return { unknown: 'lsof is not available' };
      throw new Error('boom');
    };
    await start({ ts, config: { remoteHost: TS_NAME }, peer });
    expect((await call('POST', '/api/remote/start')).status).toBe(200);
    expect((await call('POST', '/api/remote/stop')).status).toBe(200);
    expect(ts.writes()).toHaveLength(2);
  });

  it('S2: with Funnel on, stop still turns off our Serve; the status says so loudly', async () => {
    const ts = fakeTailscale();
    const { config } = await start({ ts, config: { remoteHost: TS_NAME } });
    expect((await call('POST', '/api/remote/start')).status).toBe(200);
    ts.state.serve = { ...ts.state.serve, AllowFunnel: { [`${TS_NAME}:443`]: true } };
    const s = await status();
    expect(s).toMatchObject({
      serve: 'forwarding_to_us',
      funnel: true,
      serveOwned: true,
      ready: false,
      reason: 'funnel_on',
    });
    expect(s.message).toMatch(/WARNING.*public internet/);
    const stop = await call('POST', '/api/remote/stop');
    expect(stop.status).toBe(200);
    expect(ts.writes()[1]).toEqual([TS_BIN, 'serve', '--https=443', 'off']);
    expect(existsSync(join(config.dataDir, REMOTE_SERVE_FILE))).toBe(false);
  });

  it('S2: stop answers "already off" only when nothing is served on 443', async () => {
    const ts = fakeTailscale({ serve: forwarding(5173) });
    await start({ ts, config: { remoteHost: TS_NAME } });
    const taken = await call('POST', '/api/remote/stop');
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ reason: 'not_owned' });
    ts.state.backendState = 'Stopped';
    const unknown = await call('POST', '/api/remote/stop');
    expect(unknown.status).toBe(409);
    expect(unknown.body).toMatchObject({ reason: 'not_running' });
    ts.state.backendState = 'Running';
    ts.state.serve = {};
    const off = await call('POST', '/api/remote/stop');
    expect(off.status).toBe(200);
    expect(off.body['message']).toBe('Phone access is already off.');
    expect(ts.writes()).toEqual([]);
  });

  it('S2: a failing off command keeps the ownership record', async () => {
    const ts = fakeTailscale();
    const { config } = await start({ ts, config: { remoteHost: TS_NAME } });
    await call('POST', '/api/remote/start');
    ts.state.failServeOff = true;
    const res = await call('POST', '/api/remote/stop');
    expect(res.status).toBe(409);
    expect(existsSync(join(config.dataDir, REMOTE_SERVE_FILE))).toBe(true);
    expect((await status()).serveOwned).toBe(true);
  });

  it('S3: a stop from the user is remembered; the automatic start respects it until the user starts', async () => {
    const ts = fakeTailscale();
    const { config } = await start({ ts, config: { remoteHost: TS_NAME } });
    await call('POST', '/api/remote/start', {}, { auto: true });
    expect(ts.writes()).toHaveLength(1);
    expect((await call('POST', '/api/remote/stop')).status).toBe(200);
    expect(existsSync(join(config.dataDir, REMOTE_OFF_FILE))).toBe(true);
    expect(await status()).toMatchObject({ turnedOff: 'user', reason: 'serve_off' });

    const auto = await call('POST', '/api/remote/start', {}, { auto: true });
    expect(auto.status).toBe(409);
    expect(auto.body).toMatchObject({ reason: 'serve_off' });
    expect(ts.writes()).toHaveLength(2);

    const user = await call('POST', '/api/remote/start');
    expect(user.status).toBe(200);
    expect(ts.writes()).toHaveLength(3);
    expect(existsSync(join(config.dataDir, REMOTE_OFF_FILE))).toBe(false);
    expect((await status()).turnedOff).toBeUndefined();
  });

  it('S3/S6: a stop when the desktop app quits is not "turned off by the user"', async () => {
    const ts = fakeTailscale();
    const { config } = await start({ ts, config: { remoteHost: TS_NAME } });
    await call('POST', '/api/remote/start');
    const quit = await call('POST', '/api/remote/stop', {}, { by: 'app_quit' });
    expect(quit.status).toBe(200);
    expect(ts.state.serve).toEqual({});
    expect(existsSync(join(config.dataDir, REMOTE_OFF_FILE))).toBe(false);
    expect((await status()).turnedOff).toBeUndefined();
    expect((await call('POST', '/api/remote/start', {}, { auto: true })).status).toBe(200);
    expect((await call('POST', '/api/remote/stop', {}, { by: 'nobody' })).status).toBe(400);
  });

  it('S3/S5: our Serve turned off by hand is "turned off outside"; the record goes; no automatic restart', async () => {
    const ts = fakeTailscale();
    const { config, port } = await start({ ts, config: { remoteHost: TS_NAME } });
    await call('POST', '/api/remote/start', {}, { auto: true });
    expect(existsSync(join(config.dataDir, REMOTE_SERVE_FILE))).toBe(true);
    ts.state.serve = {}; // "tailscale serve --https=443 off" by hand
    const s = await status();
    expect(s).toMatchObject({
      serve: 'absent',
      turnedOff: 'outside',
      reason: 'turned_off_outside',
    });
    expect(s.message).toContain('outside GalacticAgents');
    expect(existsSync(join(config.dataDir, REMOTE_SERVE_FILE))).toBe(false);
    const auto = await call('POST', '/api/remote/start', {}, { auto: true });
    expect(auto.status).toBe(409);
    expect(auto.body).toMatchObject({ reason: 'turned_off_outside' });

    // Then `pnpm remote` serves the same port: not ours, so our stop leaves it on.
    ts.state.serve = forwarding(port);
    expect((await status()).serveOwned).toBe(false);
    const stop = await call('POST', '/api/remote/stop');
    expect(stop.status).toBe(409);
    expect(stop.body).toMatchObject({ reason: 'not_owned' });
    expect(ts.state.serve).toEqual(forwarding(port));
    expect(ts.writes()).toHaveLength(1);
  });
});
