import { act, cleanup, configure, fireEvent, render, screen, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyWorld,
  type Agent,
  type Body,
  type Job,
  type Panel,
  type PanelData,
  type Project,
  type ServerMessage,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';
import { SCENE_VISIBLE_KEY } from '../../scene/visibility.js';
import { fullSnapshot, openApp, quietFetch, stubMedia } from '../../a11y/a11y-fixtures.js';
import { REDUCED_MOTION_QUERY } from '../../scene/motion.js';
import { DOCK_VIEW_KEY, useDockView } from '../status/dock-view.js';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { DashboardPane } from './DashboardPane.js';
import { CELEBRATED_KEY, celebrated, markCelebrated } from './celebrated.js';

/**
 * P15-06 (SPEC decision 156) — a long-term project's dashboard on the Mac: a first "Dashboard" tab
 * on its Waykeeper, a 4-column grid of panels read from `GET …/dashboard`, "very bad / very good"
 * as words with arrows, fireworks once per run result, refresh and clear history.
 */

vi.mock('../../scene/SolarScene.js', () => ({
  default: function StubScene() {
    return <div data-testid="solar-scene" />;
  },
}));
vi.mock('../../scene/webgl.js', () => ({ webglAvailable: () => true }));
const revealQuestion = vi.fn();
const revealInbox = vi.fn();
vi.mock('../inbox-reveal.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  revealQuestion: (id: string) => revealQuestion(id),
  revealInbox: () => revealInbox(),
}));

const NOW = '2026-11-11T10:00:00.000Z';
const HOUR_AGO = '2026-11-11T08:00:00.000Z';

const saturn: Body = { id: 'b-saturn', kind: 'planet', name: 'Saturn' };
const shop: Project = {
  ...fx.project,
  id: 'p-shop',
  name: 'Shop',
  bodyId: 'b-saturn',
  longTerm: true,
  purpose: 'Sell lamps',
  goals: [],
};
const shopWaykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-wk-shop',
  role: 'waykeeper',
  projectId: 'p-shop',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-saturn',
};
const job: Job = {
  ...fx.job,
  id: 'j-1',
  projectId: 'p-shop',
  name: 'Count churn',
};

const panel = (id: string, type: Panel['type'], over: Partial<Panel> = {}): Panel =>
  ({
    ...fx.panel,
    id,
    projectId: 'p-shop',
    type,
    title: `Panel ${id}`,
    source: { kind: 'job', jobId: 'j-1', values: ['x'] },
    layout: { order: 0, w: 1, h: 1 },
    ...over,
  }) as Panel;

const data = (panelId: string, over: Partial<PanelData> = {}): PanelData => ({
  panelId,
  status: 'ok',
  lastGoodAt: HOUR_AGO,
  sourceLine: 'from job “Count churn”',
  ...over,
});

let panels: Panel[] = [];
let datas: PanelData[] = [];
let jobs: Job[] = [job];
const api = {
  dashboard: vi.fn(async () => ({ panels: datas })),
  refreshJob: vi.fn(async () => ({ runId: 'jr-9', started: true })),
  clearPanelHistory: vi.fn(async () => ({})),
  jobRuns: vi.fn(async () => ({ runs: [] })),
};

function setWorld() {
  useAppStore.setState({
    world: {
      ...emptyWorld(),
      projects: { 'p-shop': shop },
      jobs: Object.fromEntries(jobs.map((j) => [j.id, j])),
      panels: Object.fromEntries(panels.map((p) => [p.id, p])),
    },
  });
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

async function renderPane(extra?: ReactNode) {
  setWorld();
  render(
    createElement(
      ApiContext.Provider,
      { value: api as unknown as Api },
      createElement(DashboardPane, { projectId: 'p-shop' }),
      extra,
    ),
  );
  await settle();
}

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  useAppStore.getState().reset();
  panels = [];
  datas = [];
  jobs = [job];
  api.dashboard.mockClear();
  api.refreshJob.mockClear();
  api.clearPanelHistory.mockClear();
  revealQuestion.mockClear();
  revealInbox.mockClear();
});
afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  await settle();
  vi.unstubAllGlobals();
});

