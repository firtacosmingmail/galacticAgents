// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalMark, Project, StandingApproval } from '@galactic/protocol';
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
  removeApprovalMark: ReturnType<typeof vi.fn>;
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
    removeApprovalMark: vi.fn(async () => ({ ok: true })),
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
  it('shows three choices, Off checked, and choosing the task one calls the route', async () => {
    show(fx.project);
    const group = screen.getByRole('radiogroup', { name: "Waykeeper approves Stewards' requests" });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect((screen.getByRole('radio', { name: 'Off' }) as HTMLInputElement).checked).toBe(true);
    await act(async () =>
      fireEvent.click(screen.getByRole('radio', { name: 'Only what fits the task' })),
    );
    expect(api.setWaykeeperApprovals).toHaveBeenCalledWith('p-1', true, false);
  });

  it('shows Auto checked for an Auto project, and Off turns it off', async () => {
    show({ ...fx.project, waykeeperApprovals: true, waykeeperAuto: true });
    expect(
      (screen.getByRole('radio', { name: /^Auto: everything except/ }) as HTMLInputElement).checked,
    ).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole('radio', { name: 'Off' })));
    expect(api.setWaykeeperApprovals).toHaveBeenCalledWith('p-1', false);
  });

  it('shows the task choice checked when on without Auto, and Auto calls (true, true)', async () => {
    show({ ...fx.project, waykeeperApprovals: true });
    expect(
      (screen.getByRole('radio', { name: 'Only what fits the task' }) as HTMLInputElement).checked,
    ).toBe(true);
    await act(async () =>
      fireEvent.click(screen.getByRole('radio', { name: /^Auto: everything except/ })),
    );
    expect(api.setWaykeeperApprovals).toHaveBeenCalledWith('p-1', true, true);
  });

  it('shows the server’s message next to the switch when a remote “on” is refused', async () => {
    api.setWaykeeperApprovals.mockRejectedValueOnce(
      new ApiError(403, 'Turn this on from the Mac itself.', 'remote_control'),
    );
    show(fx.project, PHONE);
    await act(async () =>
      fireEvent.click(screen.getByRole('radio', { name: 'Only what fits the task' })),
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

describe('the "Always asks me" marks (P13-17)', () => {
  const mark: ApprovalMark = {
    id: 'm-1',
    projectId: 'p-1',
    match: { kind: 'folder', category: 'destructive', paths: ['/w/node_modules'] },
    example: 'rm -rf /w/node_modules',
    createdBy: { type: 'user' },
    createdAt: fx.NOW,
    origin: 'local',
    fromSeq: 4,
  };

  it('lists a mark with its words and example, and Remove calls the route', async () => {
    show({ ...fx.project, approvalMarks: [mark] });
    const list = screen.getByRole('list', { name: 'always asks me' });
    expect(list.textContent).toMatch(/deletes in \/w\/node_modules/);
    expect(list.textContent).toContain('from “rm -rf /w/node_modules”');
    expect(screen.getByText('Always asks me (1)')).toBeTruthy();
    await act(async () => fireEvent.click(within(list).getByRole('button', { name: /^Remove/ })));
    expect(api.removeApprovalMark).toHaveBeenCalledWith('p-1', 'm-1');
  });

  it('says when and by whom a mark was added, as standing approvals do', () => {
    show({
      ...fx.project,
      approvalMarks: [mark, { ...mark, id: 'm-2', origin: 'remote' }],
    });
    const items = within(screen.getByRole('list', { name: 'always asks me' })).getAllByRole(
      'listitem',
    );
    expect(items[0]!.textContent).toMatch(/added .+/);
    expect(items[0]!.textContent).not.toContain('from a remote client');
    expect(items[1]!.textContent).toContain('from a remote client');
  });

  it('shows nothing about marks when there are none', () => {
    show(fx.project);
    expect(screen.queryByText(/Always asks me/)).toBeNull();
  });
});
