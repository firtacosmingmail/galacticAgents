import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthResponse, SettingsResponse } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { SettingsService } from '../config/settings.js';
import type { ServerConfig } from '../config/config.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import type { StewardProcessControl } from '../runtime/steward-processes.js';
import { connectWs, startTestApp, testConfig, TEST_TOKEN } from '../test/harness.js';

/**
 * Remote access through Tailscale Serve (P7-02; `docs/REMOTE_ACCESS.md`, TECHNOLOGY §8). Tailscale
 * is not installed where these run, so each test makes the requests Serve would make: a loopback
 * connection carrying the phone's `Host` (the `*.ts.net` name), `X-Forwarded-*` and, for a tailnet
 * user, `Tailscale-User-Login`. The manual check against a real tailnet is in
 * `docs/tasks/notes/P7-02-remote.md`.
 */

const TS_HOST = 'mymac.tail1234.ts.net';
const LOGIN = 'cosmin@example.com';
/** The headers Tailscale Serve adds when it forwards a tailnet user's request. */
const SERVE = {
  host: TS_HOST,
  'x-forwarded-for': '100.101.102.103',
  'x-forwarded-host': TS_HOST,
  'x-forwarded-proto': 'https',
};
const IDENTITY = { ...SERVE, 'tailscale-user-login': LOGIN, 'tailscale-user-name': 'Cosmin' };
const BEARER = { authorization: `Bearer ${TEST_TOKEN}` };
/** What a browser sends when the page itself fetches `/health`. */
const PAGE = { 'sec-fetch-site': 'same-origin' };

let composed: ComposedRuntime | undefined;
let t: Awaited<ReturnType<typeof startTestApp>> | undefined;
let logged = '';

const stops: string[] = [];
const restarts = vi.fn(() => Promise.resolve({ agentId: 'a-hq-2' }));
const processes: StewardProcessControl = {
  list: (agentId) => Promise.resolve({ agentId, supported: true, processes: [] }),
  listMany: (ids) => Promise.all(ids.map((id) => processes.list(id))),
  stop: (agentId, opts) => {
    stops.push(agentId);
    return Promise.resolve({ agentId, stopped: opts.pids ?? [], forced: [], alive: [] });
  },
};

/**
 * A server configured for remote access as `docs/REMOTE_ACCESS.md` says: the exact Serve name, no
 * wildcard, and identity headers only when a test opts in.
 */
async function start(overrides: Partial<ServerConfig> = {}) {
  stops.length = 0;
  restarts.mockClear();
  logged = '';
  composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 1 })],
    flushMs: 10,
  });
  const config = testConfig({
    allowedHosts: ['localhost', '127.0.0.1', '[::1]', TS_HOST],
    remoteHost: TS_HOST,
    ...overrides,
  });
  t = await startTestApp({
    config,
    log: composed.log,
    statuses: composed.statuses,
    transcripts: composed.transcripts,
    runtime: composed.runtime,
    commands: composed.commands,
    processes,
    restartHarmonizer: restarts,
    settings: new SettingsService({
      config,
      caps: composed.runtime.caps,
      ...(composed.archival ? { archival: composed.archival } : {}),
    }),
    // Every line Fastify logs, to check the token never appears in one.
    logger: { level: 'trace', stream: { write: (line: string) => void (logged += line) } },
  });
  return t;
}

afterEach(async () => {
  await composed?.dispose();
  await t?.stop();
  composed = undefined;
  t = undefined;
});

