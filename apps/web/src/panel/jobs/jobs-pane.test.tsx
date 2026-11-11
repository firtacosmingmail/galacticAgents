// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Agent,
  Area,
  Body,
  Job,
  JobRun,
  JobRunsResponse,
  Project,
  Question,
  ServerMessage,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { FakeWebSocket } from '../../client/fake-socket.js';
import { useAppStore } from '../../state/store.js';
import { SCENE_VISIBLE_KEY } from '../../scene/visibility.js';
import {
  axeFindings,
  blocking,
  fullSnapshot,
  openApp,
  quietFetch,
  stubMedia,
} from '../../a11y/a11y-fixtures.js';
import { COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY } from '../use-media-query.js';
import { DOCK_VIEW_KEY, useDockView } from '../status/dock-view.js';
import { useJobsFilter } from './jobs-model.js';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { JobsPane } from './JobsPane.js';

/**
 * P10-07 (SPEC decision 144; mockup option B with option A's per-job detail) — the Waykeeper of a
 * long-term project gets a fourth dock view, "Jobs": what needs Cosmin first, then every area's
 * jobs with their moon; a job opens its last runs; a moon filter; and it fits a phone.
 */

vi.mock('../../scene/SolarScene.js', () => ({
  default: function StubScene() {
    return <div data-testid="solar-scene" />;
  },
}));
vi.mock('../../scene/webgl.js', () => ({ webglAvailable: () => true }));

const saturn: Body = { id: 'b-saturn', kind: 'planet', name: 'Saturn' };
const titan: Body = {
  id: 'b-titan',
  kind: 'moon',
  parentId: 'b-saturn',
  name: 'Titan',
  host: { kind: 'areas', id: 'p-shop' },
};
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
const area = (id: string, name: string, createdAt: string): Area => ({
  id,
  projectId: 'p-shop',
  name,
  bodyId: 'b-titan',
  createdAt,
  updatedAt: createdAt,
});
const feedback = area('ar-feedback', 'Feedback', '2026-10-01T00:00:00.000Z');
const sales = area('ar-sales', 'Sales', '2026-10-02T00:00:00.000Z');
const replies: Job = {
  ...fx.job,
  id: 'j-replies',
  projectId: 'p-shop',
  areaId: 'ar-feedback',
  name: 'Read feedback, draft replies',
};
const { lastRun: _lastRun, nextRunAt: _nextRunAt, ...bare } = fx.job;
const pipeline: Job = {
  ...bare,
  id: 'j-pipeline',
  projectId: 'p-shop',
  areaId: 'ar-sales',
  name: 'Weekly pipeline report',
  state: 'paused',
  pausedReason: 'CRM login expired',
  failureQuestionId: 'q-fail',
};
const failure: Question = {
  ...fx.question,
  id: 'q-fail',
  originAgentId: 'a-wk-shop',
  holder: { type: 'user' },
  context: {
    text: 'Weekly pipeline report failed: CRM login expired.',
    options: ['Fixed — retry now', 'Stop the job'],
    jobFailure: { jobId: 'j-pipeline', runId: 'jr-9', reason: 'CRM login expired' },
  },
  meta: { jobOwned: true, toUser: true },
};
const finding: Question = {
  ...fx.question,
  id: 'q-find',
  originAgentId: 'a-wk-shop',
  holder: { type: 'user' },
  context: {
    text: 'Users ask for dark mode.',
    options: ['Create a ticket', 'Implement it', 'Drop'],
    finding: { jobId: 'j-replies', runId: 'jr-1', kind: 'suggestion', title: 'Dark mode' },
  },
  meta: { jobOwned: true, toUser: true },
};

function snapshot(): ServerMessage {
  const base = fullSnapshot() as ServerMessage & { type: 'snapshot' };
  return {
    ...base,
    agents: [...base.agents, shopWaykeeper],
    bodies: [...base.bodies, saturn, titan],
    projects: [...base.projects, shop],
    questions: [...base.questions, failure, finding],
    areas: [feedback, sales],
    jobs: [replies, pipeline],
  };
}