describe('the job map from a panel', () => {
  it('the source line opens the job map, and Escape closes it', async () => {
    panels = [panel('pn-1', 'tile', { title: 'Churn' })];
    datas = [data('pn-1', { tile: { value: 4.1 } })];
    await renderPane();
    fireEvent.click(screen.getByRole('button', { name: /from job “Count churn”/ }));
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Gathers from' })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a requested panel is scrolled to and focused once, then the request clears', async () => {
    panels = [panel('pn-1', 'tile', { title: 'Churn' }), panel('pn-2', 'text')];
    datas = [data('pn-1', { tile: { value: 4.1 } }), data('pn-2', { text: 'hi' })];
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    await renderPane();
    act(() => useDockView.getState().showPanel('pn-2'));
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(document.activeElement?.id).toBe('dash-panel-pn-2');
    expect(useDockView.getState().focusPanelId).toBeUndefined();
  });
});

describe('panels render from their data', () => {
  it('a tile shows its value, its change and its source line with the age', async () => {
    panels = [panel('pn-1', 'tile', { title: 'Churn', display: { format: 'percent' } })];
    datas = [
      data('pn-1', { tile: { value: 4.1, previous: 4.7, changePct: -12.8, changeAbs: -0.6 } }),
    ];
    await renderPane();
    const card = screen.getByRole('article', { name: 'Churn' });
    expect(card.textContent).toContain('4.1%');
    expect(card.textContent).toContain('0.6');
    expect(card.textContent).toMatch(/from job “Count churn” · \d+ h ago/);
  });

  it('a line chart and a bar chart are SVG with a text alternative', async () => {
    const points = [
      { at: '2026-11-09T00:00:00.000Z', value: 10 },
      { at: '2026-11-10T00:00:00.000Z', value: 30 },
      { at: '2026-11-11T00:00:00.000Z', value: 20 },
    ];
    panels = [
      panel('pn-1', 'line', { title: 'Installs' }),
      panel('pn-2', 'bar', { title: 'Cost' }),
    ];
    datas = [
      data('pn-1', { series: [{ name: 'installs', points }] }),
      data('pn-2', {
        series: [
          { name: 'Meta', points: [{ at: NOW, value: 4 }] },
          { name: 'Google', points: [{ at: NOW, value: 9 }] },
        ],
      }),
    ];
    await renderPane();
    const line = screen.getByRole('img', { name: /Installs.*latest 20.*10.*30/ });
    expect(line.tagName.toLowerCase()).toBe('svg');
    expect(line.querySelector('polyline')).toBeTruthy();
    const bars = screen.getByRole('img', { name: /Cost.*Meta 4.*Google 9/ });
    expect(bars.querySelectorAll('rect').length).toBe(2);
  });

  it('a table, a list, a calendar, a status board and a text', async () => {
    panels = [
      panel('pn-t', 'table', { title: 'Tests' }),
      panel('pn-l', 'list', { title: 'Feedback' }),
      panel('pn-c', 'calendar', { title: 'Posts' }),
      panel('pn-s', 'status', { title: 'Features', source: { kind: 'tasks' } }),
      panel('pn-x', 'text', { title: 'Note' }),
    ];
    datas = [
      data('pn-t', {
        table: {
          columns: ['Test', 'Result'],
          rows: [
            ['Short demo', '+18%'],
            ['Price', 7],
          ],
        },
      }),
      data('pn-l', { list: [{ title: 'Love the export', tag: 'review' }] }),
      data('pn-c', { calendar: [{ date: '2026-11-14', title: 'Founder post' }] }),
      data('pn-s', {
        statusBoard: { columns: [{ name: 'Next', items: [{ title: 'Dark mode' }] }] },
      }),
      data('pn-x', { text: 'Installs keep growing.' }),
    ];
    await renderPane();
    const t = screen.getByRole('article', { name: 'Tests' });
    expect(within(t).getByRole('columnheader', { name: 'Result' })).toBeTruthy();
    expect(within(t).getByRole('cell', { name: '+18%' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Feedback' }).textContent).toContain('review');
    const cal = screen.getByRole('article', { name: 'Posts' });
    expect(cal.textContent).toContain('November 2026');
    expect(within(cal).getByText('Founder post')).toBeTruthy();
    const board = screen.getByRole('article', { name: 'Features' });
    expect(board.textContent).toContain('Next');
    expect(board.textContent).toContain('Dark mode');
    expect(screen.getByRole('article', { name: 'Note' }).textContent).toContain(
      'Installs keep growing.',
    );
  });

  it('places panels by layout order, spanning w columns and h rows, and skips hidden ones', async () => {
    panels = [
      panel('pn-b', 'text', { title: 'B', layout: { order: 1, w: 2, h: 2 } }),
      panel('pn-a', 'text', { title: 'A', layout: { order: 0, w: 1, h: 1 } }),
      panel('pn-h', 'text', { title: 'Hidden', layout: { order: 2, w: 1, h: 1, hidden: true } }),
    ];
    datas = panels.map((p) => data(p.id, { text: 'x' }));
    await renderPane();
    const titles = screen.getAllByRole('article').map((a) => a.getAttribute('aria-label'));
    expect(titles).toEqual(['A', 'B']);
    const b = screen.getByRole('article', { name: 'B' });
    expect(b.style.gridColumn).toBe('span 2');
    expect(b.style.gridRow).toBe('span 2');
    expect(screen.queryByRole('article', { name: 'Hidden' })).toBeNull();
  });
});

describe('verdicts', () => {
  const verdictTile = (kind: 'very_bad' | 'very_good', resultId = 'jr-1') => {
    panels = [panel('pn-1', 'tile', { title: 'Churn' })];
    datas = [
      data('pn-1', {
        tile: { value: 9 },
        verdict: {
          kind,
          value: 'churn',
          arrow: kind === 'very_bad' ? 'up' : 'down',
          resultId,
        },
      }),
    ];
  };

  it('a very bad tile shows the words "very bad" and an arrow', async () => {
    verdictTile('very_bad');
    await renderPane();
    const card = screen.getByRole('article', { name: 'Churn' });
    expect(card.textContent).toContain('very bad');
    expect(card.textContent).toContain('▲');
    expect(card.className).toContain('is-very-bad');
    expect(card.className).not.toContain('is-very-good');
  });

  it('a stale panel says "last good value <time>" and carries no verdict class', async () => {
    panels = [panel('pn-1', 'tile', { title: 'Churn' })];
    datas = [
      data('pn-1', {
        status: 'stale',
        tile: { value: 9 },
        // The server never sends a verdict for a stale panel; the view must not show one anyway.
        verdict: { kind: 'very_bad', value: 'churn', arrow: 'up', resultId: 'jr-1' },
      }),
    ];
    await renderPane();
    const card = screen.getByRole('article', { name: 'Churn' });
    expect(card.textContent).toMatch(/last good value \d+ h ago/);
    expect(card.textContent).not.toContain('very bad');
    expect(card.className).not.toMatch(/is-very/);
  });

  it('job_stopped and not_reported are plain too', async () => {
    panels = [panel('pn-1', 'tile', { title: 'A' }), panel('pn-2', 'tile', { title: 'B' })];
    datas = [
      data('pn-1', { status: 'job_stopped', tile: { value: 1 } }),
      data('pn-2', { status: 'not_reported', tile: { value: 1 } }),
    ];
    await renderPane();
    expect(screen.getByRole('article', { name: 'A' }).textContent).toContain('Job stopped');
    expect(screen.getByRole('article', { name: 'B' }).textContent).toContain('No longer reported');
  });

  it('empty: "No data yet", or "No data since history was cleared" after a clear', async () => {
    panels = [
      panel('pn-1', 'table', { title: 'A' }),
      panel('pn-2', 'table', { title: 'B', historyFrom: HOUR_AGO }),
    ];
    datas = [data('pn-1', { status: 'empty' }), data('pn-2', { status: 'empty' })];
    await renderPane();
    expect(screen.getByRole('article', { name: 'A' }).textContent).toContain('No data yet');
    expect(screen.getByRole('article', { name: 'A' }).textContent).not.toContain('since history');
    expect(screen.getByRole('article', { name: 'B' }).textContent).toContain(
      'No data since history was cleared',
    );
  });

  it('"Needs a look" lists only the panels with a verdict', async () => {
    panels = [
      panel('pn-1', 'tile', { title: 'Churn', layout: { order: 0, w: 1, h: 1 } }),
      panel('pn-2', 'tile', { title: 'Installs', layout: { order: 1, w: 1, h: 1 } }),
      panel('pn-3', 'text', { title: 'Note', layout: { order: 2, w: 1, h: 1 } }),
    ];
    datas = [
      data('pn-1', {
        tile: { value: 9 },
        verdict: { kind: 'very_bad', value: 'churn', arrow: 'up', resultId: 'jr-1' },
      }),
      data('pn-2', { tile: { value: 3 } }),
      data('pn-3', { text: 'x' }),
    ];
    await renderPane();
    const look = screen.getByRole('region', { name: 'Needs a look' });
    const items = within(look).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]!.textContent).toContain('Churn');
    expect(items[0]!.textContent).toContain('very bad');
  });

  it('no "Needs a look" section without a verdict', async () => {
    panels = [panel('pn-2', 'tile', { title: 'Installs' })];
    datas = [data('pn-2', { tile: { value: 3 } })];
    await renderPane();
    expect(screen.queryByRole('region', { name: 'Needs a look' })).toBeNull();
  });
});

describe('fireworks', () => {
  const goodTile = (resultId: string) => {
    panels = [panel('pn-1', 'tile', { title: 'Installs' })];
    datas = [
      data('pn-1', {
        tile: { value: 99 },
        verdict: { kind: 'very_good', value: 'installs', arrow: 'up', resultId },
      }),
    ];
  };

  it('play once for a result and not after a remount', async () => {
    goodTile('jr-5');
    await renderPane();
    expect(document.querySelector('.dash-fireworks')).toBeTruthy();
    expect(document.querySelector('.dash-fireworks')!.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getAllByRole('status').some((s) => s.textContent === 'very good')).toBe(true);
    expect(celebrated('jr-5')).toBe(true);

    cleanup();
    await renderPane();
    expect(document.querySelector('.dash-fireworks')).toBeNull();
    // A new result plays again.
    cleanup();
    goodTile('jr-6');
    await renderPane();
    expect(document.querySelector('.dash-fireworks')).toBeTruthy();
  });

  it('go away by themselves after about a second and a half', async () => {
    goodTile('jr-7');
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    setWorld();
    render(
      createElement(
        ApiContext.Provider,
        { value: api as unknown as Api },
        createElement(DashboardPane, { projectId: 'p-shop' }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.querySelector('.dash-fireworks')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(document.querySelector('.dash-fireworks')).toBeNull();
  });

  it('under reduced motion the panel glows instead', async () => {
    stubMedia([REDUCED_MOTION_QUERY]);
    goodTile('jr-8');
    await renderPane();
    expect(document.querySelector('.dash-fireworks')).toBeNull();
    const card = screen.getByRole('article', { name: 'Installs' });
    expect(card.className).toContain('is-glowing');
    expect(card.textContent).toContain('very good');
  });

  it('celebrated ids survive storage failures and keep the last 200', () => {
    for (let i = 0; i < 205; i++) markCelebrated(`r-${i}`);
    expect(celebrated('r-0')).toBe(false);
    expect(celebrated('r-204')).toBe(true);
    expect(JSON.parse(localStorage.getItem(CELEBRATED_KEY)!)).toHaveLength(200);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('no storage');
    });
    expect(celebrated('r-204')).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('refresh, fix & retry and clear history', () => {
  it('Refresh runs the job now', async () => {
    panels = [panel('pn-1', 'tile', { title: 'Churn' })];
    datas = [data('pn-1', { tile: { value: 4 } })];
    await renderPane();
    const refresh = within(screen.getByRole('article', { name: 'Churn' })).getByRole('button', {
      name: 'Refresh',
    });
    await act(async () => {
      fireEvent.click(refresh);
    });
    expect(api.refreshJob).toHaveBeenCalledWith('j-1');
  });

  it('a paused job disables Refresh and offers "Job paused — Fix & retry"', async () => {
    jobs = [{ ...job, state: 'paused', failureQuestionId: 'q-fail' }];
    panels = [panel('pn-1', 'tile', { title: 'Churn' })];
    datas = [data('pn-1', { status: 'job_paused', tile: { value: 4 } })];
    await renderPane();
    const card = screen.getByRole('article', { name: 'Churn' });
    expect(
      (within(card).getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Job paused — Fix & retry' }));
    });
    expect(revealQuestion).toHaveBeenCalledWith('q-fail');
    expect(api.refreshJob).not.toHaveBeenCalled();
  });

  it('a tasks panel has no Refresh', async () => {
    panels = [panel('pn-1', 'status', { title: 'Features', source: { kind: 'tasks' } })];
    datas = [
      data('pn-1', { sourceLine: 'from the project’s tasks', statusBoard: { columns: [] } }),
    ];
    await renderPane();
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull();
  });

  it('clearing history asks first, in the agreed words, and cannot be undone silently', async () => {
    panels = [panel('pn-1', 'tile', { title: 'Churn' })];
    datas = [data('pn-1', { tile: { value: 4 } })];
    await renderPane();
    const card = screen.getByRole('article', { name: 'Churn' });
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'More actions' }));
    });
    await act(async () => {
      fireEvent.click(within(card).getByRole('menuitem', { name: 'Clear history' }));
    });
    expect(card.textContent).toContain(
      "Clear this panel's history? Its charts and comparisons start again from the next run. This can't be undone.",
    );
    expect(api.clearPanelHistory).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Clear history' }));
    });
    expect(api.clearPanelHistory).toHaveBeenCalledWith('pn-1');
  });
});

