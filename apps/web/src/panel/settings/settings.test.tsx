// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  type PreflightResponse,
  type ServerMessage,
  type SettingsPatch,
  type SettingsResponse,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../../App.js';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';

const TOKEN = 'tok-0123456789abcdefWXYZ';

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 1,
  agents: [fx.harmonizer],
  bodies: [fx.body],
  projects: [],
  tasks: [],
  questions: [],
  proposals: [],
  statuses: [{ ...fx.status, agentId: fx.harmonizer.id }],
};

const freshSettings = (): SettingsResponse => ({
  settings: {
    projectsRoot: '/Users/me/GalacticProjects',
    defaultPermissionPolicy: structuredClone(DEFAULT_PERMISSION_POLICY),
    retentionDays: 7,
    caps: {
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
      maxWallClockMs: 7_200_000,
      maxToolCalls: 500,
    },
    qualityTier: 'high',
    stewardsLoadUserSettings: true,
  },
  envOverrides: [],
  restartRequired: [],
});

const loggedOut: PreflightResponse = {
  ok: false,
  checkedAt: '2026-10-03T10:00:00.000Z',
  runtimes: [
    {
      runtime: 'claude-sdk',
      ok: false,
      installed: true,
      version: '2.1.0',
      sdkVersion: '0.2.0',
      loggedIn: false,
      problems: [
        {
          code: 'not_logged_in',
          severity: 'error',
          message: 'Claude Code is not logged in.',
          fix: 'run `claude` and log in with /login',
        },
      ],
    },
  ],
};
const ready: PreflightResponse = {
  ok: true,
  checkedAt: '2026-10-03T10:01:00.000Z',
  runtimes: [
    {
      runtime: 'claude-sdk',
      ok: true,
      installed: true,
      version: '2.1.0',
      sdkVersion: '0.2.0',
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      problems: [],
    },
  ],
};

type Refusal = { status: number; body: Record<string, unknown> };

/**
 * A stand-in Mission Control for the settings endpoints: it keeps the settings, applies a patch
 * like the server (or refuses it through `refuse`), and serves the preflight results in turn.
 */
function fakeServer(initial: SettingsResponse) {
  const state = { response: initial };
  const patches: SettingsPatch[] = [];
  const preflightCalls: string[] = [];
  let preflights: PreflightResponse[] = [ready];
  let refuse: (patch: SettingsPatch) => Refusal | undefined = () => undefined;
  /** Holds the settings read until it resolves (to a reply other than the settings, if given). */
  let readGate: Promise<Refusal | void> | undefined;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/settings' && (init?.method ?? 'GET') === 'GET') {
      const instead = readGate ? await readGate : undefined;
      return instead ? json(instead.body, instead.status) : json(state.response);
    }
    if (url === '/api/settings' && init?.method === 'PATCH') {
      const patch = JSON.parse(String(init.body)) as SettingsPatch;
      patches.push(patch);
      const refusal = refuse(patch);
      if (refusal) return json(refusal.body, refusal.status);
      const next = structuredClone(state.response);
      const { setupCompleted, defaultPermissionPolicy, caps, ...rest } = patch;
      Object.assign(next.settings, rest);
      if (caps) Object.assign(next.settings.caps, caps);
      if (defaultPermissionPolicy !== undefined)
        next.settings.defaultPermissionPolicy =
          defaultPermissionPolicy ?? structuredClone(DEFAULT_PERMISSION_POLICY);
      if (patch.projectsRoot !== undefined && !next.restartRequired.includes('projectsRoot'))
        next.restartRequired.push('projectsRoot');
      if (setupCompleted) next.setupCompletedAt ??= '2026-10-03T10:05:00.000Z';
      state.response = next;
      return json(next);
    }
    if (url.startsWith('/api/preflight')) {
      preflightCalls.push(url);
      const result = preflights.length > 1 ? preflights.shift()! : preflights[0]!;
      return json(result);
    }
    if (url.endsWith('/messages')) return json({ messages: [] });
    return json({});
  });
  return {
    state,
    patches,
    preflightCalls,
    fetchImpl,
    setPreflights: (list: PreflightResponse[]) => (preflights = list),
    setRefuse: (fn: typeof refuse) => (refuse = fn),
    setReadGate: (gate: Promise<Refusal | void>) => (readGate = gate),
  };
}

