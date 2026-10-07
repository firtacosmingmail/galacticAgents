// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Deliverable,
  DeliverableListItem,
  DeliverablesResponse,
  Project,
  Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { createApi } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { applySnapshot } from '../../state/reduce.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking, type AxeFinding } from '../../a11y/a11y-fixtures.js';
import { clientRules, type ClientRules } from './deliverables-model.js';
import { HistoryDeliverables, ProjectDeliverables, TaskDeliverables } from './DeliverablesList.js';
import { RulesContext, useDeliverablesFocus } from './use-deliverables.js';

/**
 * P9-09 — the deliverables views against a mocked server: every kind and its actions, the
 * application's confirmation, a stale edit, the phone's and the desktop app's rules, the viewer's
 * XSS cases (a `<script>` in a source file, raw HTML and `javascript:` links in Markdown, an SVG
 * with a script — none ever runs: no script element or handler is created) and axe.
 */

const WS = fx.project.workspace;
const NOW = '2026-10-08T10:00:00.000Z';
const at = (m: number) => `2026-10-08T10:${String(m).padStart(2, '0')}:00.000Z`;

const MAC = clientRules({ loopback: true, desktop: false, writable: 'all' });
const PHONE = clientRules({ loopback: false, desktop: false, writable: 'limited' });
const PHONE_AUTO = clientRules({ loopback: false, desktop: false, writable: 'all' });
const DESKTOP = clientRules({ loopback: true, desktop: true, writable: 'all' });

const steward: Agent = { ...fx.agent, id: 'a-steward-1', taskId: 't-1' };
const newTask: Task = {
  ...fx.task,
  id: 't-9',
  description: 'Draw the login screen',
  createdAt: at(30),
  worktreePath: `${WS}/.galactic/worktrees/t-9`,
};
const subProject: Project = {
  ...fx.project,
  id: 'p-sub',
  name: 'Admin console',
  parentProjectId: 'p-1',
  createdAt: at(5),
};

function item(over: Partial<DeliverableListItem> & Pick<DeliverableListItem, 'id'>) {
  return {
    projectId: 'p-1',
    kind: 'file',
    title: over.id,
    source: 'user',
    addedBy: { type: 'user' },
    location: { storage: 'in_place', path: `${WS}/${over.id}` },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    facts: { exists: true, size: 120, kindGuess: 'text', contentType: 'text/plain; charset=utf-8' },
    ...over,
  } as DeliverableListItem;
}

