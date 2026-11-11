// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyWorld, type Job, type JobRun, type Panel } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { stubMedia } from '../../a11y/a11y-fixtures.js';
import { COMPACT_TOP_BAR_QUERY } from '../use-media-query.js';
import { useAppStore } from '../../state/store.js';
import { useDockView } from '../status/dock-view.js';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { JobMap } from './JobMap.js';

const map = {
  sources: [{ id: 'crm', label: 'CRM', kind: 'site', target: 'https://crm.example' }],
  collects: [{ name: 'Churn', kind: 'number', sourceIds: ['crm'], description: 'churn' }],
  steps: [{ text: 'Count the lost customers', uses: ['crm'], produces: ['Churn'] }],
} as unknown as Job['dataMap'];
const job = { ...fx.job, id: 'j-1', projectId: 'p-shop', name: 'Count churn', dataMap: map } as Job;
const panel = {
  ...fx.panel,
  id: 'pn-1',
  projectId: 'p-shop',
  title: 'Churn tile',
  source: { kind: 'job', jobId: 'j-1', values: ['Churn'] },
} as Panel;

function open(over: Partial<Job> = {}, runs: JobRun[] = []) {
  const j = { ...job, ...over } as Job;
  useAppStore.setState({
    world: { ...emptyWorld(), jobs: { [j.id]: j }, panels: { [panel.id]: panel } },
  } as never);
  const onClose = vi.fn();
  const api = { jobRuns: async () => ({ runs }) } as unknown as Api;
  render(
    <ApiContext.Provider value={api}>
      <JobMap jobId={j.id} onClose={onClose} />
    </ApiContext.Provider>,
  );
  return onClose;
}

beforeEach(() => useDockView.getState().reload());
afterEach(cleanup);