let server: ReturnType<typeof fakeServer>;

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', TOKEN);
  useAppStore.getState().reset();
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

async function open(
  path: string,
  initial: SettingsResponse,
  preflights?: PreflightResponse[],
  setup?: (s: ReturnType<typeof fakeServer>) => void,
) {
  server = fakeServer(initial);
  if (preflights) server.setPreflights(preflights);
  setup?.(server);
  vi.stubGlobal('fetch', server.fetchImpl);
  window.history.replaceState(null, '', path);
  render(<App />);
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(snapshot);
  });
}

const wizard = () => screen.getByRole('main', { name: 'first-run setup' });
const section = (name: string) => screen.getByRole('region', { name });
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe('first-run wizard (P25-08)', () => {
  it('walks a fresh install through the setup and lands in the panel', async () => {
    await open('/', freshSettings(), [loggedOut, ready]);
    await screen.findByRole('main', { name: 'first-run setup' });
    expect(screen.queryByRole('navigation', { name: 'navigation' })).toBeNull();

    // 1. Runtime check: the error with its fix, then a re-check that reruns it on the server.
    const check = section('Runtime check');
    await within(check).findByText(/Claude Code is not logged in/);
    expect(within(check).getByText(/log in with \/login/)).toBeTruthy();
    expect(within(wizard()).getByRole('button', { name: 'Continue anyway' })).toBeTruthy();
    await click(within(check).getByRole('button', { name: 'Check again' }));
    await within(check).findByText(/Agent SDK\) — ready/);
    expect(server.preflightCalls).toEqual(['/api/preflight', '/api/preflight?refresh=1']);
    expect(within(check).getByText('claude.ai · max')).toBeTruthy();
    await click(within(wizard()).getByRole('button', { name: 'Next' }));

    // 2. Projects root: refused on the client, then by the server, then saved.
    const root = within(section('Projects root')).getByLabelText('Projects root folder');
    type(root, 'relative/path');
    expect(within(section('Projects root')).getByRole('alert').textContent).toMatch(/absolute/);
    expect(
      (within(wizard()).getByRole('button', { name: 'Save and continue' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    server.setRefuse((p) =>
      p.projectsRoot === '/Users/me/.galactic/projects'
        ? {
            status: 400,
            body: {
              error: 'invalid',
              message: 'the projects root cannot be inside the data directory',
            },
          }
        : undefined,
    );
    type(root, '/Users/me/.galactic/projects');
    await click(within(wizard()).getByRole('button', { name: 'Save and continue' }));
    expect(within(section('Projects root')).getByRole('alert').textContent).toMatch(
      /Not accepted: the projects root cannot be inside the data directory/,
    );
    type(root, '~/Code/galactic');
    await click(within(wizard()).getByRole('button', { name: 'Save and continue' }));

    // 3. The default permission table (SPEC §3.6): push → deny.
    const policy = section('Default permission policy');
    type(within(policy).getByLabelText(/git push and anything/), 'deny');
    expect(within(policy).getByText('default: ask')).toBeTruthy();
    await click(within(wizard()).getByRole('button', { name: 'Save and continue' }));

    // 4–7. Retention, caps, tier, Stewards' sources: kept as they are (no patch).
    for (const title of [
      'Retention period',
      'Caps',
      'Rendering quality',
      'Stewards’ settings sources',
    ]) {
      expect(section(title)).toBeTruthy();
      await click(within(wizard()).getByRole('button', { name: 'Next' }));
    }

    // 8. Done: the marker is stamped and the panel opens on the Harmonizer.
    await click(within(wizard()).getByRole('button', { name: 'Open the panel' }));
    await screen.findByRole('navigation', { name: 'navigation' });
    expect(screen.queryByRole('main', { name: 'first-run setup' })).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(server.patches).toEqual([
      { projectsRoot: '/Users/me/.galactic/projects' },
      { projectsRoot: '~/Code/galactic' },
      {
        defaultPermissionPolicy: {
          rules: { ...DEFAULT_PERMISSION_POLICY.rules, push: 'deny' },
        },
      },
      { setupCompleted: true },
    ]);
  });

  it('can be skipped, which also counts as done', async () => {
    await open('/', freshSettings());
    await screen.findByRole('main', { name: 'first-run setup' });
    await click(screen.getByRole('button', { name: /Skip setup/ }));
    await screen.findByRole('navigation', { name: 'navigation' });
    expect(server.patches).toEqual([{ setupCompleted: true }]);
  });

  it('does not show once the setup is done, or when the server cannot say', async () => {
    await open('/', { ...freshSettings(), setupCompletedAt: '2026-10-01T00:00:00.000Z' });
    await waitFor(() =>
      expect(server.fetchImpl).toHaveBeenCalledWith('/api/settings', expect.anything()),
    );
    expect(screen.getByRole('navigation', { name: 'navigation' })).toBeTruthy();
    expect(screen.queryByRole('main', { name: 'first-run setup' })).toBeNull();
  });

  it('lets the user go on when the server refuses the marker (a remote client)', async () => {
    await open('/', freshSettings());
    server.setRefuse((p) =>
      p.setupCompleted
        ? {
            status: 403,
            body: {
              error: 'remote_settings',
              message: 'settings can be changed only on this machine',
            },
          }
        : undefined,
    );
    await screen.findByRole('main', { name: 'first-run setup' });
    await click(screen.getByRole('button', { name: /Skip setup/ }));
    // The skip failed: the wizard stays, and its last step offers a way on.
    for (let i = 0; i < 7; i++)
      await click(within(wizard()).getByRole('button', { name: /^(Next|Continue anyway)$/ }));
    await click(within(wizard()).getByRole('button', { name: 'Open the panel' }));
    expect(within(section('Done')).getByRole('alert').textContent).toMatch(
      /Only on the computer running Mission Control/,
    );
    await click(within(wizard()).getByRole('button', { name: /Continue without saving/ }));
    await screen.findByRole('navigation', { name: 'navigation' });
  });

  it('shows a failed skip at once, with the way on, on whatever step it happens', async () => {
    await open('/', freshSettings());
    server.setRefuse((p) =>
      p.setupCompleted
        ? { status: 500, body: { error: 'internal', message: 'disk full' } }
        : undefined,
    );
    await screen.findByRole('main', { name: 'first-run setup' });
    await click(screen.getByRole('button', { name: /Skip setup/ }));
    // Still on the first step: the refusal and the way on are next to the Skip button.
    expect(within(wizard()).getByRole('alert').textContent).toMatch(/Could not save \(500\)/);
    await click(within(wizard()).getByRole('button', { name: /Continue without saving/ }));
    await screen.findByRole('navigation', { name: 'navigation' });
  });

  it('is not offered to a client that may not finish it; a note says where to (decision 51)', async () => {
    await open('/', { ...freshSettings(), writable: 'limited' });
    await waitFor(() =>
      expect(server.fetchImpl).toHaveBeenCalledWith('/api/settings', expect.anything()),
    );
    const note = await screen.findByRole('note', { name: 'setup not finished' });
    expect(note.textContent).toMatch(
      /Setup is not finished — finish it on the computer running Mission Control/,
    );
    expect(screen.getByRole('navigation', { name: 'navigation' })).toBeTruthy();
    expect(screen.queryByRole('main', { name: 'first-run setup' })).toBeNull();
    await click(within(note).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('note', { name: 'setup not finished' })).toBeNull();
    expect(server.patches).toEqual([]);
  });

  it('shows neither panel nor wizard while the settings load, and the panel if the read fails', async () => {
    let answer!: (r: Refusal | void) => void;
    await open('/', freshSettings(), undefined, (s) =>
      s.setReadGate(new Promise((r) => (answer = r))),
    );
    expect(screen.queryByRole('navigation', { name: 'navigation' })).toBeNull();
    expect(screen.queryByRole('main', { name: 'first-run setup' })).toBeNull();
    await act(async () => answer({ status: 500, body: { error: 'internal' } }));
    await screen.findByRole('navigation', { name: 'navigation' });
    expect(screen.queryByRole('main', { name: 'first-run setup' })).toBeNull();
  });

  it('after the load, a fresh install gets the wizard without the panel showing first', async () => {
    let answer!: (r: Refusal | void) => void;
    await open('/', freshSettings(), undefined, (s) =>
      s.setReadGate(new Promise((r) => (answer = r))),
    );
    expect(screen.queryByRole('navigation', { name: 'navigation' })).toBeNull();
    await act(async () => answer());
    await screen.findByRole('main', { name: 'first-run setup' });
    expect(screen.queryByRole('navigation', { name: 'navigation' })).toBeNull();
  });
});

describe('settings page (P25-08)', () => {
  const done = (): SettingsResponse => ({
    ...freshSettings(),
    setupCompletedAt: '2026-10-01T00:00:00.000Z',
  });

  it('is reached from the top bar at /settings and back', async () => {
    await open('/', done());
    await click(screen.getByRole('link', { name: 'Settings' }));
    expect(window.location.pathname).toBe('/settings');
    await screen.findByRole('main', { name: 'settings' });
    // P25-07's desktop-notification toggles, mounted in the page.
    expect(
      within(section('Notifications')).getByRole('region', { name: 'desktop notifications' }),
    ).toBeTruthy();
    await click(screen.getByRole('link', { name: /Back to the panel/ }));
    expect(window.location.pathname).toBe('/');
    expect(screen.getByRole('navigation', { name: 'navigation' })).toBeTruthy();
  });

  it('shows env-fixed settings read-only and restart-only ones as "restart to apply"', async () => {
    await open('/settings', {
      ...done(),
      envOverrides: ['retentionDays'],
      restartRequired: ['stewardsLoadUserSettings'],
    });
    const retention = await screen.findByRole('region', { name: 'Retention period' });
    expect(
      (within(retention).getByLabelText('Keep finished work for') as HTMLInputElement).disabled,
    ).toBe(true);
    expect(within(retention).getByRole('note').textContent).toMatch(/GALACTIC_RETENTION_DAYS/);
    expect(within(retention).getByText('read-only')).toBeTruthy();

    const stewards = section('Stewards’ settings sources');
    expect(within(stewards).getByText('applies at the next start')).toBeTruthy();
    expect(within(stewards).getByRole('status').textContent).toMatch(
      /restart Mission Control to apply/,
    );

    // Saving the projects root: saved, applied at the next start.
    const root = section('Projects root');
    expect(within(root).getByText('applies at the next start')).toBeTruthy();
    type(within(root).getByLabelText('Projects root folder'), '/Users/me/Work');
    await click(within(root).getByRole('button', { name: 'Save projects root' }));
    expect(within(root).getByRole('status').textContent).toMatch(/restart Mission Control/);
  });

  it('validates on the client and shows each server refusal next to its setting', async () => {
    await open('/settings', done());
    const caps = await screen.findByRole('region', { name: 'Caps' });
    type(within(caps).getByLabelText('Stewards working at once'), '0');
    expect(within(caps).getByText('Whole number from 1 to 64.')).toBeTruthy();
    expect(
      (within(caps).getByRole('button', { name: 'Save caps' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    type(within(caps).getByLabelText('Stewards working at once'), '8');
    type(within(caps).getByLabelText('Wall-clock time per Steward'), '30');

    server.setRefuse((p) => {
      if (p.caps)
        return {
          status: 409,
          body: {
            error: 'env_override',
            message: 'set by an environment variable, so not editable here: caps',
          },
        };
      if (p.stewardsLoadUserSettings !== undefined)
        return {
          status: 403,
          body: {
            error: 'remote_settings',
            message: 'settings can be changed only on this machine',
          },
        };
      if (p.retentionDays !== undefined)
        return {
          status: 400,
          body: {
            error: 'invalid_body',
            issues: [{ path: ['retentionDays'], message: 'Too big: expected number to be <=3650' }],
          },
        };
      return undefined;
    });
    await click(within(caps).getByRole('button', { name: 'Save caps' }));
    // Only the caps that changed are sent.
    expect(server.patches.at(-1)).toEqual({
      caps: { maxConcurrentAgents: 8, maxWallClockMs: 1_800_000 },
    });
    expect(within(caps).getByRole('alert').textContent).toMatch(
      /Fixed by an environment variable: set by an environment variable/,
    );

    const stewards = section('Stewards’ settings sources');
    await click(within(stewards).getByRole('checkbox'));
    await click(within(stewards).getByRole('button', { name: /^Save/ }));
    expect(within(stewards).getByRole('alert').textContent).toMatch(
      /Only on the computer running Mission Control/,
    );

    const retention = section('Retention period');
    type(within(retention).getByLabelText('Keep finished work for'), '-1');
    expect(within(retention).getByRole('alert').textContent).toMatch(/more than 0/);
    type(within(retention).getByLabelText('Keep finished work for'), '30');
    await click(within(retention).getByRole('button', { name: 'Save retention period' }));
    expect(within(retention).getByRole('alert').textContent).toMatch(
      /Not accepted by the server — retentionDays: Too big/,
    );
  });

  it('saves an unrelated cap when the stored wall-clock cap is not a whole number of minutes', async () => {
    const stored = done();
    stored.settings.caps.maxWallClockMs = 90_000; // legal on the server: 1.5 min
    await open('/settings', stored);
    const caps = await screen.findByRole('region', { name: 'Caps' });
    expect(
      (within(caps).getByLabelText('Wall-clock time per Steward') as HTMLInputElement).value,
    ).toBe('1.5');
    type(within(caps).getByLabelText('Stewards working at once'), '8');
    expect(within(caps).queryByRole('alert')).toBeNull();
    await click(within(caps).getByRole('button', { name: 'Save caps' }));
    expect(server.patches).toEqual([{ caps: { maxConcurrentAgents: 8 } }]);
    expect(within(caps).getByRole('status').textContent).toBe('Saved.');
  });

  it('leaves transcript retention out for a server without it (P8-02)', async () => {
    await open('/settings', done());
    await screen.findByRole('region', { name: 'Caps' });
    expect(screen.queryByRole('region', { name: 'Transcript retention' })).toBeNull();
  });

  it('edits transcript retention: days, or empty to keep forever (P8-02)', async () => {
    const withRetention = done();
    withRetention.settings.transcriptRetention = { maxAgeDays: 90, archivedDays: 30 };
    await open('/settings', withRetention);
    const tr = await screen.findByRole('region', { name: 'Transcript retention' });
    const age = within(tr).getByLabelText('Remove agent output older than') as HTMLInputElement;
    const archived = within(tr).getByLabelText('Remove archived work’s output') as HTMLInputElement;
    expect([age.value, archived.value]).toEqual(['90', '30']);
    type(age, '0');
    expect(within(tr).getByRole('alert').textContent).toMatch(/whole number of days from 1/);
    type(age, '1.5');
    expect(within(tr).getByRole('alert').textContent).toMatch(/whole number of days from 1/);
    type(age, '30');
    type(archived, '0');
    expect(within(tr).getByRole('alert').textContent).toMatch(/whole number of days from 1/);
    type(age, ''); // keep forever
    type(archived, '7');
    await click(within(tr).getByRole('button', { name: 'Save transcript retention' }));
    expect(server.patches).toEqual([
      { transcriptRetention: { maxAgeDays: null, archivedDays: 7 } },
    ]);
    expect(within(tr).getByRole('status').textContent).toBe('Saved.');
  });

  it('saves the budget warning threshold on the settings page, not in the wizard (P8-01)', async () => {
    await open('/settings', done());
    const budgets = await screen.findByRole('region', { name: 'Budgets' });
    const input = within(budgets).getByLabelText('Warn when a budget is') as HTMLInputElement;
    expect(input.value).toBe('80');
    type(input, '101');
    expect(within(budgets).getByRole('alert').textContent).toMatch(/from 1 to 100/);
    type(input, '65');
    await click(within(budgets).getByRole('button', { name: /^Save/ }));
    expect(server.patches.at(-1)).toEqual({ budgets: { warnAtPercent: 65 } });
  });

  it('resets the default table to the §3.6 table', async () => {
    const custom = done();
    custom.settings.defaultPermissionPolicy.rules.network = 'allow';
    await open('/settings', custom);
    const policy = await screen.findByRole('region', { name: 'Default permission policy' });
    expect((within(policy).getByLabelText(/Network access/) as HTMLSelectElement).value).toBe(
      'allow',
    );
    await click(within(policy).getByRole('button', { name: 'Reset to the default table' }));
    expect(server.patches).toEqual([{ defaultPermissionPolicy: null }]);
    expect((within(policy).getByLabelText(/Network access/) as HTMLSelectElement).value).toBe(
      'ask',
    );
    expect(
      (
        within(policy).getByRole('button', {
          name: 'Reset to the default table',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('shows the runtime check with a re-check, and the token masked', async () => {
    await open('/settings', done(), [loggedOut]);
    const check = await screen.findByRole('region', { name: 'Runtime check' });
    await within(check).findByText(/2\.1\.0/);
    const access = section('Access');
    // Shown after its visible "Token" label, as plain code: no ARIA role or name on a `<code>`.
    const token = access.querySelector<HTMLElement>('code.set-token')!;
    expect(token.previousElementSibling?.textContent).toBe('Token');
    expect(token.getAttribute('role')).toBeNull();
    expect(token.getAttribute('aria-label')).toBeNull();
    expect(token.textContent).not.toContain(TOKEN);
    expect(token.textContent).toMatch(/WXYZ$/);
    await click(within(access).getByRole('button', { name: 'Reveal' }));
    expect(token.textContent).toBe(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    // No remote host configured: no QR code, a pointer to the setup instead.
    expect(within(access).queryByRole('img')).toBeNull();
    expect(within(access).getByText(/Phone access is not set up/)).toBeTruthy();
  });

  it('draws the phone QR code only after its own reveal, in the browser (P7-02)', async () => {
    const host = 'mymac.tail1234.ts.net';
    await open('/settings', { ...done(), remote: { host, tailscaleIdentity: false } });
    const access = section('Access');
    expect(within(access).queryByRole('img')).toBeNull();
    const fetchesBefore = server.fetchImpl.mock.calls.length;
    await click(within(access).getByRole('button', { name: 'Show the phone QR code' }));
    const qr = within(access).getByRole('img', {
      name: `QR code: the address https://${host} with the token`,
    });
    expect(qr.tagName.toLowerCase()).toBe('svg');
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    // Drawn here: nothing was fetched for it, and the token went into no URL or text node.
    expect(server.fetchImpl.mock.calls.length).toBe(fetchesBefore);
    expect(server.fetchImpl.mock.calls.map(([url]) => url).join(' ')).not.toContain(TOKEN);
    expect(access.textContent).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    await click(within(access).getByRole('button', { name: 'Hide the phone QR code' }));
    expect(within(access).queryByRole('img')).toBeNull();
  });
});

describe('token hand-over from the QR code (P7-02)', () => {
  it('takes the token from the fragment, connects with it and strips it from the URL', async () => {
    localStorage.setItem('galactic.token', 'an-old-token-0123456789');
    await open('/#token=from-the-qr-0123456789', freshSettings());
    expect(FakeWebSocket.instances[0]!.hello.token).toBe('from-the-qr-0123456789');
    expect(window.location.href).not.toContain('from-the-qr');
    expect(window.location.hash).toBe('');
    expect(localStorage.getItem('galactic.token')).toBe('from-the-qr-0123456789');
  });
});