const folder = item({
  id: 'd-folder',
  kind: 'folder',
  title: 'Project folder',
  source: 'detected',
  addedBy: { type: 'system' },
  detectedKey: 'folder',
  location: { storage: 'in_place', path: WS },
  facts: { exists: true, isDirectory: true, kindGuess: 'folder' },
});
const dev = item({
  id: 'd-dev',
  kind: 'command',
  title: 'dev',
  source: 'detected',
  addedBy: { type: 'system' },
  location: undefined,
  facts: undefined,
  command: { line: 'pnpm run dev', cwd: WS, detectedFrom: 'package.json' },
  detectedKey: 'package.json#dev',
  meta: { important: 0 },
  lastRun: { runId: 'r-1', state: 'running', startedAt: NOW, ports: [5173] },
});
const notes = item({
  id: 'd-notes',
  title: 'Release notes',
  location: { storage: 'in_place', path: `${WS}/NOTES.md` },
});
const shot = item({
  id: 'd-shot',
  taskId: 't-9',
  kind: 'image',
  title: 'Login screenshot',
  source: 'agent',
  addedBy: { type: 'agent', id: 'a-steward-1' },
  location: {
    storage: 'copy',
    path: `${WS}/deliverables/login/shot.svg`,
    originalPath: '/tmp/x/shot.svg',
  },
  facts: { exists: true, size: 900, kindGuess: 'image', contentType: 'image/svg+xml' },
  meta: {
    copy: {
      bytes: 900,
      skipped: [
        { path: '.env', reason: 'secret' },
        { path: 'cache', reason: 'symlink' },
      ],
      skippedCount: 2,
    },
  },
});
const app = item({
  id: 'd-app',
  taskId: 't-1',
  kind: 'app',
  title: 'Demo.app',
  source: 'agent',
  addedBy: { type: 'agent', id: 'a-steward-1' },
  location: { storage: 'in_place', path: `${WS}/build/Demo.app` },
  facts: { exists: true, isDirectory: true, runsCode: true },
});
const site = item({
  id: 'd-site',
  kind: 'url',
  title: 'Staging',
  location: undefined,
  facts: undefined,
  url: 'https://staging.example.com/',
});
const gone = item({
  id: 'd-gone',
  taskId: 't-1',
  title: 'Coverage report',
  facts: { exists: false, problem: 'missing' },
});
const removed = item({
  id: 'd-removed',
  title: 'Scratch log',
  removedAt: at(40),
  removedBy: { type: 'user' },
  removedReason: 'not needed',
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}
let calls: Call[];
let routes: (method: string, path: string, body: unknown) => Response | undefined;
let listed: DeliverableListItem[];
let folderPath: string | undefined;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function fetchMock() {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const url = new URL(input, 'http://localhost');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) });
    const special = routes(method, url.pathname, body);
    if (special) return special;
    if (url.pathname === '/api/deliverables' && method === 'GET') {
      const removedToo = url.searchParams.get('removed') === '1';
      const project = url.searchParams.get('projectId');
      const task = url.searchParams.get('taskId');
      const rows = listed.filter(
        (d) =>
          (removedToo || d.removedAt === undefined) &&
          (task ? d.taskId === task : d.projectId === project),
      );
      return json({
        deliverables: rows,
        ...(folderPath && project === 'p-1' ? { folder: folderPath } : {}),
      } satisfies DeliverablesResponse);
    }
    if (url.pathname === '/api/ide') {
      return json({
        supported: true,
        installed: [],
        setting: 'auto',
        effective: {
          bundleId: 'com.jetbrains.WebStorm',
          name: 'WebStorm',
          path: '/Applications/WebStorm.app',
        },
      });
    }
    if (url.pathname === '/api/deliverables/usage') {
      return json({
        folders: folderPath ? [{ projectId: 'p-1', path: folderPath, bytes: 3_500_000 }] : [],
      });
    }
    return json({ ok: true });
  });
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.getState().reset();
  useAppStore.setState({
    world: applySnapshot({
      logId: 'log-a',
      seq: 1,
      agents: [fx.harmonizer, steward],
      bodies: [fx.body],
      projects: [fx.project, subProject],
      tasks: [fx.task, newTask],
      questions: [],
      proposals: [],
      statuses: [],
    }),
  });
  calls = [];
  routes = () => undefined;
  listed = [folder, dev, notes, shot, app, site, gone, removed];
  folderPath = `${WS}/deliverables`;
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:http://localhost/${++n}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function show(view: React.ReactNode, rules: ClientRules = MAC) {
  const api = createApi('tok', fetchMock() as unknown as typeof fetch);
  const utils = render(
    <ApiContext.Provider value={api}>
      <RulesContext.Provider value={rules}>{view}</RulesContext.Provider>
    </ApiContext.Provider>,
  );
  await flush();
  await flush();
  return utils;
}

const rowOf = (title: string) =>
  screen
    .getAllByRole('listitem')
    .find((li) => li.querySelector('.dlv-title')?.textContent === title)!;
const click = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
  await flush();
};
const posts = (suffix: string) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith(suffix));

