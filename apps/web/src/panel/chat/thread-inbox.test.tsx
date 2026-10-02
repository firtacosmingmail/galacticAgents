// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Question, ServerMessage } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useConversationStore } from '../../state/conversation.js';
import { useAppStore } from '../../state/store.js';
import { CardLinksContext } from '../cards/index.js';
import { Inbox } from '../Inbox.js';
import { Conversation } from './Conversation.js';

/**
 * The chat and the inbox together (P25-03 + P25-06): a Steward's clarification shows in the
 * thread of its project's *current* Waykeeper — the one that replaced the Waykeeper that spawned
 * the Steward (decision 32) — and in the inbox; answered in the inbox, it resolves in the thread.
 */

const oldWaykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-old',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: fx.harmonizer.id,
};
const waykeeper: Agent = {
  ...oldWaykeeper,
  id: 'a-waykeeper-new',
  createdAt: '2026-09-30T10:30:00.000Z',
};
/** Spawned by the old Waykeeper: its `supervisorId` still names it. */
const steward: Agent = { ...fx.agent, supervisorId: oldWaykeeper.id };
const clarification: Question = { ...fx.question, holder: { type: 'user' }, version: 4 };
const TEXT = clarification.context.text;

const snapshot: ServerMessage = {
  type: 'snapshot',
  logId: 'log-a',
  seq: 100,
  agents: [fx.harmonizer, oldWaykeeper, waykeeper, steward],
  bodies: [fx.body],
  projects: [fx.project],
  tasks: [fx.task],
  questions: [clarification],
  proposals: [],
  statuses: [
    { ...fx.status, agentId: fx.harmonizer.id },
    { ...fx.status, agentId: oldWaykeeper.id, state: 'stopped' },
    { ...fx.status, agentId: waykeeper.id },
    { ...fx.status, agentId: steward.id },
  ],
};

let answers: { id: string; text: string; version: number }[];
let api: Api;

beforeEach(() => {
  answers = [];
  useAppStore.getState().reset();
  useConversationStore.getState().reset();
  useAppStore.getState().apply(snapshot);
  useAppStore.setState({
    status: 'live',
    subscribeTranscript: vi.fn(),
    unsubscribeTranscript: vi.fn(),
  });
  api = {
    conversation: async () => ({ entries: [], hasMore: false, lastSeq: 0 }),
    answer: async (id: string, text: string, version: number) => {
      answers.push({ id, text, version });
      return { ok: true };
    },
  } as unknown as Api;
});
afterEach(() => cleanup());

function show(agentId: string) {
  return render(
    <ApiContext.Provider value={api}>
      <CardLinksContext.Provider value={true}>
        <Conversation agentId={agentId} />
        <Inbox />
      </CardLinksContext.Provider>
    </ApiContext.Provider>,
  );
}

const thread = () => screen.getByRole('log');
const inbox = () => screen.getByRole('region', { name: 'question inbox' });

describe('a Steward’s clarification in the chat and the inbox', () => {
  it('shows in the current Waykeeper’s thread and the inbox; answered in the inbox, it resolves in the thread', async () => {
    show(waykeeper.id);
    const inThread = await within(thread()).findByRole('article', {
      name: `clarification question ${TEXT}`,
    });
    const inInbox = within(inbox()).getByRole('article', {
      name: `clarification question ${TEXT}`,
    });
    expect(inThread).toBeTruthy();
    expect(within(inbox()).getByText('1 waiting for you')).toBeTruthy();

    fireEvent.click(within(inInbox).getByRole('button', { name: 'yes' }));
    await waitFor(() => expect(answers).toEqual([{ id: 'q-1', text: 'yes', version: 4 }]));

    // The server folds the answer and streams it: every copy of the card resolves.
    act(() =>
      useAppStore.getState().apply({
        type: 'event',
        seq: 101,
        at: '2026-09-30T10:40:00.000Z',
        event: {
          type: 'question.answered',
          questionId: 'q-1',
          answer: 'yes',
          answeredBy: { type: 'user' },
          version: 5,
        },
      }),
    );
    expect(
      within(thread()).queryByRole('article', { name: `clarification question ${TEXT}` }),
    ).toBeNull();
    const answered = within(thread()).getByRole('article', { name: `answered question ${TEXT}` });
    expect(answered.textContent).toMatch(/answered: “yes”/);
    expect(
      within(inbox()).queryByRole('article', { name: `clarification question ${TEXT}` }),
    ).toBeNull();
    expect(within(inbox()).getByText('Nothing waits for you.')).toBeTruthy();
  });

  it('is not in the Harmonizer’s thread', async () => {
    show(fx.harmonizer.id);
    await waitFor(() =>
      expect(useConversationStore.getState().threads[fx.harmonizer.id]?.loaded).toBe(true),
    );
    expect(
      within(thread()).queryByRole('article', { name: `clarification question ${TEXT}` }),
    ).toBeNull();
    expect(
      within(inbox()).getByRole('article', { name: `clarification question ${TEXT}` }),
    ).toBeTruthy();
  });
});