const runs: JobRun[] = [
  { ...fx.jobRun, id: 'jr-3', jobId: 'j-replies', outcome: 'findings', summary: '9 messages' },
  {
    ...fx.jobRun,
    id: 'jr-2',
    jobId: 'j-replies',
    outcome: 'failed',
    purpose: 'scheduled',
    summary: 'could not reach the feedback API',
  },
];

const json = (body: unknown) => new Response(JSON.stringify(body));
const runRoute = vi.fn((url: string) => {
  const path = new URL(url, 'http://x').pathname;
  if (path === '/api/projects/p-shop/dashboard') return json({ panels: [] }); // the default tab
  return path === '/api/jobs/j-replies/runs' ? json({ runs } satisfies JobRunsResponse) : undefined;
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  localStorage.clear();
  localStorage.setItem('galactic.token', 'tok');
  localStorage.setItem(SCENE_VISIBLE_KEY, '0');
  useAppStore.getState().reset();
  useDockView.getState().reload();
  useJobsFilter.getState().set(undefined);
  runRoute.mockClear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', quietFetch(runRoute));
});
afterEach(async () => {
  cleanup();
  await settle();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
const main = () => screen.getByRole('main');
const click = async (el: Element) => {
  await act(async () => {
    fireEvent.click(el);
  });
  await settle();
};
const toggle = () =>
  within(main()).getByRole('group', { name: /^show the (dashboard, the )?chat/ });
const options = () =>
  within(toggle())
    .getAllByRole('button')
    .map((b) => b.textContent);
const pane = () => screen.getByRole('region', { name: 'jobs of Shop' });

async function openJobs() {
  await openApp('/waykeeper/a-wk-shop', snapshot());
  await click(within(toggle()).getByRole('button', { name: /^Jobs/ }));
}

describe('the Jobs tab (P10-07)', () => {
  it("shows Jobs only for a long-term project's Waykeeper", async () => {
    await openApp('/waykeeper/a-wk-shop', snapshot());
    expect(options()[4]).toMatch(/^Jobs/);
    expect(options()).toHaveLength(5);
    // A dot: a paused job and a waiting finding need Cosmin.
    expect(within(toggle()).getByRole('button', { name: /^Jobs/ }).textContent).toContain(
      '2 need you',
    );

    cleanup();
    useAppStore.getState().reset();
    await openApp('/waykeeper/a-waykeeper-1', snapshot());
    expect(options()).toEqual(['Chat', 'Status', 'Deliverables']);
  });

  it('a stored "jobs" view shows the chat for a brain without Jobs', async () => {
    localStorage.setItem(DOCK_VIEW_KEY, 'jobs');
    useDockView.getState().reload();
    await openApp('/waykeeper/a-waykeeper-1', snapshot());
    expect(screen.queryByRole('region', { name: /^jobs of/ })).toBeNull();
    expect(document.querySelector('.sts-pane-chat')!.hasAttribute('inert')).toBe(false);
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('jobs');
  });

  it('lists what needs you first, then each area with its moon', async () => {
    await openJobs();
    expect(localStorage.getItem(DOCK_VIEW_KEY)).toBe('jobs');
    const needs = within(pane()).getByRole('region', { name: 'Needs you' });
    expect(needs.textContent).toContain('Sales · Weekly pipeline report');
    expect(needs.textContent).toContain('CRM login expired (asked in the inbox)');
    expect(within(needs).getByRole('button', { name: /Fix & retry/ })).toBeTruthy();
    expect(within(needs).getByRole('button', { name: /1 in inbox/ })).toBeTruthy();

    const fb = within(pane()).getByRole('region', { name: 'Feedback · Titan' });
    expect(fb.textContent).toContain('shares Titan with Sales');
    expect(fb.textContent).toContain('every day 9:00');
    expect(fb.textContent).toContain('Nothing new.');
    expect(fb.textContent).toContain('Claude · next:');
    expect(within(pane()).getByRole('region', { name: 'Sales · Titan' })).toBeTruthy();
    // The chat stays mounted under it, out of reach.
    expect(document.querySelector('.sts-pane-chat')!.hasAttribute('inert')).toBe(true);
  });

  it('"Fix & retry" reveals the failure question in the inbox', async () => {
    await openJobs();
    const needs = within(pane()).getByRole('region', { name: 'Needs you' });
    await click(within(needs).getByRole('button', { name: /Fix & retry/ }));
    await vi.waitFor(() => {
      const card = document.activeElement as HTMLElement | null;
      expect(card?.closest('#pnl-inbox')).toBeTruthy();
      expect(card?.textContent).toContain('CRM login expired');
    });
  });

  it('expanding a job lists its last runs from the route', async () => {
    await openJobs();
    const fb = within(pane()).getByRole('region', { name: 'Feedback · Titan' });
    const open = within(fb).getByRole('button', { name: /Read feedback, draft replies/ });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await click(open);
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(runRoute.mock.calls.map(([u]) => u)).toContain('/api/jobs/j-replies/runs?limit=20');
    const list = await within(fb).findByRole('list', {
      name: 'runs of Read feedback, draft replies',
    });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/^↻ .*\(caught up after sleep\) — 9 messages/);
    expect(items[1]!.textContent).toMatch(/^✕ .* — could not reach the feedback API/);
    await click(open);
    expect(within(fb).queryByRole('list', { name: /^runs of/ })).toBeNull();
  });

  it('filtered to a moon: a header naming its areas and "Show all jobs"', async () => {
    await openJobs();
    await act(async () => useJobsFilter.getState().set('b-titan'));
    expect(within(pane()).getByRole('heading', { name: 'Feedback, Sales · Titan' })).toBeTruthy();
    await click(within(pane()).getByRole('button', { name: 'Show all jobs' }));
    expect(useJobsFilter.getState().bodyId).toBeUndefined();
    expect(within(pane()).queryByRole('button', { name: 'Show all jobs' })).toBeNull();
  });

  it('a Gemini job with no follow-up provider says it cannot publish; others do not (R22)', async () => {
    const snap = snapshot() as ServerMessage & { type: 'snapshot' };
    useAppStore.getState().apply({
      ...snap,
      jobs: [
        { ...replies, provider: 'gemini' },
        { ...pipeline, provider: 'gemini', followUpProvider: 'chatgpt' },
      ],
    });
    render(
      <ApiContext.Provider value={{ jobRuns: async () => ({ runs }) } as unknown as Api}>
        <JobsPane projectId="p-shop" />
      </ApiContext.Provider>,
    );
    expect(screen.getAllByText('Publishes with: nobody — Gemini cannot publish')).toHaveLength(1);
    expect(screen.getAllByText(/^Gemini · /).length).toBe(2);
  });

  it('passes axe', async () => {
    useAppStore.getState().apply(snapshot());
    const api = { jobRuns: async () => ({ runs }) } as unknown as Api;
    const { container } = render(
      <ApiContext.Provider value={api}>
        <JobsPane projectId="p-shop" />
      </ApiContext.Provider>,
    );
    await click(screen.getByRole('button', { name: /Read feedback, draft replies/ }));
    await screen.findByRole('list', { name: /^runs of/ });
    expect(blocking(await axeFindings(container))).toEqual([]);
  });

  describe('on a phone', () => {
    beforeEach(() => stubMedia([COMPACT_TOP_BAR_QUERY, STACKED_LAYOUT_QUERY]));

    it('fills the chat area like the other dock views', async () => {
      await openJobs();
      const holder = pane().closest('.sts-pane')!;
      expect(holder.classList.contains('sts-pane-status')).toBe(true);
      expect(holder.closest('.pnl-dock-body')).toBeTruthy();
      expect(document.querySelector('.sts-pane-chat')!.classList.contains('is-hidden')).toBe(true);
    });

    it('never scrolls sideways: nothing has a fixed width and long words wrap', () => {
      const css = readFileSync(resolve(import.meta.dirname, 'jobs.css'), 'utf8');
      // No fixed widths at all (a phone is 320px+): only max-width/min-width: 0 style rules.
      expect(css).not.toMatch(/(^|[\s;{])width:\s*\d/m);
      expect(css).not.toMatch(/min-width:\s*[1-9]/);
      expect(css).not.toMatch(/white-space:\s*nowrap/);
      expect(css).not.toMatch(/overflow-x:\s*(scroll|auto)/);
      expect(css).toMatch(/\.jobs\s*\{[^}]*min-width:\s*0/);
      expect(css).toMatch(/overflow-wrap:\s*anywhere/);
    });
  });
});