describe('the project view: grouping and rows (decision 124, SPEC §4.7)', () => {
  it("lists the project's own first, then its tasks newest first, then sub-projects folded", async () => {
    await show(<ProjectDeliverables projectId="p-1" />);
    const titles = [...document.querySelectorAll('.dlv-title')].map((e) => e.textContent);
    expect(titles).toEqual([
      'Project folder',
      'dev',
      'Release notes',
      'Staging',
      'Login screenshot',
      'Demo.app',
      'Coverage report',
    ]);
    const groups = [...document.querySelectorAll('.dlv-group-title')].map((e) => e.textContent);
    expect(groups).toEqual(['Task Draw the login screen', 'Task Replace the session middleware']);
    // The sub-project is folded and read only when unfolded.
    const sub = screen.getByText('Admin console').closest('details')!;
    expect(sub.open).toBe(false);
    expect(calls.some((c) => c.path.includes('projectId=p-sub'))).toBe(false);
    await act(async () => {
      sub.open = true;
      fireEvent(sub, new Event('toggle'));
    });
    await flush();
    expect(calls.some((c) => c.path === '/api/deliverables?projectId=p-sub')).toBe(true);
    expect(within(sub).getByText('No deliverables yet.')).toBeTruthy();
  });

  it('shows kind, who added it, where it is, a copy’s left-out entries, a command’s state, missing', async () => {
    await show(<ProjectDeliverables projectId="p-1" />);
    const s = rowOf('Login screenshot');
    expect(s.textContent).toContain('added by');
    expect(s.textContent).toContain('in the deliverables folder');
    expect(s.textContent).toContain('deliverables/login/shot.svg');
    expect(s.textContent).toContain('2 entries left out: .env (secret), cache (link)');
    const d = rowOf('dev');
    expect(d.textContent).toContain('pnpm run dev');
    expect(d.textContent).toContain('runs in the project folder');
    expect(d.textContent).toContain('running · :5173');
    expect(d.textContent).toContain('added by detected');
    // No Run button: the runs are the next task's (P9-10).
    expect(within(d).queryByRole('button', { name: /Run/ })).toBeNull();
    const g = rowOf('Coverage report');
    expect(g.textContent).toContain('missing — not there any more');
    expect(within(g).queryByRole('button', { name: 'View' })).toBeNull();
    expect(within(g).queryByRole('button', { name: 'Download' })).toBeNull();
  });

  it("shows the project's deliverables folder with its size and Reveal in Finder", async () => {
    await show(<ProjectDeliverables projectId="p-1" />);
    const line = document.querySelector('.dlv-folder')!;
    expect(line.textContent).toContain('deliverables');
    expect(line.textContent).toContain('excluded from git on this Mac');
    expect(line.textContent).toContain('3.3 MB');
    await click(within(line as HTMLElement).getByRole('button', { name: 'Reveal in Finder' }));
    expect(posts('/api/deliverables/folder/reveal')).toEqual([
      { method: 'POST', path: '/api/deliverables/folder/reveal', body: { projectId: 'p-1' } },
    ]);
  });

  it('hides removed rows until "Show removed", which shows who removed them and Restore', async () => {
    await show(<ProjectDeliverables projectId="p-1" />);
    expect(screen.queryByText('Scratch log')).toBeNull();
    await click(screen.getByRole('checkbox', { name: 'Show removed' }));
    const r = rowOf('Scratch log');
    expect(r.textContent).toContain('removed by you: not needed');
    expect(
      within(r)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Restore']);
    await click(within(r).getByRole('button', { name: 'Restore' }));
    expect(posts('/d-removed/restore')).toHaveLength(1);
  });
});

describe('actions per kind on the Mac (decisions 125, 127, 128)', () => {
  it('opens, reveals, opens a folder in the named IDE, and downloads through a one-time link', async () => {
    routes = (method, path) =>
      method === 'POST' && path === '/api/deliverables/d-notes/download'
        ? json({ url: '/files/abcDEF' })
        : undefined;
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.getAttribute('href') ?? '');
    });
    await show(<ProjectDeliverables projectId="p-1" />);
    const n = rowOf('Release notes');
    await click(within(n).getByRole('button', { name: 'Open' }));
    await click(within(n).getByRole('button', { name: 'Reveal in Finder' }));
    await click(within(rowOf('Project folder')).getByRole('button', { name: 'Open in WebStorm' }));
    expect(posts('/open').map((c) => [c.path, c.body])).toEqual([
      ['/api/deliverables/d-notes/open', { action: 'open' }],
      ['/api/deliverables/d-notes/open', { action: 'reveal' }],
      ['/api/deliverables/d-folder/open', { action: 'ide' }],
    ]);
    await click(within(n).getByRole('button', { name: 'Download' }));
    expect(clicks).toEqual(['/files/abcDEF']);
    // The token is never in an address: only the bearer header carries it.
    expect(clicks.join()).not.toContain('tok');
  });

  it('asks before opening an application: name, who added it, never opened before; Keep first', async () => {
    let confirmed: unknown;
    routes = (method, path, body) => {
      if (method !== 'POST' || path !== '/api/deliverables/d-app/open') return undefined;
      const b = body as { fingerprint?: string };
      if (b.fingerprint === 'fp-1') {
        confirmed = body;
        return json({ ok: true });
      }
      return json(
        {
          error: 'confirm',
          code: 'confirm',
          fingerprint: 'fp-1',
          addedBy: { type: 'agent', id: 'a-steward-1' },
          name: 'Demo.app',
        },
        409,
      );
    };
    await show(<ProjectDeliverables projectId="p-1" />);
    const a = rowOf('Demo.app');
    await click(within(a).getByRole('button', { name: 'Open' }));
    const box = within(a).getByRole('group', { name: 'confirm' });
    expect(box.textContent).toContain('Open Demo.app? Added by');
    expect(box.textContent).toContain('it has not been opened before');
    expect(document.activeElement?.textContent).toBe('Keep');
    await click(within(box).getByRole('button', { name: 'Open Demo.app' }));
    expect(confirmed).toEqual({ action: 'app', fingerprint: 'fp-1' });
    expect(within(a).queryByRole('group', { name: 'confirm' })).toBeNull();
  });

  it('says the application changed since it was last opened when a confirmation was stored', async () => {
    listed = [
      { ...app, meta: { confirmedOpen: { fingerprint: 'old', at: NOW, by: { type: 'user' } } } },
    ];
    routes = (method, path) =>
      method === 'POST' && path === '/api/deliverables/d-app/open'
        ? json(
            {
              error: 'confirm',
              code: 'confirm',
              fingerprint: 'new',
              addedBy: { type: 'user' },
              name: 'Demo.app',
            },
            409,
          )
        : undefined;
    await show(<ProjectDeliverables projectId="p-1" />);
    await click(within(rowOf('Demo.app')).getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('group', { name: 'confirm' }).textContent).toContain(
      'it changed since it was last opened',
    );
    await click(screen.getByRole('button', { name: 'Keep' }));
    expect(posts('/d-app/open')).toHaveLength(1);
  });

  it('opens a web address in a new tab with noopener', async () => {
    await show(<ProjectDeliverables projectId="p-1" />);
    const link = within(rowOf('Staging')).getByRole('link', { name: 'Open address' });
    expect(link.getAttribute('href')).toBe('https://staging.example.com/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('shows a refusal on the row (the IDE removed, a file swapped)', async () => {
    routes = (method, path) =>
      method === 'POST' && path === '/api/deliverables/d-folder/open'
        ? json({ error: 'ide_not_installed', message: 'WebStorm is not installed any more' }, 409)
        : undefined;
    await show(<ProjectDeliverables projectId="p-1" />);
    await click(within(rowOf('Project folder')).getByRole('button', { name: 'Open in WebStorm' }));
    expect(within(rowOf('Project folder')).getByRole('alert').textContent).toBe(
      'WebStorm is not installed any more',
    );
  });
});

