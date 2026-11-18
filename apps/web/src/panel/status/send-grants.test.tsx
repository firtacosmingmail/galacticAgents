// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, SendGrant } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { RulesContext } from '../deliverables/use-deliverables.js';
import type { ClientRules } from '../deliverables/deliverables-model.js';
import { SendGrants } from './SendGrants.js';
import { StandingApprovals } from './StandingApprovals.js';

/**
 * P13-30 (design 2026-11-18 §4.3 "Shown"): a scope's send grants — the summary, the user's words,
 * the end, how often they were used, Remove, "paused" while Auto is off, "from the phone".
 */

const MAC: ClientRules = { local: true, download: true, edit: true, addOutside: true };
const NOW = new Date('2026-11-19T10:00:00.000Z');
const HOUR = 3_600_000;
const grant = (over: Partial<SendGrant> = {}): SendGrant => ({
  id: 'sg-1',
  projectId: fx.project.id,
  words: 'yes, post them today',
  summary: 'Instagram posts as @myshop, today',
  createdAt: fx.NOW,
  createdBy: { type: 'user' },
  origin: 'local',
  questionId: 'q-1',
  ...over,
});

let api: {
  removeSendGrant: ReturnType<typeof vi.fn>;
  historyEvents: ReturnType<typeof vi.fn>;
  setWaykeeperApprovals: ReturnType<typeof vi.fn>;
};

function list(
  grants: SendGrant[],
  opts: {
    projectId?: string | undefined;
    autoOn?: boolean;
    uses?: ReadonlyMap<string, number>;
  } = {},
) {
  return render(
    <ApiContext.Provider value={api as unknown as Api}>
      <SendGrants
        grants={grants}
        projectId={'projectId' in opts ? opts.projectId : fx.project.id}
        autoOn={opts.autoOn ?? true}
        uses={opts.uses ?? new Map()}
      />
    </ApiContext.Provider>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  api = {
    removeSendGrant: vi.fn(async () => ({ ok: true })),
    historyEvents: vi.fn(async () => ({ projectId: 'p-1', events: [], seq: 0, hasMore: false })),
    setWaykeeperApprovals: vi.fn(async () => ({ ok: true })),
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('send grants (P13-30)', () => {
  it('shows the summary, the words and the local end time, and how often it was used', () => {
    const endsAt = new Date(NOW.getTime() + 5 * HOUR).toISOString();
    list([grant({ endsAt })], { uses: new Map([['sg-1', 3]]) });
    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain(
      `"Instagram posts as @myshop, today" · "yes, post them today" · ends ${new Date(endsAt).toLocaleString()}`,
    );
    expect(row.textContent).toContain('used 3×');
    expect(row.textContent).not.toContain('paused');
    expect(row.textContent).not.toContain('from the phone');
  });

  it('says "no end" for a grant without one, and used 0× when the log has none', () => {
    list([grant()]);
    const row = screen.getByRole('listitem');
    expect(row.textContent).toContain(
      '"Instagram posts as @myshop, today" · "yes, post them today" · no end',
    );
    expect(row.textContent).toContain('used 0×');
  });

  it('marks a grant paused while Auto is off', () => {
    list([grant()], { autoOn: false });
    expect(screen.getByText('paused (Auto is off)')).toBeTruthy();
  });

  it('says "from the phone" for a grant made from a remote client', () => {
    list([grant({ origin: 'remote' })]);
    expect(screen.getByText('from the phone')).toBeTruthy();
  });

  it('does not show an expired grant', () => {
    const past = new Date(NOW.getTime() - HOUR).toISOString();
    const { container } = list([grant({ endsAt: past })]);
    expect(container.textContent).toBe('');
  });

  it('Remove calls the API for a project’s grant and for a standalone one', async () => {
    list([grant()]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Remove/ })));
    expect(api.removeSendGrant).toHaveBeenCalledWith(fx.project.id, 'sg-1');
    cleanup();
    list([grant({ id: 'sg-2', projectId: undefined })], { projectId: undefined });
    const button = screen.getByRole('button', { name: /Remove/ });
    expect(button.textContent).toBe('Remove');
    await act(async () => fireEvent.click(button));
    expect(api.removeSendGrant).toHaveBeenLastCalledWith(undefined, 'sg-2');
  });

  it('shows the refusal next to the list when removing fails', async () => {
    api.removeSendGrant.mockRejectedValueOnce(new ApiError(404, 'no send grant sg-1', 'not_found'));
    list([grant()]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Remove/ })));
    expect(screen.getByRole('alert').textContent).toMatch(/no send grant sg-1/);
  });
});

describe('a project’s grants next to its marks (P13-30)', () => {
  function show(project: Project) {
    return render(
      <ApiContext.Provider value={api as unknown as Api}>
        <RulesContext.Provider value={MAC}>
          <StandingApprovals project={project} />
        </RulesContext.Provider>
      </ApiContext.Provider>,
    );
  }

  it('lists the grants, paused when the project is not in Auto', async () => {
    show({ ...fx.project, sendGrants: [grant()] });
    const grants = await screen.findByRole('list', { name: 'send grants' });
    expect(within(grants).getByText('paused (Auto is off)')).toBeTruthy();
  });

  it('counts the uses from the approvals log', async () => {
    const decided = (seq: number, grantId: string) => ({
      seq,
      at: fx.NOW,
      event: {
        type: 'permission.decided',
        agentId: fx.agent.id,
        toolCall: { toolName: 'Bash', input: { command: 'curl -X POST x' } },
        decision: 'allow',
        decidedBy: { type: 'agent', id: 'a-wk' },
        waykeeperApproval: true,
        allowedBy: 'grant',
        grantId,
      },
    });
    api.historyEvents.mockResolvedValueOnce({
      projectId: fx.project.id,
      events: [decided(1, 'sg-1'), decided(2, 'sg-1'), decided(3, 'sg-other')],
      seq: 3,
      hasMore: false,
    });
    show({
      ...fx.project,
      waykeeperApprovals: true,
      waykeeperAuto: true,
      sendGrants: [grant()],
    });
    const grants = await screen.findByRole('list', { name: 'send grants' });
    expect(await within(grants).findByText('used 2×')).toBeTruthy();
    expect(within(grants).queryByText('paused (Auto is off)')).toBeNull();
  });
});