describe('JobMap', () => {
  it('renders the four column titles', async () => {
    open();
    for (const t of ['Gathers from', 'Collects', 'Processes', 'Shown in'])
      expect(await screen.findByRole('heading', { name: t })).toBeTruthy();
  });

  it('a panel chip switches to the Dashboard view and asks for that panel', async () => {
    const onClose = open();
    fireEvent.click(await screen.findByRole('button', { name: /Churn tile/ }));
    expect(useDockView.getState().view).toBe('dashboard');
    expect(useDockView.getState().focusPanelId).toBe('pn-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape closes it even when focus is on plain text (the body)', async () => {
    const onClose = open();
    await screen.findByRole('dialog');
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Tab cannot leave the dialog', async () => {
    open();
    await screen.findByRole('dialog');
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });

  it('a second tap on a node unlights it even while it keeps focus and hover', async () => {
    open();
    const crm = (await screen.findByText('CRM')).closest('button')!;
    act(() => crm.focus());
    fireEvent.mouseEnter(crm);
    fireEvent.click(crm);
    expect(crm.classList.contains('is-lit')).toBe(true);
    expect(crm.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(crm);
    expect(crm.getAttribute('aria-pressed')).toBe('false');
    expect(crm.classList.contains('is-lit')).toBe(false);
    expect(screen.getByRole('dialog').classList.contains('is-highlighting')).toBe(false);
  });

  it('on a phone the columns stack: links are listed as text and no SVG is drawn', async () => {
    stubMedia([COMPACT_TOP_BAR_QUERY]);
    open();
    await screen.findByRole('dialog');
    expect(screen.getAllByText('→ Churn').length).toBeGreaterThan(0);
    expect(document.querySelector('svg.jm-lines')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('Escape and Close both close it', async () => {
    const onClose = open();
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows the empty-map message and only what the last good run used', async () => {
    open({ dataMap: undefined } as never, [
      {
        ...fx.jobRun,
        jobId: 'j-1',
        outcome: 'quiet',
        sources: [{ kind: 'mcp', target: 'appstore' }],
      } as JobRun,
    ]);
    expect(
      await screen.findByText('This job has no data map yet — ask the Waykeeper to add one'),
    ).toBeTruthy();
    expect(await screen.findByText('appstore')).toBeTruthy();
  });

  it('says "problem" in words for a source with a problem', async () => {
    open({}, [
      {
        ...fx.jobRun,
        jobId: 'j-1',
        sources: [{ kind: 'site', target: 'https://crm.example' }],
        data: { sourceProblems: [{ sourceId: 'crm', problem: 'login expired' }] },
      } as JobRun,
    ]);
    expect(await screen.findByText('login expired')).toBeTruthy();
    expect(screen.getByText('problem')).toBeTruthy();
  });

  it('reads the recent runs: a failed newest run leaves the last good run to judge sources', async () => {
    const jobRuns = vi.fn(async () => ({
      runs: [
        { ...fx.jobRun, id: 'jr-9', jobId: 'j-1', outcome: 'failed' },
        {
          ...fx.jobRun,
          id: 'jr-8',
          jobId: 'j-1',
          outcome: 'quiet',
          sources: [{ kind: 'mcp', target: 'appstore' }],
        },
      ] as JobRun[],
    }));
    useAppStore.setState({
      world: { ...emptyWorld(), jobs: { [job.id]: job }, panels: { [panel.id]: panel } },
    } as never);
    render(
      <ApiContext.Provider value={{ jobRuns } as unknown as Api}>
        <JobMap jobId={job.id} onClose={() => {}} />
      </ApiContext.Provider>,
    );
    expect(await screen.findByText('not used by the last good run')).toBeTruthy();
    expect(jobRuns).toHaveBeenCalledWith(job.id, 10);
  });

  it('Clear stored values lists the panels reading the job, says it cannot be undone, and clears once', async () => {
    const other = { ...panel, id: 'pn-2', title: 'Churn line' } as Panel;
    const elsewhere = {
      ...panel,
      id: 'pn-3',
      title: 'Another job',
      source: { kind: 'job', jobId: 'j-9', values: ['x'] },
    } as Panel;
    useAppStore.setState({
      world: {
        ...emptyWorld(),
        jobs: { [job.id]: job },
        panels: { [panel.id]: panel, [other.id]: other, [elsewhere.id]: elsewhere },
      },
    } as never);
    const clearJobValues = vi.fn(async () => ({ panels: [panel.id, other.id] }));
    const api = { jobRuns: async () => ({ runs: [] }), clearJobValues } as unknown as Api;
    render(
      <ApiContext.Provider value={api}>
        <JobMap jobId={job.id} onClose={() => {}} />
      </ApiContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Clear stored values' }));
    const confirm = screen.getByRole('group', { name: 'Clear stored values' });
    expect(confirm.textContent).toContain('Churn tile');
    expect(confirm.textContent).toContain('Churn line');
    expect(confirm.textContent).not.toContain('Another job');
    expect(confirm.textContent).toContain("can't be undone");
    expect(clearJobValues).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Clear stored values' }));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Clear stored values' })).toBeNull(),
    );
    expect(clearJobValues).toHaveBeenCalledTimes(1);
    expect(clearJobValues).toHaveBeenCalledWith(job.id);
  });

  it('Clear stored values on a job no panel reads says so; Cancel clears nothing', async () => {
    const clearJobValues = vi.fn();
    useAppStore.setState({
      world: { ...emptyWorld(), jobs: { [job.id]: job }, panels: {} },
    } as never);
    render(
      <ApiContext.Provider
        value={{ jobRuns: async () => ({ runs: [] }), clearJobValues } as unknown as Api}
      >
        <JobMap jobId={job.id} onClose={() => {}} />
      </ApiContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Clear stored values' }));
    const confirm = screen.getByRole('group', { name: 'Clear stored values' });
    expect(confirm.textContent).toContain('No panels read this job.');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Clear stored values' })).toBeNull();
    expect(clearJobValues).not.toHaveBeenCalled();
  });

  it('highlights on focus and dims the rest', async () => {
    open();
    const crm = (await screen.findByText('CRM')).closest('button')!;
    act(() => crm.focus());
    expect(crm.classList.contains('is-lit')).toBe(true);
    expect(screen.getByRole('dialog').classList.contains('is-highlighting')).toBe(true);
  });
});