describe('edit, remove and add by hand (decisions 119, 121, 122, 131)', () => {
  it('a stale edit shows the current version and saves against it the second time', async () => {
    const current: Deliverable = { ...notes, title: 'Release notes v2', version: 4 };
    let patches = 0;
    routes = (method, path) => {
      if (method !== 'PATCH' || path !== '/api/deliverables/d-notes') return undefined;
      patches++;
      return patches === 1
        ? json({ error: 'stale', message: 'changed', deliverable: current }, 409)
        : json({ deliverable: current });
    };
    await show(<ProjectDeliverables projectId="p-1" />);
    await click(within(rowOf('Release notes')).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'edit Release notes' });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Notes' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    await flush();
    expect(within(form).getByRole('alert').textContent).toContain('changed meanwhile');
    expect((within(form).getByLabelText('Title') as HTMLInputElement).value).toBe(
      'Release notes v2',
    );
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Notes' } });
    await act(async () => {
      fireEvent.submit(form);
    });
    await flush();
    const sent = calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
    expect(sent).toEqual([
      { version: 1, title: 'Notes' },
      { version: 4, title: 'Notes' },
    ]);
  });

  it('remove asks first, says the files stay, starts on Keep', async () => {
    await show(<ProjectDeliverables projectId="p-1" />);
    await click(within(rowOf('Release notes')).getByRole('button', { name: 'Remove' }));
    const box = screen.getByRole('group', { name: 'confirm' });
    expect(box.textContent).toContain('Nothing is deleted: the files stay where they are.');
    expect(document.activeElement?.textContent).toBe('Keep');
    await click(within(box).getByRole('button', { name: 'Remove' }));
    expect(posts('/d-notes/remove')).toHaveLength(1);
  });

  it('adds a file by its path, and a command in the project folder', async () => {
    await show(<ProjectDeliverables projectId="p-1" />);
    await click(screen.getByRole('button', { name: 'Add…' }));
    const form = screen.getByRole('form', { name: 'add a deliverable' });
    expect(form.textContent).toContain('copied into its deliverables/ folder');
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'Spec' } });
    fireEvent.change(within(form).getByLabelText('Path'), {
      target: { value: '/Users/me/spec.pdf' },
    });
    await act(async () => {
      fireEvent.submit(form);
    });
    await flush();
    await click(screen.getByRole('button', { name: 'Add…' }));
    const again = screen.getByRole('form', { name: 'add a deliverable' });
    fireEvent.change(within(again).getByLabelText('Kind'), { target: { value: 'command' } });
    fireEvent.change(within(again).getByLabelText('Title'), { target: { value: 'Tests' } });
    fireEvent.change(within(again).getByLabelText('Command'), { target: { value: 'pnpm test' } });
    await act(async () => {
      fireEvent.submit(again);
    });
    await flush();
    expect(posts('/api/deliverables').map((c) => c.body)).toEqual([
      { projectId: 'p-1', kind: 'file', title: 'Spec', path: '/Users/me/spec.pdf' },
      { projectId: 'p-1', kind: 'command', title: 'Tests', command: { line: 'pnpm test' } },
    ]);
  });

  it('a task adds to the task; Rescan scans the project folder again', async () => {
    await show(<TaskDeliverables taskId="t-1" />);
    expect(screen.queryByRole('button', { name: 'Rescan' })).toBeNull();
    cleanup();
    await show(<ProjectDeliverables projectId="p-1" />);
    await click(screen.getByRole('button', { name: 'Rescan' }));
    expect(posts('/api/projects/p-1/deliverables/rescan')).toHaveLength(1);
  });
});

