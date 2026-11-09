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
