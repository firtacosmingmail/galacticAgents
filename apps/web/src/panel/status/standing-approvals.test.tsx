// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, StandingApproval } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { RulesContext } from '../deliverables/use-deliverables.js';
import type { ClientRules } from '../deliverables/deliverables-model.js';
import { StandingApprovals } from './StandingApprovals.js';

/** P13-06 (design §5.6): the project's switch and its standing approvals. */

const MAC: ClientRules = { local: true, download: true, edit: true, addOutside: true };
const PHONE: ClientRules = { local: false, download: true, edit: false, addOutside: false };
const standing: StandingApproval = {
  id: 'sa-1',
  projectId: fx.project.id,
  kind: 'run the test suite',
  examples: ['pnpm test', 'pnpm test --run'],
  createdBy: { type: 'user' },
  createdAt: fx.NOW,
  origin: 'local',
};
let api: {
  setWaykeeperApprovals: ReturnType<typeof vi.fn>;
  removeStandingApproval: ReturnType<typeof vi.fn>;
  historyEvents: ReturnType<typeof vi.fn>;
};

function show(project: Project, rules: ClientRules = MAC) {
  return render(
    <ApiContext.Provider value={api as unknown as Api}>
      <RulesContext.Provider value={rules}>
        <StandingApprovals project={project} />
      </RulesContext.Provider>
    </ApiContext.Provider>,
  );
}
beforeEach(() => {
  api = {
    setWaykeeperApprovals: vi.fn(async () => ({ ok: true })),
    removeStandingApproval: vi.fn(async () => ({ ok: true })),
    historyEvents: vi.fn(async () => ({
      projectId: 'p-1',
      events: [],
      seq: 0,
      hasMore: false,
    })),
  };
});
afterEach(() => cleanup());

describe('the Waykeeper approvals switch and standing approvals (P13-06)', () => {
  it('shows the switch off, and turning it on calls the route', async () => {
    show(fx.project);
    const box = screen.getByRole('checkbox', {
      name: "Waykeeper approves Stewards' requests",
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => fireEvent.click(box));
    expect(api.setWaykeeperApprovals).toHaveBeenCalledWith('p-1', true);
  });

  it('shows the switch on and turning it off calls the route', async () => {
    show({ ...fx.project, waykeeperApprovals: true });
    const box = screen.getByRole('checkbox', {
      name: "Waykeeper approves Stewards' requests",
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => fireEvent.click(box));
    expect(api.setWaykeeperApprovals).toHaveBeenCalledWith('p-1', false);
  });

  it('shows the server’s message next to the switch when a remote “on” is refused', async () => {
    api.setWaykeeperApprovals.mockRejectedValueOnce(
      new ApiError(403, 'Turn this on from the Mac itself.', 'remote_control'),
    );
    show(fx.project, PHONE);
    await act(async () =>
      fireEvent.click(
        screen.getByRole('checkbox', { name: "Waykeeper approves Stewards' requests" }),
      ),
    );
    expect(screen.getByRole('alert').textContent).toMatch(/Turn this on from the Mac itself\./);
  });

  it('lists the standing approvals with Remove', async () => {
    show({ ...fx.project, standingApprovals: [standing] });
    const list = screen.getByRole('list', { name: 'standing approvals' });
    expect(list.textContent).toMatch(/run the test suite/);
    expect(list.textContent).toMatch(/pnpm test/);
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Remove the standing approval run the test suite' }),
      ),
    );
    expect(api.removeStandingApproval).toHaveBeenCalledWith('p-1', 'sa-1');
  });

  it('lets the phone remove a standing approval too', async () => {
    show({ ...fx.project, standingApprovals: [standing] }, PHONE);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: /^Remove the standing approval/ })),
    );
    expect(api.removeStandingApproval).toHaveBeenCalledWith('p-1', 'sa-1');
  });

  it('says none when there are none', () => {
    show(fx.project);
    expect(screen.getByText(/No standing approvals yet/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'standing approvals' })).toBeNull();
  });
});

const decided = (
  seq: number,
  extra: object = {},
  by: object = { type: 'agent', id: 'a-wk' },
  decision = 'allow',
) => ({
  seq,
  at: `2026-11-09T10:0${seq}:00.000Z`,
  event: {
    type: 'permission.decided',
    agentId: fx.agent.id,
    toolCall: { toolName: 'Bash', input: { command: `pnpm test ${seq}` } },
    decision,
    reason: `reason ${seq}`,
    decidedBy: by,
    ...extra,
  },
});

describe('the count of Waykeeper approvals (P13-06)', () => {
  it('shows the count and lists them newest first on demand, as text', async () => {
    api.historyEvents.mockResolvedValueOnce({
      projectId: 'p-1',
      events: [
        decided(1),
        decided(2, { quote: 'run <b>the</b> tests' }),
        decided(3, {}, { type: 'system' }),
        decided(4, {}, { type: 'agent', id: 'a-wk' }, 'deny'),
      ],
      seq: 4,
      hasMore: false,
    });
    show(fx.project);
    expect(await screen.findByText(/The Waykeeper approved 2 requests/)).toBeTruthy();
    expect(api.historyEvents).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p-1', type: 'permission.decided' }),
    );
    expect(screen.queryByRole('list', { name: 'requests the Waykeeper approved' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Show them' })));
    const rows = screen
      .getByRole('list', { name: 'requests the Waykeeper approved' })
      .querySelectorAll('li');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toMatch(/Bash pnpm test 2/);
    expect(rows[0]!.textContent).toMatch(/reason 2/);
    expect(rows[0]!.textContent).toContain('you asked: “run <b>the</b> tests”');
    expect(rows[0]!.querySelector('b')).toBeNull();
    expect(rows[1]!.textContent).toMatch(/Bash pnpm test 1/);
  });

  it('says 0 requests with no toggle when there are none', async () => {
    show(fx.project);
    expect(await screen.findByText(/The Waykeeper approved 0 requests/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show them' })).toBeNull();
  });
});
