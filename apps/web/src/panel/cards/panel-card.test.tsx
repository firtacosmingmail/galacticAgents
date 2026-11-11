// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  emptyWorld,
  type Agent,
  type Body,
  type JobDataMap,
  type JobDraft,
  type Panel,
  type PanelDraft,
  type Project,
  type Proposal,
  type ProposalJob,
  type ProposalPanel,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { RulesContext } from '../deliverables/use-deliverables.js';
import { ProposalCard } from './ProposalCard.js';

/**
 * P15-08 (SPEC decision 156): a Waykeeper's panel card (add, change or remove a panel, with its
 * job part), and the job card's "Panels affected" list for a stop or a change that drops data.
 */

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
const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-wk-shop',
  role: 'waykeeper',
  projectId: 'p-shop',
  bodyId: 'b-saturn',
};

const dataMap: JobDataMap = {
  sources: [{ id: 'shop_db', label: 'Shop database', kind: 'database', target: 'shop.sqlite' }],
  collects: [
    { name: 'orders', kind: 'number', sourceIds: ['shop_db'], description: 'Orders today' },
  ],
  steps: [{ text: 'Count the orders placed today', uses: ['shop_db'], produces: ['orders'] }],
};
const jobDraft: JobDraft = {
  name: 'Count orders',
  instructions: 'Count the orders.',
  schedule: { kind: 'daily', at: '08:00' },
  provider: 'claude',
  unattendedRules: [
    {
      scope: 'prefix',
      tool: 'Bash',
      match: { kind: 'words', words: ['sqlite3'] },
      categories: ['network'],
      label: 'sqlite3 …',
    },
  ],
  dataMap,
};
const panelDraft: PanelDraft = {
  type: 'tile',
  title: 'Orders today',
  source: { kind: 'job', jobId: 'j-1', values: ['orders'] },
  display: { format: 'number', unit: 'pcs' },
  limits: [{ value: 'orders', better: 'higher', veryBad: { op: 'below', value: 5 } }],
};

const panelCard = (panel: ProposalPanel, extra: Partial<Proposal> = {}): Proposal => ({
  id: `pr-panel-${panel.action}`,
  requestText: `${panel.action} a panel`,
  kind: 'planet',
  proposedBody: { kind: 'planet', bodyId: 'b-saturn', name: 'Saturn' },
  workspace: shop.workspace,
  rationale: 'The shop owner wants to see orders at a glance.',
  state: 'pending',
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
  meta: { panel },
  ...extra,
});

const base = { projectId: 'p-shop', waykeeperId: 'a-wk-shop' } as const;

let api: { decide: ReturnType<typeof vi.fn> };

function world(over: { panels?: Panel[] } = {}) {
  useAppStore.setState({
    world: {
      ...emptyWorld(),
      agents: { [waykeeper.id]: waykeeper },
      bodies: { [saturn.id]: saturn },
      projects: { [shop.id]: shop },
      panels: Object.fromEntries((over.panels ?? []).map((p) => [p.id, p])),
    },
  });
}

const show = (
  node: React.ReactNode,
  rules?: Parameters<typeof RulesContext.Provider>[0]['value'],
) =>
  render(
    <ApiContext.Provider value={api as unknown as Api}>
      {rules ? <RulesContext.Provider value={rules}>{node}</RulesContext.Provider> : node}
    </ApiContext.Provider>,
  );

beforeEach(() => {
  useAppStore.getState().reset();
  api = { decide: vi.fn(async () => ({ ok: true })) };
});
afterEach(() => cleanup());