describe('the phone and the desktop app (decisions 131, 134)', () => {
  it('the phone lists, views and downloads; opening says "on the Mac"; no edits', async () => {
    await show(<ProjectDeliverables projectId="p-1" />, PHONE);
    const n = rowOf('Release notes');
    expect(
      within(n)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['View', 'Download']);
    expect(n.textContent).toContain('Open, Reveal in Finder: on the Mac');
    expect(rowOf('Project folder').textContent).toContain(
      'Open in WebStorm, Reveal in Finder: on the Mac',
    );
    expect(within(rowOf('Demo.app')).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Add…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rescan' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(document.querySelector('.dlv-folder')!.textContent).toContain(
      'Reveal in Finder: on the Mac',
    );
    expect(screen.queryByRole('button', { name: 'Reveal in Finder' })).toBeNull();
  });

  it('with autoApproveRemote the phone edits, but adds only paths inside the project', async () => {
    await show(<ProjectDeliverables projectId="p-1" />, PHONE_AUTO);
    expect(within(rowOf('Release notes')).getByRole('button', { name: 'Edit' })).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Add…' }));
    expect(screen.getByRole('form', { name: 'add a deliverable' }).textContent).toContain(
      'can be added on the Mac only',
    );
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull();
  });

  it('the desktop app offers no Download', async () => {
    await show(<ProjectDeliverables projectId="p-1" />, DESKTOP);
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(within(rowOf('Release notes')).getByRole('button', { name: 'Open' })).toBeTruthy();
  });
});

