// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StewardProcess, StewardProcessesResponse } from '@galactic/protocol';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { StewardProcesses } from './StewardProcesses.js';

/** The Steward view's leftover processes (P4-14): the line, the list, the confirmed stop of what it showed. */

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
    stopProcesses: vi.fn(async (agentId: string, pids?: number[]) => {
      const stopped = current.filter((p) => pids?.includes(p.pid)).map((p) => p.pid);
      current = current.filter((p) => !stopped.includes(p.pid));
      return { agentId, stopped, forced: [], alive: [] };
    }),
    set: (next: StewardProcess[]) => {
      current = next;
    },
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

  it('shows how many run, lists them, and stops exactly the ones it showed after a confirmation', async () => {
    const api = fakeApi([proc(4242, [5173]), proc(4243)]);
    show(api);
    const region = await screen.findByRole('region', { name: 'processes still running' });
    expect(region.textContent).toMatch(/2 processes still running/);
    expect(region.textContent).toMatch(/node server-4242\.js/);
    expect(region.textContent).toMatch(/port 5173/);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop them' }));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Keep them running' }));
    expect(api.stopProcesses).not.toHaveBeenCalled();

    // Something new started meanwhile: "Stop" reads the list again and shows what it will stop.
    api.set([proc(4242, [5173]), proc(4243), proc(4244)]);
    const reads = api.processes.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop them' }));
    });
    expect(api.processes.mock.calls.length).toBe(reads + 1);
    const confirmation = await screen.findByText(/Stop these 3 processes/);
    expect(confirmation.textContent).toMatch(/4244 node server-4244\.js/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    });
    expect(api.stopProcesses).toHaveBeenCalledWith('a-st', [4242, 4243, 4244]);
    await vi.waitFor(() =>
      expect(screen.queryByRole('region', { name: 'processes still running' })).toBeNull(),
    );
  });

  it("leaves what a running Steward's session uses out of the bulk stop; each has its own", async () => {
    const api = fakeApi([
      proc(4242),
      { ...proc(4250), command: 'npx @playwright/mcp', held: true },
    ]);
    show(api, 'working');
    const region = await screen.findByRole('region', { name: 'processes still running' });
    expect(region.textContent).toMatch(/in use by the Steward/);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop the 1 not in use' }));
    });
    expect((await screen.findByText(/Stop this process/)).textContent).not.toMatch(/4250/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    });
    expect(api.stopProcesses).toHaveBeenLastCalledWith('a-st', [4242]);

    api.set([{ ...proc(4250), command: 'npx @playwright/mcp', held: true }]);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Stop 4250' }));
    });
    expect((await screen.findByText(/Stop this process/)).textContent).toMatch(
      /the Steward is using it/,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }));
    });
    expect(api.stopProcesses).toHaveBeenLastCalledWith('a-st', [4250]);
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
