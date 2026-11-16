import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { ApprovalsLog } from './ApprovalsLog.js';

/** P13-17 (design 2026-11-14 §4.4): the Waykeeper's approvals, grouped by category. */

const NOW = new Date('2026-11-14T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
let api: {
  historyEvents: ReturnType<typeof vi.fn>;
  addApprovalMark: ReturnType<typeof vi.fn>;
};

const decided = (
  seq: number,
  at: string,
  extra: object = {},
  by: object = { type: 'agent', id: 'a-wk' },
  decision = 'allow',
) => ({
  seq,
  at,
  event: {
    type: 'permission.decided',
    agentId: fx.agent.id,
    toolCall: { toolName: 'Bash', input: { command: `pnpm test ${seq}` } },
    decision,
    reason: `reason ${seq}`,
    decidedBy: by,
    waykeeperApproval: true,
    ...extra,
  },
});
const part = (text: string, categories: string[]) => ({ text, categories });
function history(events: object[]) {
  api.historyEvents.mockResolvedValueOnce({
    projectId: 'p',
    events,
    seq: events.length,
    hasMore: false,
  });
}
function show() {
  return render(
    <ApiContext.Provider value={api as unknown as Api}>
      <ApprovalsLog project={{ ...fx.project, id: 'p' }} />
    </ApiContext.Provider>,
  );
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  api = {
    historyEvents: vi.fn(async () => ({ projectId: 'p', events: [], seq: 0, hasMore: false })),
    addApprovalMark: vi.fn(async () => ({ ok: true })),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the approvals log by category (P13-17)', () => {
  it('groups by category in order, closed, with counts', async () => {
    history([
      decided(1, daysAgo(1), { action: 'run_workspace' }),
      decided(2, daysAgo(1), { parts: [part('curl a', ['network'])] }),
      decided(3, daysAgo(1), { parts: [part('rm x', ['destructive'])] }),
      decided(4, daysAgo(1), { parts: [part('curl b', ['network'])] }),
    ]);
    show();
    const buttons = await screen.findAllByRole('button', { expanded: false });
    expect(buttons.map((b) => b.textContent)).toEqual([
      'Deletes · 1',
      'Network · 2',
      'Run commands · 1',
    ]);
    expect(screen.queryByText(/pnpm test/)).toBeNull();
  });

  it('opens a group and lists its entries newest first, as text', async () => {
    history([
      decided(2, daysAgo(2), { parts: [part('a', ['network'])], quote: '<b>x</b>' }),
      decided(5, daysAgo(1), { parts: [part('b', ['network'])] }),
    ]);
    show();
    const group = await screen.findByRole('button', { name: 'Network · 2' });
    await act(async () => fireEvent.click(group));
    expect(group.getAttribute('aria-expanded')).toBe('true');
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toMatch(/pnpm test 5/);
    expect(items[1]!.textContent).toMatch(/pnpm test 2/);
    expect(items[1]!.textContent).toMatch(/reason 2/);
    expect(items[1]!.querySelector('b')).toBeNull();
  });

  it('counts only the Waykeeper’s approvals', async () => {
    history([
      decided(1, daysAgo(1)),
      decided(2, daysAgo(1), { waykeeperApproval: undefined }),
      decided(3, daysAgo(1), {}, { type: 'system' }),
      decided(4, daysAgo(1), {}, { type: 'agent', id: 'a-wk' }, 'deny'),
    ]);
    show();
    expect(await screen.findByRole('button', { name: 'Run commands · 1' })).toBeTruthy();
  });

  it('offers Ask me next time on a 3-day-old entry only, and marks it', async () => {
    history([
      decided(7, daysAgo(3), { parts: [part('a', ['network'])] }),
      decided(8, daysAgo(11), { parts: [part('b', ['network'])] }),
    ]);
    show();
    const group = await screen.findByRole('button', { name: 'Network · 2' });
    await act(async () => fireEvent.click(group));
    const items = screen.getAllByRole('listitem');
    // seq 8 is 11 days old, seq 7 is 3 days old
    const old = items.find((li) => /pnpm test 8/.test(li.textContent ?? ''))!;
    const fresh = items.find((li) => /pnpm test 7/.test(li.textContent ?? ''))!;
    expect(within(old).queryByRole('button')).toBeNull();
    await act(async () =>
      fireEvent.click(within(fresh).getByRole('button', { name: 'Ask me next time' })),
    );
    expect(api.addApprovalMark).toHaveBeenCalledWith('p', 7);
    expect(within(fresh).getByText('Marked')).toBeTruthy();
  });

  it('shows the refusal next to the entry when marking fails', async () => {
    api.addApprovalMark.mockRejectedValueOnce(new ApiError(400, 'Too old to mark.', 'invalid'));
    history([decided(7, daysAgo(3))]);
    show();
    const group = await screen.findByRole('button', { name: 'Run commands · 1' });
    await act(async () => fireEvent.click(group));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Ask me next time' })),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/Too old to mark\./);
    expect(screen.queryByText('Marked')).toBeNull();
  });
});