const inject = (
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
) =>
  t!.app.fastify.inject({
    method,
    url,
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

const WITH_IDENTITY = { tailscaleIdentityLogins: [LOGIN] };

describe('the Host allow-list (P7-02)', () => {
  it('accepts the configured Serve name and refuses any other ts.net host', async () => {
    await start();
    expect((await inject('GET', '/health', SERVE)).statusCode).toBe(200);
    expect((await inject('GET', '/health', { host: `${TS_HOST}:443` })).statusCode).toBe(200);
    for (const host of ['othermac.tail1234.ts.net', 'evil.ts.net', 'ts.net', 'evil.example.com']) {
      const res = await inject('GET', '/health', { ...SERVE, host });
      expect(res.statusCode, host).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_host' });
    }
    // The WebSocket upgrade too, Host and Origin.
    const bad = await connectWs(t!.wsUrl, { headers: { host: 'othermac.tail1234.ts.net' } });
    expect(bad.error).toBe('http 403');
    const foreign = await connectWs(t!.wsUrl, {
      headers: { host: TS_HOST },
      origin: 'https://othermac.tail1234.ts.net',
    });
    expect(foreign.error).toBe('http 403');
  });

  it('opens a session for the phone with the token through Serve', async () => {
    await start();
    const out = await connectWs(t!.wsUrl, {
      headers: SERVE,
      origin: `https://${TS_HOST}`,
      send: [{ type: 'hello', token: TEST_TOKEN }],
      until: (m) => m.some((x) => x.type === 'snapshot'),
    });
    expect(out.messages.map((m) => m.type)).toContain('snapshot');
  });
});

describe('/health through Serve', () => {
  it('flags the request remote and never hands out the token', async () => {
    await start();
    const local = (await inject('GET', '/health', PAGE)).json() as HealthResponse;
    expect(local.origin).toBe('local');
    expect(local.token).toBe(TEST_TOKEN);

    const remote = (await inject('GET', '/health', { ...SERVE, ...PAGE })).json() as HealthResponse;
    expect(remote.origin).toBe('remote');
    expect(remote.token).toBeUndefined();
    expect(remote.identity).toBeUndefined();
    // Any one Serve header is enough: a Tailscale header of any name, or the Host alone.
    for (const headers of [
      { 'tailscale-app-capabilities': '{}' },
      { 'x-forwarded-port': '443' },
      { via: '1.1 proxy' },
      { host: TS_HOST },
    ]) {
      const body = (
        await inject('GET', '/health', { ...PAGE, ...headers })
      ).json() as HealthResponse;
      expect(body.origin, JSON.stringify(headers)).toBe('remote');
      expect(body.token, JSON.stringify(headers)).toBeUndefined();
    }
  });

  it('names the accepted identity, still without the token', async () => {
    await start(WITH_IDENTITY);
    const body = (
      await inject('GET', '/health', { ...IDENTITY, ...PAGE })
    ).json() as HealthResponse;
    expect(body).toMatchObject({ origin: 'remote', identity: LOGIN });
    expect(body.token).toBeUndefined();
  });
});

describe('Tailscale identity headers as the credential (P7-02)', () => {
  it('are ignored unless the opt-in is configured: a spoofed login gets 401', async () => {
    await start();
    expect((await inject('GET', '/api/runtimes', IDENTITY)).statusCode).toBe(401);
    expect((await inject('GET', '/api/settings', IDENTITY)).statusCode).toBe(401);
    expect((await inject('GET', '/api/runtimes', { ...IDENTITY, ...BEARER })).statusCode).toBe(200);
    const ws = await connectWs(t!.wsUrl, {
      headers: IDENTITY,
      send: [{ type: 'hello', token: 'not-the-token' }],
    });
    expect(ws.closeCode).toBe(4401);
  });

  it('are accepted with the opt-in, for a listed login under the Serve name only', async () => {
    await start(WITH_IDENTITY);
    expect((await inject('GET', '/api/runtimes', IDENTITY)).statusCode).toBe(200);
    // Logins compare case-insensitively.
    expect(
      (
        await inject('GET', '/api/runtimes', {
          ...IDENTITY,
          'tailscale-user-login': 'Cosmin@Example.COM',
        })
      ).statusCode,
    ).toBe(200);
    const refused: Record<string, string>[] = [
      { ...IDENTITY, 'tailscale-user-login': 'someone-else@example.com' },
      // A local page or process naming localhost: identity is read only under the Serve name.
      { ...IDENTITY, host: '127.0.0.1:4321' },
      { ...IDENTITY, host: 'localhost' },
      // A foreign or plain-http Origin.
      { ...IDENTITY, origin: 'https://evil.example.com' },
      { ...IDENTITY, origin: `http://${TS_HOST}` },
      // Two logins joined into one header.
      { ...IDENTITY, 'tailscale-user-login': `${LOGIN}, other@example.com` },
    ];
    for (const headers of refused) {
      const res = await inject('GET', '/api/runtimes', headers);
      expect([401, 403], JSON.stringify(headers)).toContain(res.statusCode);
    }
  });

  it('are never read from a connection that is not loopback', async () => {
    await start(WITH_IDENTITY);
    const res = await t!.app.fastify.inject({
      method: 'GET',
      url: '/api/runtimes',
      headers: IDENTITY,
      remoteAddress: '100.101.102.103',
    });
    expect(res.statusCode).toBe(401);
  });

  it('open a WebSocket session without the token, and only for a listed login', async () => {
    await start(WITH_IDENTITY);
    const ok = await connectWs(t!.wsUrl, {
      headers: IDENTITY,
      origin: `https://${TS_HOST}`,
      send: [{ type: 'hello', token: 'tailscale-identity' }],
      until: (m) => m.some((x) => x.type === 'snapshot'),
    });
    expect(ok.messages.map((m) => m.type)).toContain('snapshot');
    const other = await connectWs(t!.wsUrl, {
      headers: { ...IDENTITY, 'tailscale-user-login': 'mallory@example.com' },
      send: [{ type: 'hello', token: 'tailscale-identity' }],
    });
    expect(other.closeCode).toBe(4401);
  });

  it('are reported by the settings, which never carry the token', async () => {
    await start(WITH_IDENTITY);
    const res = await inject('GET', '/api/settings', BEARER);
    const body = res.json() as SettingsResponse;
    expect(body.remote).toEqual({ host: TS_HOST, tailscaleIdentity: true });
    expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
  });
});

const SPAWN = { runtime: 'fake', prompt: 'scenario:echo', cwd: '/tmp', policy: 'trusted' };

describe('what a remote client may do (P7-02; SPEC decision 90)', () => {
  it("refuses a remote free-form spawn, a stop of a Steward's processes and a Harmonizer restart", async () => {
    await start(WITH_IDENTITY);
    for (const headers of [{ ...SERVE, ...BEARER }, IDENTITY]) {
      const spawn = await inject('POST', '/api/agents', headers, SPAWN);
      expect(spawn.statusCode).toBe(403);
      expect(spawn.json()).toMatchObject({ error: 'remote_control' });
      expect(composed!.runtime.liveAgents()).toHaveLength(0);
      // Recover is like resume: open to the phone (404 here: no such agent, not a refusal).
      const recover = await inject('POST', '/api/agents/a-none/recover', headers);
      expect(recover.statusCode).toBe(404);
      const stop = await inject('POST', '/api/agents/a-st/processes/stop', headers, {});
      expect(stop.statusCode).toBe(403);
      expect(stop.json()).toMatchObject({ error: 'remote_control' });
      const restart = await inject('POST', '/api/harmonizer/restart', headers);
      expect(restart.statusCode).toBe(403);
      expect(restart.json()).toMatchObject({ error: 'remote_control' });
      // Listing the processes stays open.
      expect((await inject('GET', '/api/agents/a-st/processes', headers)).statusCode).toBe(200);
    }
    expect(stops).toEqual([]);
    expect(restarts).not.toHaveBeenCalled();
    // The local page may.
    expect((await inject('POST', '/api/agents/a-st/processes/stop', BEARER, {})).statusCode).toBe(
      200,
    );
    expect((await inject('POST', '/api/harmonizer/restart', BEARER)).statusCode).toBe(200);
    expect(stops).toEqual(['a-st']);
    expect(restarts).toHaveBeenCalledTimes(1);
  });

  it('allows both when the server trusts remote clients (autoApproveRemote)', async () => {
    await start({ autoApproveRemote: true });
    const headers = { ...SERVE, ...BEARER };
    expect((await inject('POST', '/api/agents/a-st/processes/stop', headers, {})).statusCode).toBe(
      200,
    );
    expect((await inject('POST', '/api/harmonizer/restart', headers)).statusCode).toBe(200);
    const spawn = await inject('POST', '/api/agents', headers, SPAWN);
    expect(spawn.statusCode).toBe(201);
    await inject(
      'POST',
      `/api/agents/${(spawn.json() as { agentId: string }).agentId}/stop`,
      BEARER,
    );
  });
});

describe("a remote client's permission requests are never auto-approved (P7-02 acceptance)", () => {
  const waitFor = (pred: () => boolean, what: string, ms = 3_000) =>
    new Promise<void>((resolve, reject) => {
      const t0 = Date.now();
      const tick = () =>
        pred()
          ? resolve()
          : Date.now() - t0 > ms
            ? reject(new Error(`timeout: ${what}`))
            : setTimeout(tick, 10);
      tick();
    });
  /** Spawns the fake `permission` scenario (an `rm -rf`) under the `trusted` preset. */
  const spawnTrusted = (headers: Record<string, string>) =>
    inject('POST', '/api/agents', headers, {
      runtime: 'fake',
      prompt: 'scenario:permission',
      cwd: '/tmp',
      policy: 'trusted',
    });

  it('the phone can neither start a free-form agent nor loosen a project policy', async () => {
    await start(WITH_IDENTITY);
    const project = (await composed!.commands.createProject({ name: 'CSV', workspace: '/tmp' }))
      .value;
    for (const headers of [IDENTITY, { ...SERVE, ...BEARER }]) {
      expect((await spawnTrusted(headers)).statusCode).toBe(403);
      // The work it can start (a project, through a card or an edit) is floored at the default.
      const edit = await inject('POST', '/api/control', headers, {
        target: { kind: 'project', id: project.id },
        action: {
          action: 'edit',
          changes: { permissionPolicy: { rules: { destructive: 'allow' }, unclassified: 'allow' } },
        },
      });
      expect(edit.statusCode).toBe(200);
      const policy = composed!.log.tables.projects.get(project.id)?.permissionPolicy;
      expect(policy?.rules['destructive']).toBe('ask');
      expect(policy?.unclassified ?? 'ask').toBe('ask');
    }
    expect(composed!.runtime.liveAgents()).toHaveLength(0);
  });

  it('while the same spawn from the local page runs the call on its own', async () => {
    await start();
    const res = await spawnTrusted(BEARER);
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { agentId: string }).agentId;
    await waitFor(
      () =>
        composed!.log
          .eventsSince(0)
          .some(
            (e) =>
              e.event.type === 'agent.tool_call' &&
              e.event.agentId === id &&
              JSON.stringify(e.event.input).includes('rm -rf'),
          ),
      'the rm -rf ran',
    );
    expect(composed!.log.tables.questions.all().filter((q) => q.originAgentId === id)).toEqual([]);
  });
});

describe('the token never reaches a log line (P7-02)', () => {
  it('through requests, refusals and sessions, local and remote', async () => {
    await start(WITH_IDENTITY);
    await inject('GET', '/health', PAGE);
    await inject('GET', '/health', { ...SERVE, ...PAGE });
    await inject('GET', '/api/runtimes', BEARER);
    await inject('GET', '/api/runtimes', { authorization: `Bearer ${TEST_TOKEN}x` });
    await inject('GET', '/api/settings', { ...SERVE, ...BEARER });
    await inject('GET', '/api/runtimes', { ...IDENTITY, 'tailscale-user-login': 'x@example.com' });
    await connectWs(t!.wsUrl, {
      headers: SERVE,
      send: [{ type: 'hello', token: TEST_TOKEN }],
      until: (m) => m.some((x) => x.type === 'snapshot'),
    });
    await connectWs(t!.wsUrl, { send: [{ type: 'hello', token: `${TEST_TOKEN}-wrong` }] });
    // A URL with the token in it is the one thing that would be logged: the QR code puts it in
    // the fragment, which a browser never sends.
    await inject('GET', `/api/runtimes`, { ...BEARER });
    await new Promise((r) => setTimeout(r, 50));
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).toContain('/api/runtimes');
    expect(logged).not.toContain(TEST_TOKEN);
    expect(logged).not.toContain(LOGIN);
  });
});