describe('the viewer: nothing it shows runs (decisions 125, 126)', () => {
  const content = (body: string, contentType: string, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': contentType, ...headers } });

  async function view(row: DeliverableListItem, response: Response, rules = MAC) {
    listed = [row];
    routes = (method, path) =>
      method === 'GET' && path === `/api/deliverables/${row.id}/content` ? response : undefined;
    await show(<ProjectDeliverables projectId="p-1" />, rules);
    await click(within(rowOf(row.title)).getByRole('button', { name: 'View' }));
    return screen.findByTestId('deliverable-viewer');
  }

  it('highlights code; a <script> in a source file comes out as text', async () => {
    const src = 'const a = "<script>window.__pwned = 1</script>";\n<img src=x onerror="alert(1)">';
    const v = await view(
      item({
        id: 'd-src',
        title: 'app.ts',
        location: { storage: 'in_place', path: `${WS}/src/app.ts` },
      }),
      content(src, 'text/plain; charset=utf-8'),
    );
    await vi.waitFor(() => expect(v.querySelector('code.hljs')).toBeTruthy());
    expect(v.querySelector('code')!.textContent).toBe(src);
    expect(document.querySelectorAll('script, img, [onerror]')).toHaveLength(0);
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    // The focus goes to the viewer; Escape closes it and gives it back to View.
    expect(document.activeElement?.textContent).toBe('app.ts');
    await act(async () => {
      fireEvent.keyDown(v, { key: 'Escape' });
    });
    expect(screen.queryByTestId('deliverable-viewer')).toBeNull();
    expect(document.activeElement?.textContent).toBe('View');
  });

  it('shows an HTML file as its source, never rendered', async () => {
    const html = '<!doctype html><h1 id="x">Hi</h1><script>alert(1)</script>';
    const v = await view(
      item({
        id: 'd-html',
        title: 'index.html',
        location: { storage: 'in_place', path: `${WS}/index.html` },
      }),
      content(html, 'text/plain; charset=utf-8'),
    );
    await vi.waitFor(() => expect(v.querySelector('code')?.textContent).toBe(html));
    expect(document.querySelector('h1#x')).toBeNull();
    expect(document.querySelectorAll('script')).toHaveLength(0);
  });

  it('renders Markdown without raw HTML, javascript: links or images; a Source switch', async () => {
    const md = [
      '# Release',
      '',
      '<script>window.__pwned = 1</script>',
      '',
      '<img src="x" onerror="window.__pwned = 2"> <b onclick="alert(1)">bold html</b>',
      '',
      '[bad](javascript:alert(1)) [bad2](JAVASCRIPT:alert(1)) [ok](https://example.com/docs) [other](./OTHER.md)',
      '',
      '![the chart](https://tracker.example/pixel.png) ![local shot](./shot.png)',
    ].join('\n');
    const v = await view(
      item({
        id: 'd-md',
        title: 'NOTES.md',
        location: { storage: 'in_place', path: `${WS}/NOTES.md` },
      }),
      content(md, 'text/plain; charset=utf-8'),
    );
    await vi.waitFor(() =>
      expect(v.querySelector('.dlv-markdown h1')?.textContent).toBe('Release'),
    );
    expect(document.querySelectorAll('script, img, b, [onerror], [onclick]')).toHaveLength(0);
    const links = [...v.querySelectorAll('.dlv-markdown a')];
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['ok', 'https://example.com/docs'],
      ['(image address)', 'https://tracker.example/pixel.png'],
    ]);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
    expect(v.textContent).toContain('[image: the chart]');
    expect(v.textContent).toContain('[image: local shot]');
    expect(v.textContent).toContain('bad');
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
    await click(within(v).getByRole('button', { name: 'Source' }));
    expect(v.querySelector('pre code')!.textContent).toBe(md);
  });

  it('shows an SVG with a script only as a picture, never from a blob: URL (review B1)', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>window.__pwned=3</script><rect width="4" height="4"/></svg>';
    const v = await view(shot, content(svg, 'image/svg+xml'));
    const img = await vi.waitFor(() => {
      const el = v.querySelector('img');
      expect(el).toBeTruthy();
      return el!;
    });
    // jsdom has no canvas: the opaque-origin data: URL stands in for the PNG.
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(atob(img.getAttribute('src')!.split(',')[1]!)).toBe(svg);
    for (const [arg] of vi.mocked(URL.createObjectURL).mock.calls) {
      expect((arg as Blob).type).not.toBe('image/svg+xml');
    }
    expect(document.querySelectorAll('script, svg, iframe, object, embed, [onload]')).toHaveLength(
      0,
    );
    expect((window as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('never shows a response of another type as a picture or a page', async () => {
    const v = await view(
      item({
        id: 'd-img',
        kind: 'image',
        title: 'x.png',
        facts: { exists: true, kindGuess: 'image', size: 10 },
      }),
      content('<script>alert(1)</script>', 'text/html'),
    );
    await vi.waitFor(() => expect(v.textContent).toContain('no preview'));
    expect(document.querySelectorAll('script, img, iframe')).toHaveLength(0);
  });

  it('says when the text was cut at the preview limit, and when a file is too large', async () => {
    const v = await view(
      item({
        id: 'd-big',
        title: 'big.log',
        location: { storage: 'in_place', path: `${WS}/big.log` },
      }),
      content('a'.repeat(100), 'text/plain; charset=utf-8', { 'x-truncated': '1' }),
    );
    await vi.waitFor(() => expect(v.textContent).toContain('Showing the first 2 MB'));
    cleanup();
    const w = await view(
      item({ id: 'd-huge', title: 'huge.txt' }),
      json({ error: 'too_large', message: 'larger than the preview limit' }, 413),
    );
    await vi.waitFor(() => expect(w.textContent).toContain('Too large to preview here'));
  });
});

describe('the Steward view section and the history list', () => {
  it("lists the task's deliverables, and the navigation's request puts the focus on it", async () => {
    useDeliverablesFocus.getState().ask('task:t-1');
    await show(<TaskDeliverables taskId="t-1" />);
    const heading = screen.getByRole('heading', { name: /Deliverables of this task/ });
    expect(document.activeElement).toBe(heading);
    expect(useDeliverablesFocus.getState().request).toBeUndefined();
    const titles = [...document.querySelectorAll('.dlv-title')].map((e) => e.textContent);
    expect(titles.sort()).toEqual(['Coverage report', 'Demo.app']);
    expect(calls.find((c) => c.path.startsWith('/api/deliverables?'))?.path).toBe(
      '/api/deliverables?taskId=t-1',
    );
  });

  it('the history lists removed rows too, "removed by …"', async () => {
    await show(<HistoryDeliverables target={{ kind: 'project', id: 'p-1' }} />);
    expect(calls.find((c) => c.path.startsWith('/api/deliverables?'))?.path).toBe(
      '/api/deliverables?projectId=p-1&removed=1',
    );
    expect(rowOf('Scratch log').textContent).toContain('removed by you');
    expect(screen.queryByRole('checkbox', { name: 'Show removed' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add…' })).toBeNull();
  });

  it('reads the list again when the stream changes one of its rows', async () => {
    await show(<TaskDeliverables taskId="t-1" />);
    const reads = () => calls.filter((c) => c.path.startsWith('/api/deliverables?')).length;
    expect(reads()).toBe(1);
    await act(async () => {
      useAppStore.setState((s) => ({
        world: { ...s.world, deliverables: { 'd-app': { ...app, version: 2 } } },
      }));
    });
    await flush();
    expect(reads()).toBe(2);
  });
});

describe('accessibility (decision 81)', () => {
  it('axe passes on the project view, the phone view, the forms and the viewer', async () => {
    const check = async (name: string) =>
      expect(blocking(await axeFindings()), name).toEqual<AxeFinding[]>([]);
    listed = [folder, dev, notes, shot, app, site, gone, removed];
    routes = (method, path) =>
      method === 'GET' && path === '/api/deliverables/d-notes/content'
        ? new Response('# Notes\n\nSome **text**.', { headers: { 'content-type': 'text/plain' } })
        : undefined;
    await show(<ProjectDeliverables projectId="p-1" />);
    await check('project');
    await click(screen.getByRole('button', { name: 'Add…' }));
    await click(within(rowOf('Release notes')).getByRole('button', { name: 'Edit' }));
    await check('forms');
    await click(within(rowOf('Release notes')).getByRole('button', { name: 'View' }));
    await screen.findByTestId('deliverable-viewer');
    await vi.waitFor(() => expect(document.querySelector('.dlv-markdown')).toBeTruthy());
    await check('viewer');
    cleanup();
    await show(<ProjectDeliverables projectId="p-1" />, PHONE);
    await check('phone');
  });
});
