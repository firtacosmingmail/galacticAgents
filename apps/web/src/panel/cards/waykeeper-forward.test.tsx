// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question, RecordedApproval, WaykeeperForward } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { RulesContext } from '../deliverables/use-deliverables.js';
import type { ClientRules } from '../deliverables/deliverables-model.js';
import { QuestionCard } from './QuestionCard.js';

/**
 * P13-06 (design §5.6): a permission card the Waykeeper forwarded shows why, the command's parts
 * with the failing one marked, and — after three or more similar approvals — the standing-approval
 * button, on the Mac and on the phone alike.
 */

const recorded = (n: number): RecordedApproval => ({
  kind: 'run the test suite',
  summary: 'pnpm test',
  agentId: fx.agent.id,
  questionId: `q-old-${n}`,
  at: fx.NOW,
});
const forward: WaykeeperForward = {
  reason: 'it deletes a folder outside the worktree',
  kind: 'delete files',
  parts: [
    { text: 'pnpm test', categories: ['run_workspace'] },
    { text: 'rm -rf ../cache', categories: ['destructive'], outsideCwd: true },
  ],
  failingPart: 1,
};
const card = (waykeeper: WaykeeperForward | undefined, version = 4): Question => ({
  id: 'q-1',
  kind: 'permission',
  originAgentId: fx.agent.id,
  holder: { type: 'user' },
  status: 'open',
  context: {
    text: 'May I run Bash? pnpm test && rm -rf ../cache',
    toolCall: { toolName: 'Bash', input: { command: 'pnpm test && rm -rf ../cache' } },
    permissionAction: 'destructive',
    ...(waykeeper ? { waykeeper } : {}),
  },
  version,
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
});

const MAC: ClientRules = { local: true, download: true, edit: true, addOutside: true };
const PHONE: ClientRules = { local: false, download: true, edit: false, addOutside: false };

let api: { answer: ReturnType<typeof vi.fn>; standingApproval: ReturnType<typeof vi.fn> };

function show(q: Question, rules: ClientRules = MAC) {
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq: 5,
    agents: [fx.harmonizer, fx.agent],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [fx.project],
    tasks: [fx.task, fx.asteroidTask],
    questions: [q],
    proposals: [],
    statuses: [],
  });
  useAppStore.setState({ status: 'live' });
  return render(
    <ApiContext.Provider value={api as unknown as Api}>
      <RulesContext.Provider value={rules}>
        <QuestionCard question={q} />
      </RulesContext.Provider>
    </ApiContext.Provider>,
  );
}

beforeEach(() => {
  useAppStore.getState().reset();
  api = {
    answer: vi.fn(async () => ({ ok: true })),
    standingApproval: vi.fn(async () => ({ ok: true, approval: undefined })),
  };
});
afterEach(() => cleanup());

const BUTTON = /^Approved 3 times before — let the Waykeeper approve these$/;

describe('a card the Waykeeper forwarded (P13-06)', () => {
  it('says why, lists the parts and marks the failing one', async () => {
    show(card(forward));
    const article = screen.getByRole('article');
    expect(
      within(article).getByText(
        'The Waykeeper sent this to you: it deletes a folder outside the worktree',
      ),
    ).toBeTruthy();
    const list = within(article).getByRole('list', { name: 'the command’s parts' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe('pnpm test');
    expect(items[0]!.querySelector('code')).toBeTruthy();
    expect(items[1]!.textContent).toBe('rm -rf ../cache ← this part');
    expect(items[1]!.getAttribute('data-failing')).toBe('true');
    expect(within(article).queryByRole('button', { name: /let the Waykeeper/ })).toBeNull();
    // The usual buttons stay.
    expect(within(article).getByRole('button', { name: /^Allow/ })).toBeTruthy();
    expect(blocking(await axeFindings(article))).toEqual([]);
  });

  it('is absent from an ordinary permission card', () => {
    show(card(undefined));
    expect(screen.queryByText(/The Waykeeper sent this to you/)).toBeNull();
  });

  it('with three similar approvals offers the button and presses it with the card’s version', async () => {
    show(card({ ...forward, similar: [recorded(1), recorded(2), recorded(3)] }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: BUTTON })));
    expect(api.standingApproval).toHaveBeenCalledTimes(1);
    const [id, version, answerId] = api.standingApproval.mock.calls[0]!;
    expect(id).toBe('q-1');
    expect(version).toBe(4);
    expect(typeof answerId).toBe('string');
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('says so when the answer went through but no standing approval was stored', async () => {
    api.standingApproval.mockResolvedValueOnce({
      ok: true,
      notStored: 'approved; no standing approval stored: the switch is off',
    });
    show(card({ ...forward, similar: [recorded(1), recorded(2), recorded(3)] }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: BUTTON })));
    expect(screen.getByRole('status').textContent).toMatch(
      /approved; no standing approval stored: the switch is off/,
    );
  });

  it('shows a refusal of the button', async () => {
    api.standingApproval.mockRejectedValueOnce(new Error('already answered'));
    show(card({ ...forward, similar: [recorded(1), recorded(2), recorded(3)] }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: BUTTON })));
    expect(screen.getByRole('alert').textContent).toMatch(/already answered/);
  });

  it('renders the same block and button on the phone', async () => {
    show(card({ ...forward, similar: [recorded(1), recorded(2), recorded(3)] }), PHONE);
    const article = screen.getByRole('article');
    expect(within(article).getByText(/^The Waykeeper sent this to you: /)).toBeTruthy();
    expect(within(article).getAllByRole('listitem')[1]!.textContent).toMatch(/← this part$/);
    await act(async () => fireEvent.click(within(article).getByRole('button', { name: BUTTON })));
    expect(api.standingApproval).toHaveBeenCalledWith('q-1', 4, expect.any(String));
  });
});
