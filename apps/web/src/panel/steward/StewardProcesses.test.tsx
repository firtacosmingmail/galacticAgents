// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StewardProcess, StewardProcessesResponse } from '@galactic/protocol';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { StewardProcesses } from './StewardProcesses.js';

/** The Steward view's leftover processes (P4-14): the line, the list, the confirmed stop. */

const proc = (pid: number, ports: number[] = []): StewardProcess => ({
  pid,
  ppid: 1,
  command: `node server-${pid}.js`,
  ports,
  startedAt: '2026-10-04T10:00:00.000Z',
  why: 'worktree',
});

function fakeApi(initial: StewardProcess[]) {
  let current = initial;
  const api = {
    processes: vi.fn(async (agentId: string): Promise<StewardProcessesResponse> => ({
      agentId,
      supported: true,
      processes: current,
    })),
    stopProcesses: vi.fn(async (agentId: string) => {
      const stopped = current.map((p) => p.pid);
      current = [];
      return { agentId, stopped, forced: [], alive: [] };
    }),
  };
  return api;
}

function show(api: ReturnType<typeof fakeApi>, state = 'idle') {
  return render(
    <ApiContext.Provider value={api as unknown as Api}>
      <StewardProcesses agentId="a-st" state={state} />
    </ApiContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('StewardProcesses (P4-14)', () => {
  it('shows nothing when nothing runs', async () => {
    const api = fakeApi([]);
    show(api);
    await vi.waitFor(() => expect(api.processes).toHaveBeenCalledWith('a-st'));
    expect(screen.queryByRole('region', { name: 'processes still running' })).toBeNull();
  });

  it('shows how many run, lists them, and stops them all after a confirmation', async () => {
    const api = fakeApi([proc(4242, [5173]), proc(4243)]);
    show(api);
    const region = await screen.findByRole('region', { name: 'processes still running' });
    expect(region.textContent).toMatch(/2 processes still running/);
    expect(region.textContent).toMatch(/node server-4242\.js/);
    expect(region.textContent).toMatch(/port 5173/);

    fireEvent.click(screen.getByRole('button', { name: 'Stop them' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep them running' }));
    expect(api.stopProcesses).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop them' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    });
    expect(api.stopProcesses).toHaveBeenCalledWith('a-st');
    await vi.waitFor(() =>
      expect(screen.queryByRole('region', { name: 'processes still running' })).toBeNull(),
    );
  });

  it('reads the list again when the state changes', async () => {
    const api = fakeApi([proc(4242)]);
    const view = show(api, 'working');
    await screen.findByText(/1 process still running/);
    const before = api.processes.mock.calls.length;
    view.rerender(
      <ApiContext.Provider value={api as unknown as Api}>
        <StewardProcesses agentId="a-st" state="finished" />
      </ApiContext.Provider>,
    );
    await vi.waitFor(() => expect(api.processes.mock.calls.length).toBeGreaterThan(before));
  });
});
