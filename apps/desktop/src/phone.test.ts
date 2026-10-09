import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RemoteStatus } from '@galactic/protocol';
import type { PhoneLine, ServerInfo, ShellLine } from './lines.js';
import { parseCommand } from './lines.js';
import {
  desktopSettingsPath,
  PhoneAccess,
  phoneView,
  readDesktopSettings,
  writeDesktopSettings,
} from './phone.js';

const NAME = 'mymac.tail1234.ts.net';
const OWNED: ServerInfo = { url: 'http://127.0.0.1:4400', port: 4400, owned: true, pid: 9 };
const ATTACHED: ServerInfo = { url: 'http://127.0.0.1:4321', port: 4321, owned: false, pid: 7 };

function status(over: Partial<RemoteStatus> = {}): RemoteStatus {
  return {
    tailscale: 'running',
    name: NAME,
    url: `https://${NAME}`,
    remoteHost: { state: 'matches', value: NAME },
    serve: 'forwarding_to_us',
    serveOwned: true,
    ready: true,
    restartNeeded: false,
    remoteClients: { connected: 0 },
    checkedAt: '2026-10-09T10:00:00.000Z',
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const settingsFile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'galactic-desktop-'));
  dirs.push(dir);
  return join(dir, 'settings.json');
};

/**
 * A fake Mission Control's phone routes: the status as the test sets it; start turns an absent
 * Serve on (owned), stop turns an owned one off and refuses someone else's.
 */
function fakeMissionControl(initial: RemoteStatus) {
  const state = { status: initial, requests: [] as string[], fail404: false };
  const json = (code: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status: code,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    state.requests.push(`${method} ${path}`);
    expect((init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    if (state.fail404) return json(404, { error: 'not_found' });
    const s = state.status;
    if (path === '/api/remote/status') return json(200, s);
    if (path === '/api/remote/start') {
      if (s.tailscale !== 'running') {
        return json(409, { ok: false, error: 'remote_refused', reason: 'not_running', status: s });
      }
      state.status = status({
        remoteHost: { state: 'matches', value: NAME },
        restartNeeded: s.remoteHost.state === 'missing',
        ready: s.remoteHost.state !== 'missing',
        ...(s.remoteHost.state === 'missing' ? { reason: 'restart_needed' as const } : {}),
      });
      return json(200, { ok: true, status: state.status });
    }
    if (path === '/api/remote/stop') {
      if (s.serve === 'forwarding_to_us' && !s.serveOwned) {
        return json(409, { ok: false, error: 'remote_refused', reason: 'not_owned', status: s });
      }
      state.status = status({
        serve: 'absent',
        serveOwned: false,
        ready: false,
        reason: 'serve_off',
      });
      return json(200, { ok: true, status: state.status });
    }
    return json(404, {});
  }) as typeof fetch;
  return { state, fetch: fetchImpl };
}

function phoneFor(mc: ReturnType<typeof fakeMissionControl>, path = settingsFile()) {
  const lines: ShellLine[] = [];
  const phone = new PhoneAccess({
    settingsPath: path,
    token: () => 'tok',
    emit: (l) => lines.push(l),
    log: () => {},
    fetch: mc.fetch,
    intervalMs: 3_600_000,
  });
  const last = (): PhoneLine | undefined =>
    [...lines].reverse().flatMap((l) => (l.type === 'phone' ? [l.phone] : []))[0];
  return { phone, lines, last, path };
}

describe('phoneView (P9-16)', () => {
  it('says the address when the phone can reach Mission Control, with the phones connected', () => {
    expect(phoneView({ on: true, server: OWNED, status: status() })).toEqual({
      on: true,
      label: `Phone: https://${NAME}`,
      url: `https://${NAME}`,
    });
    expect(
      phoneView({
        on: true,
        server: OWNED,
        status: status({ remoteClients: { connected: 2 } }),
      }).label,
    ).toBe(`Phone: https://${NAME} · 2 connected`);
  });

  it('says why not, in a few words', () => {
    const off = (over: Partial<RemoteStatus>) =>
      phoneView({ on: true, server: ATTACHED, status: status({ ready: false, ...over }) }).label;
    expect(off({ tailscale: 'stopped', reason: 'not_running' })).toBe(
      'Phone: off — Tailscale not running',
    );
    expect(off({ tailscale: 'needs_login', reason: 'needs_login' })).toBe(
      'Phone: off — Tailscale not signed in',
    );
    expect(off({ reason: 'no_magicdns' })).toBe('Phone: off — no MagicDNS name');
    expect(off({ reason: 'port_443_taken' })).toBe('Phone: off — port 443 is taken');
    expect(off({ reason: 'funnel_on' })).toBe('Phone: off — Tailscale Funnel is on');
    expect(off({ reason: 'not_installed' })).toBe('Phone: off — Tailscale not installed');
  });

  it('a restart finishes it: the attached server is restarted, the app’s own reopened', () => {
    const s = status({ ready: false, restartNeeded: true, reason: 'restart_needed' });
    expect(phoneView({ on: true, server: ATTACHED, status: s }).label).toBe(
      'Phone: restart Mission Control to finish',
    );
    expect(phoneView({ on: true, server: OWNED, status: s }).label).toBe(
      'Phone: quit and reopen GalacticAgents to finish',
    );
  });

  it('off, waiting, unreadable', () => {
    expect(phoneView({ on: false, server: OWNED, status: status({ ready: false }) }).label).toBe(
      'Phone: off',
    );
    expect(phoneView({ on: true, server: undefined, status: undefined }).label).toBe(
      'Phone: waiting for Mission Control',
    );
    expect(
      phoneView({ on: true, server: OWNED, status: undefined, error: 'update Mission Control' })
        .label,
    ).toBe('Phone: off — update Mission Control');
  });
});

describe('the app’s settings', () => {
  it('phone access is on unless turned off, and is kept in the app’s own file', () => {
    const path = settingsFile();
    expect(readDesktopSettings(path)).toEqual({ phoneAccess: true });
    writeDesktopSettings(path, { phoneAccess: false });
    expect(readDesktopSettings(path)).toEqual({ phoneAccess: false });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ phoneAccess: false });
    expect(desktopSettingsPath({ GALACTIC_DESKTOP_SETTINGS: '/x/s.json' })).toBe('/x/s.json');
    expect(desktopSettingsPath({})).toMatch(/dev\.galacticagents\.desktop\/settings\.json$/);
  });

  it('the menu’s switch arrives as phone:on / phone:off', () => {
    expect(parseCommand('phone:on')).toBe('phone:on');
    expect(parseCommand('phone:off')).toBe('phone:off');
    expect(parseCommand('phone:maybe')).toBeUndefined();
  });
});

