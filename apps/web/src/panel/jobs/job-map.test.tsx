// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyWorld, type Job, type JobRun, type Panel } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
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

  it('Escape and Close both close it', async () => {
    const onClose = open();
    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('shows the empty-map message and only what the last run used', async () => {
    open({ dataMap: undefined } as never, [
      { ...fx.jobRun, jobId: 'j-1', sources: [{ kind: 'mcp', target: 'appstore' }] } as JobRun,
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

  it('highlights on focus and dims the rest', async () => {
    open();
    const crm = (await screen.findByText('CRM')).closest('button')!;
    act(() => crm.focus());
    expect(crm.classList.contains('is-lit')).toBe(true);
    expect(screen.getByRole('dialog').classList.contains('is-highlighting')).toBe(true);
  });
});