describe('the panel card', () => {
  it('a card using an existing job shows the panel and says no job changes', async () => {
    const p = panelCard({ ...base, action: 'create', draft: panelDraft, job: { use: 'j-1' } });
    world();
    useAppStore.setState((s) => ({
      world: {
        ...s.world,
        jobs: { 'j-1': { ...fx.job, id: 'j-1', projectId: 'p-shop', name: 'Count orders' } },
      },
    }));
    show(<ProposalCard proposal={p} />);
    const card = screen.getByRole('article');
    within(card).getByText('New panel');
    within(card).getByText('Orders today');
    within(card).getByText(/tile/);
    expect(within(card).getAllByText(/orders/).length).toBeGreaterThan(0);
    within(card).getByText(/better: higher/);
    expect(card.textContent).toContain(
      "Filled by job 'Count orders', which already reports orders. No job changes.",
    );
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    expect(api.decide).toHaveBeenCalledWith(p.id, { decision: 'approve' });
    within(card).getByRole('button', { name: 'Reject' });
  });

  it('a card proposing a job shows its sources, collected values and steps', () => {
    const job: ProposalJob = {
      ...base,
      action: 'create',
      draft: jobDraft,
      area: { name: 'Orders' },
    };
    const p = panelCard({
      ...base,
      action: 'create',
      draft: { ...panelDraft, source: { kind: 'job', jobId: '$new', values: ['orders'] } },
      job: { propose: job },
    });
    world();
    show(<ProposalCard proposal={p} />);
    const card = screen.getByRole('article');
    within(card).getByText('Count orders');
    within(card).getByText(/Shop database/);
    within(card).getByText(/shop\.sqlite/);
    within(card).getByRole('list', { name: 'collected values' });
    within(card).getByText(/Count the orders placed today/);
  });

  it('a card whose job grants new rules cannot be approved on a phone, but can be refused', () => {
    const PHONE = { local: false, download: false, edit: false, addOutside: false };
    const p = panelCard({
      ...base,
      action: 'create',
      draft: { ...panelDraft, source: { kind: 'job', jobId: '$new', values: ['orders'] } },
      job: { propose: { ...base, action: 'create', draft: jobDraft, area: { name: 'Orders' } } },
    });
    world();
    show(<ProposalCard proposal={p} />, PHONE);
    const card = screen.getByRole('article');
    expect(
      (within(card).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    within(card).getByText(/Only the Mac/);
    expect(
      (within(card).getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('a removal shows the panel going away and the reason', () => {
    const p = panelCard(
      { ...base, action: 'remove', panelId: 'pn-1', before: panelDraft },
      { rationale: 'Nobody has looked at it for 28 days.' },
    );
    world();
    show(<ProposalCard proposal={p} />);
    const card = screen.getByRole('article');
    within(card).getByText('Remove panel');
    within(card).getByText('Orders today');
    within(card).getByText(/tile/);
    within(card).getByText('Nobody has looked at it for 28 days.');
  });

  it('a change shows before → after for what changed', () => {
    const p = panelCard({
      ...base,
      action: 'change',
      panelId: 'pn-1',
      before: panelDraft,
      draft: { ...panelDraft, title: 'Orders this week' },
      job: { use: 'j-1' },
    });
    world();
    show(<ProposalCard proposal={p} />);
    const card = screen.getByRole('article');
    within(card).getByText('Change panel');
    expect(within(card).getByRole('list', { name: 'changes' }).textContent).toContain(
      'title: Orders today → Orders this week',
    );
  });
});

describe('the job card lists the panels a stop affects', () => {
  const panel = (id: string, title: string): Panel =>
    ({
      ...fx.panel,
      id,
      projectId: 'p-shop',
      title,
      source: { kind: 'job', jobId: 'j-1', values: ['orders'] },
    }) as Panel;
  const before = { ...jobDraft, unattendedRules: [] };
  const stop = (): Proposal => ({
    ...panelCard({ ...base, action: 'create' }),
    id: 'pr-stop',
    meta: {
      job: {
        ...base,
        action: 'stop',
        jobId: 'j-1',
        before: { draft: before, areaId: 'ar-1' },
      } satisfies ProposalJob,
    },
  });

  it('lists 2 panels and ticking sends removePanels', async () => {
    world({ panels: [panel('pn-1', 'Orders today'), panel('pn-2', 'Orders per week')] });
    show(<ProposalCard proposal={stop()} />);
    const card = screen.getByRole('article');
    const list = within(card).getByRole('list', { name: 'Panels affected' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Orders today', 'Orders per week']);
    const tick = within(card).getByRole('checkbox', { name: 'Also remove these panels' });
    expect((tick as HTMLInputElement).checked).toBe(false);
    fireEvent.click(tick);
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    expect(api.decide).toHaveBeenCalledWith('pr-stop', {
      decision: 'approve',
      removePanels: true,
    });
  });

  it('unticked sends a plain approve, and no panels means no list', async () => {
    world({ panels: [panel('pn-1', 'Orders today')] });
    show(<ProposalCard proposal={stop()} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })));
    expect(api.decide).toHaveBeenCalledWith('pr-stop', { decision: 'approve' });
    cleanup();
    world();
    show(<ProposalCard proposal={stop()} />);
    expect(screen.queryByRole('list', { name: 'Panels affected' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a change that drops a value lists only the panels reading it; its data map shows', () => {
    const p: Proposal = {
      ...stop(),
      id: 'pr-change',
      meta: {
        job: {
          ...base,
          action: 'change',
          jobId: 'j-1',
          draft: { ...before, dataMap: { ...dataMap, collects: [], steps: [] } },
          before: { draft: { ...before, dataMap }, areaId: 'ar-1' },
        } satisfies ProposalJob,
      },
    };
    world({ panels: [panel('pn-1', 'Orders today')] });
    show(<ProposalCard proposal={p} />);
    within(screen.getByRole('list', { name: 'Panels affected' })).getByText('Orders today');
  });
});

describe('a panel card whose job part changes a job lists the other panels it orphans', () => {
  const panel = (id: string, title: string): Panel =>
    ({
      ...fx.panel,
      id,
      projectId: 'p-shop',
      title,
      source: { kind: 'job', jobId: 'j-1', values: ['orders'] },
    }) as Panel;
  const before = { ...jobDraft, unattendedRules: [] };
  const changing = (dropped: boolean): Proposal =>
    panelCard({
      ...base,
      action: 'change',
      panelId: 'pn-own',
      before: panelDraft,
      draft: {
        ...panelDraft,
        title: 'Visits',
        source: { kind: 'job', jobId: 'j-1', values: ['visits'] },
      },
      job: {
        propose: {
          ...base,
          action: 'change',
          jobId: 'j-1',
          draft: {
            ...before,
            dataMap: dropped
              ? {
                  ...dataMap,
                  collects: [
                    { name: 'visits', kind: 'number', sourceIds: ['shop_db'], description: '' },
                  ],
                  steps: [],
                }
              : dataMap,
          },
          before: { draft: { ...before, dataMap }, areaId: 'ar-1' },
        },
      },
    });

  it('lists them without the card’s own panel; ticking sends removePanels', async () => {
    world({ panels: [panel('pn-own', 'Orders today'), panel('pn-2', 'Orders per week')] });
    show(<ProposalCard proposal={changing(true)} />);
    const card = screen.getByRole('article');
    const list = within(card).getByRole('list', { name: 'Panels affected' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Orders per week']);
    const tick = within(card).getByRole('checkbox', { name: 'Also remove these panels' });
    expect((tick as HTMLInputElement).checked).toBe(false);
    fireEvent.click(tick);
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    expect(api.decide).toHaveBeenCalledWith('pr-panel-change', {
      decision: 'approve',
      removePanels: true,
    });
  });

  it('a job change that keeps the data map lists nothing and approves plainly', async () => {
    world({ panels: [panel('pn-own', 'Orders today'), panel('pn-2', 'Orders per week')] });
    show(<ProposalCard proposal={changing(false)} />);
    expect(screen.queryByRole('list', { name: 'Panels affected' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Approve' })));
    expect(api.decide).toHaveBeenCalledWith('pr-panel-change', { decision: 'approve' });
  });
});