describe('PhoneAccess (P9-16)', () => {
  it('on: starts Serve through Mission Control when it forwards nothing', async () => {
    const mc = fakeMissionControl(status({ serve: 'absent', ready: false, reason: 'serve_off' }));
    const p = phoneFor(mc);
    p.phone.setServer(OWNED);
    await p.phone.check();
    expect(mc.state.requests).toEqual([
      'GET /api/remote/status',
      'POST /api/remote/start',
    ]);
    expect(p.last()).toEqual({ on: true, label: `Phone: https://${NAME}`, url: `https://${NAME}` });
    p.phone.stop();
  });

  it('on, attached to a server without remoteHost: started, and the menu asks for a restart', async () => {
    const mc = fakeMissionControl(
      status({ serve: 'absent', ready: false, reason: 'serve_off', remoteHost: { state: 'missing' } }),
    );
    const p = phoneFor(mc);
    p.phone.setServer(ATTACHED);
    await p.phone.check();
    expect(mc.state.requests).toContain('POST /api/remote/start');
    expect(p.last()?.label).toBe('Phone: restart Mission Control to finish');
    p.phone.stop();
  });

  it('on, Tailscale off: nothing is started, the menu says why', async () => {
    const mc = fakeMissionControl(
      status({ tailscale: 'stopped', serve: 'unknown', ready: false, reason: 'not_running' }),
    );
    const p = phoneFor(mc);
    p.phone.setServer(OWNED);
    await p.phone.check();
    expect(mc.state.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    expect(p.last()?.label).toBe('Phone: off — Tailscale not running');
    p.phone.stop();
  });

  it('already forwarding: nothing to do', async () => {
    const mc = fakeMissionControl(status({ serveOwned: false }));
    const p = phoneFor(mc);
    p.phone.setServer(ATTACHED);
    await p.phone.check();
    expect(mc.state.requests.filter((r) => r.startsWith('POST'))).toEqual([]);
    p.phone.stop();
  });

  it('turned off: Serve is stopped when the app started it, and the switch is remembered', async () => {
    const mc = fakeMissionControl(status());
    const p = phoneFor(mc);
    p.phone.setServer(OWNED);
    await p.phone.check();
    await p.phone.setOn(false);
    expect(mc.state.requests).toContain('POST /api/remote/stop');
    expect(p.last()).toEqual({ on: false, label: 'Phone: off' });
    expect(readDesktopSettings(p.path)).toEqual({ phoneAccess: false });
    // Off stays off: a later check starts nothing.
    await p.phone.check();
    expect(mc.state.requests.filter((r) => r === 'POST /api/remote/start')).toEqual([]);
    p.phone.stop();
  });

  it('turned off: someone else’s Serve is left on, and the menu says so', async () => {
    const mc = fakeMissionControl(status({ serveOwned: false }));
    const p = phoneFor(mc);
    p.phone.setServer(ATTACHED);
    await p.phone.check();
    await p.phone.setOn(false);
    expect(mc.state.status.serve).toBe('forwarding_to_us');
    expect(p.last()?.label).toBe(`Phone: https://${NAME} (Serve set up elsewhere)`);
    p.phone.stop();
  });

  it('an older Mission Control without the routes is said, not retried as an error', async () => {
    const mc = fakeMissionControl(status());
    mc.state.fail404 = true;
    const p = phoneFor(mc);
    p.phone.setServer(ATTACHED);
    await p.phone.check();
    expect(p.last()?.label).toBe('Phone: off — update Mission Control (no phone access routes)');
    p.phone.stop();
  });

  it('no server: waiting; turned on again with a server, it looks at once', async () => {
    const mc = fakeMissionControl(status({ serve: 'absent', ready: false, reason: 'serve_off' }));
    const path = settingsFile();
    writeDesktopSettings(path, { phoneAccess: false });
    const p = phoneFor(mc, path);
    p.phone.setServer(undefined);
    expect(p.last()).toEqual({ on: false, label: 'Phone: off' });
    p.phone.setServer(OWNED);
    await p.phone.check();
    expect(mc.state.requests).not.toContain('POST /api/remote/start');
    await p.phone.setOn(true);
    expect(mc.state.requests).toContain('POST /api/remote/start');
    expect(p.last()?.on).toBe(true);
    p.phone.stop();
  });
});