describe('keeping current', () => {
  it('reads the dashboard again when a job run ends or a panel changes', async () => {
    panels = [panel('pn-1', 'tile', { title: 'Churn' })];
    datas = [data('pn-1', { tile: { value: 4 } })];
    await renderPane();
    expect(api.dashboard).toHaveBeenCalledTimes(1);
    await act(async () => {
      useAppStore.setState((s) => ({
        world: {
          ...s.world,
          jobs: {
            'j-1': {
              ...job,
              lastRun: { ...fx.jobRun, runId: 'jr-new', outcome: 'quiet' } as Job['lastRun'],
            },
          },
        },
      }));
    });
    await settle();
    expect(api.dashboard).toHaveBeenCalledTimes(2);
    await act(async () => {
      useAppStore.setState((s) => ({
        world: {
          ...s.world,
          panels: {
            'pn-1': { ...panels[0]!, title: 'Churn rate', updatedAt: '2026-11-11T11:00:00.000Z' },
          },
        },
      }));
    });
    await settle();
    expect(api.dashboard).toHaveBeenCalledTimes(3);
  });
});

// --- the tab -------------------------------------------------------------------------------------

describe('the Dashboard tab', () => {
  const lamp: Agent = { ...shopWaykeeper };
  function snapshot(): ServerMessage {
    const base = fullSnapshot() as ServerMessage & { type: 'snapshot' };
    return {
      ...base,
      agents: [...base.agents, lamp],
      bodies: [...base.bodies, saturn],
      projects: [...base.projects, shop],
      jobs: [job],
      panels: [panel('pn-1', 'text', { title: 'Weekly note' })],
    } as ServerMessage;
  }
  const main = () => screen.getByRole('main');
  const toggle = () => within(main()).getByRole('group', { name: /^show the/ });
  const options = () =>
    within(toggle())
      .getAllByRole('button')
      .map((b) => b.textContent);

  beforeEach(() => {
    FakeWebSocket.instances = [];
    localStorage.setItem('galactic.token', 'tok');
    localStorage.setItem(SCENE_VISIBLE_KEY, '0');
    useDockView.getState().reload();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal(
      'fetch',
      quietFetch((url) =>
        new URL(url, 'http://x').pathname === '/api/projects/p-shop/dashboard'
          ? new Response(JSON.stringify({ panels: [data('pn-1', { text: 'All good.' })] }))
          : undefined,
      ),
    );
  });

  it('is first, and the default, for a long-term Waykeeper; absent for a short project', async () => {
    await openApp('/waykeeper/a-wk-shop', snapshot());
    expect(options()[0]).toMatch(/^Dashboard/);
    expect(options().slice(1, 4)).toEqual(['Chat', 'Status', 'Deliverables']);
    expect(
      within(toggle())
        .getByRole('button', { name: /^Dashboard/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(await screen.findByRole('region', { name: 'dashboard of Shop' })).toBeTruthy();
    expect(await screen.findByText('All good.')).toBeTruthy();

    cleanup();
    useAppStore.getState().reset();
    await openApp('/waykeeper/a-waykeeper-1', snapshot());
    expect(options()).toEqual(['Chat', 'Status', 'Deliverables']);
    expect(screen.queryByRole('region', { name: /^dashboard of/ })).toBeNull();
  });

  it('the user can still switch tabs while it stays selected', async () => {
    await openApp('/waykeeper/a-wk-shop', snapshot());
    await act(async () => {
      fireEvent.click(within(toggle()).getByRole('button', { name: 'Chat' }));
    });
    await settle();
    expect(screen.queryByRole('region', { name: /^dashboard of/ })).toBeNull();
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('chat');
  });

  it('opens the dashboard again on every selection of a long-term Waykeeper (A, B, A)', async () => {
    await openApp('/waykeeper/a-wk-shop', snapshot());
    await act(async () => {
      fireEvent.click(within(toggle()).getByRole('button', { name: 'Chat' }));
    });
    await settle();
    expect(screen.queryByRole('region', { name: /^dashboard of/ })).toBeNull();
    await act(async () => {
      useAppStore.getState().select({ kind: 'harmonizer' });
    });
    await settle();
    await act(async () => {
      useAppStore.getState().select({ kind: 'waykeeper', id: 'a-wk-shop' });
    });
    await settle();
    expect(screen.getByRole('region', { name: 'dashboard of Shop' })).toBeTruthy();
  });

  it('a pick made in the same gesture as the selection still wins (area moon opens Jobs)', async () => {
    await openApp('/', snapshot());
    await act(async () => {
      useAppStore.getState().select({ kind: 'waykeeper', id: 'a-wk-shop' });
      useDockView.getState().setView('jobs');
    });
    await settle();
    expect(screen.getByRole('region', { name: 'jobs of Shop' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: /^dashboard of/ })).toBeNull();
  });

  it('opens the dashboard again after a steward selection sits in between (A, steward, A)', async () => {
    await openApp('/waykeeper/a-wk-shop', snapshot());
    await act(async () => {
      fireEvent.click(within(toggle()).getByRole('button', { name: 'Chat' }));
    });
    await settle();
    await act(async () => {
      useAppStore.getState().select({ kind: 'steward', id: 'a-steward-1' });
    });
    await settle();
    await act(async () => {
      useAppStore.getState().select({ kind: 'waykeeper', id: 'a-wk-shop' });
    });
    await settle();
    expect(screen.getByRole('region', { name: 'dashboard of Shop' })).toBeTruthy();
  });

  it('the area-moon gesture from a steward view opens Jobs under StrictMode', async () => {
    configure({ reactStrictMode: true });
    try {
      await openApp('/steward/a-steward-1', snapshot());
      await act(async () => {
        useAppStore.getState().select({ kind: 'waykeeper', id: 'a-wk-shop' });
        useDockView.getState().setView('jobs');
      });
      await settle();
      expect(screen.getByRole('region', { name: 'jobs of Shop' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: /^dashboard of/ })).toBeNull();
    } finally {
      configure({ reactStrictMode: false });
    }
  });

  it('a stored "dashboard" shows the chat for a brain without it', async () => {
    localStorage.setItem(DOCK_VIEW_KEY, 'dashboard');
    useDockView.getState().reload();
    await openApp('/waykeeper/a-waykeeper-1', snapshot());
    expect(screen.queryByRole('region', { name: /^dashboard of/ })).toBeNull();
    expect(document.querySelector('.sts-pane-chat')!.hasAttribute('inert')).toBe(false);
  });
});
