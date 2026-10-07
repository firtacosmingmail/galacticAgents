// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConversationEntry,
  ConversationResponse,
  Question,
  ServerMessage,
  SlashCommand,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useConversationStore } from '../../state/conversation.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { Conversation } from '../chat/Conversation.js';
import { ClarificationComposer } from '../steward/ClarificationComposer.js';
import { resetSlashCommands } from './slash-commands.js';

/**
 * The composer's slash-command list (P8-13) and ↑ history (P8-14), in the Harmonizer's chat and
 * in a Steward's clarification box, against a fake API: the keyboard, the pointer, what is sent,
 * that drafts survive, and axe over the open list.
 */

const H = fx.harmonizer.id;
const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 10, 0, s)).toISOString();

const COMMANDS: SlashCommand[] = [
  { name: 'review', description: 'Review a pull request', argumentHint: '<pr>' },
  { name: 'compact', description: 'Keep a summary', builtin: true },
  // Agent-provided text: shown as text, never as markup.
  { name: 'xss', description: '<img src=x onerror="alert(1)"> <b>bold</b>' },
  { name: 'research', description: 'Research the codebase' },
];

const said = (n: number, text: string, sender: 'user' | 'agent' = 'user'): ConversationEntry => ({
  id: `m:msg-${n}`,
  agentId: H,
  kind: 'message',
  at: at(n),
  sender: sender === 'user' ? { type: 'user' } : { type: 'agent', id: 'a-waykeeper-1' },
  text,
  messageId: `msg-${n}`,
  seq: n,
  cursor: `c${n}`,
});

function fakeApi(
  opts: { commands?: SlashCommand[] | 'fail'; entries?: ConversationEntry[] } = {},
): {
  api: Api;
  sent: string[];
  answered: string[];
  commandReads: string[];
} {
  const sent: string[] = [];
  const answered: string[] = [];
  const commandReads: string[] = [];
  const api = {
    conversation: async (): Promise<ConversationResponse> => ({
      entries: opts.entries ?? [],
      hasMore: false,
      lastSeq: 50,
    }),
    send: async (_agentId: string, text: string) => {
      sent.push(text);
      return { messageId: `msg-sent-${sent.length}` };
    },
    answer: async (_id: string, answer: string) => {
      answered.push(answer);
      return {};
    },
    commands: async (agentId: string) => {
      commandReads.push(agentId);
      if (opts.commands === 'fail') throw new Error('offline');
      return { commands: opts.commands ?? [] };
    },
  } as unknown as Api;
  return { api, sent, answered, commandReads };
}

const snapshot = (questions: Question[] = []): ServerMessage =>
  ({
    type: 'snapshot',
    logId: 'log-a',
    seq: 100,
    agents: [fx.harmonizer, fx.agent],
    bodies: [fx.body],
    projects: [fx.project],
    tasks: [fx.task],
    questions,
    proposals: [],
    statuses: [{ ...fx.status, agentId: H }, fx.status],
  }) as ServerMessage;

beforeEach(() => {
  resetSlashCommands();
  localStorage.clear();
  useAppStore.getState().reset();
  useConversationStore.getState().reset();
  useAppStore.getState().apply(snapshot());
  useAppStore.setState({
    status: 'live',
    subscribeTranscript: vi.fn(),
    unsubscribeTranscript: vi.fn(),
  });
});
afterEach(() => cleanup());

async function chat(api: Api) {
  const view = render(
    <ApiContext.Provider value={api}>
      <Conversation agentId={H} />
    </ApiContext.Provider>,
  );
  await waitFor(() => expect(screen.queryByText('Loading the conversation…')).toBeNull());
  return { view, box: screen.getByLabelText('message to Harmonizer') as HTMLTextAreaElement };
}

const type = (box: HTMLTextAreaElement, value: string) =>
  act(() => {
    fireEvent.change(box, { target: { value } });
  });
const key = (box: HTMLTextAreaElement, k: string, extra: Partial<KeyboardEventInit> = {}) =>
  act(() => {
    fireEvent.keyDown(box, { key: k, ...extra });
  });
const list = () => screen.queryByRole('listbox', { name: 'slash commands' });
const options = () => within(list()!).getAllByRole('option');
const names = () => options().map((o) => o.querySelector('.cmp-slash-name')!.textContent);

describe('slash commands in the chat composer (P8-13)', () => {
  it('/ lists the agent’s commands, typing filters, arrows move, Enter inserts', async () => {
    const f = fakeApi({ commands: COMMANDS });
    const { box } = await chat(f.api);
    expect(f.commandReads).toEqual([H]);
    expect(box.getAttribute('aria-autocomplete')).toBe('list');
    expect(list()).toBeNull();

    await type(box, '/');
    expect(names()).toEqual(['/compact', '/research', '/review', '/xss']);
    expect(box.getAttribute('aria-controls')).toBe(list()!.id);
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/4 slash commands: up and down arrows/)).toBeTruthy();

    await type(box, '/re');
    expect(names()).toEqual(['/research', '/review']);
    // The hint and the description are shown with the name.
    expect(options()[1]!.textContent).toBe('/review <pr>Review a pull request');

    await key(box, 'ArrowDown');
    expect(box.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
    await key(box, 'ArrowDown'); // wraps
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true');
    await key(box, 'ArrowUp'); // wraps back
    await key(box, 'Enter');
    expect(box.value).toBe('/review ');
    expect(list()).toBeNull();
    expect(box.hasAttribute('aria-activedescendant')).toBe(false);
    expect(f.sent).toEqual([]); // Enter chose; it did not send

    // With the list shut, Enter sends the message as typed: the agent runs the command.
    await type(box, '/review 12');
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    await waitFor(() => expect(f.sent).toEqual(['/review 12']));
  });

  it('Tab inserts, Escape closes until the text changes, a click chooses', async () => {
    const f = fakeApi({ commands: COMMANDS });
    const { box } = await chat(f.api);
    await type(box, '/c');
    await key(box, 'Tab');
    expect(box.value).toBe('/compact ');

    await type(box, '/r');
    expect(list()).not.toBeNull();
    await key(box, 'Escape');
    expect(list()).toBeNull();
    await type(box, '/re');
    expect(list()).not.toBeNull();

    // The pointer: the textarea keeps the focus, the command goes in.
    box.focus();
    const research = options()[0]!;
    const down = fireEvent.mouseDown(research);
    expect(down).toBe(false); // default prevented: no focus change
    await act(() => {
      fireEvent.click(research);
    });
    expect(box.value).toBe('/research ');
    expect(document.activeElement).toBe(box);
  });

  it('renders agent-provided text as text only', async () => {
    const f = fakeApi({ commands: COMMANDS });
    const { box, view } = await chat(f.api);
    await type(box, '/xss');
    expect(options()[0]!.textContent).toContain('<img src=x onerror="alert(1)"> <b>bold</b>');
    expect(view.container.querySelector('.cmp-slash img, .cmp-slash b')).toBeNull();
  });

  it('shows nothing for an agent with no commands, a failed read, or text that is not a command', async () => {
    const none = fakeApi({ commands: [] });
    const { box } = await chat(none.api);
    await type(box, '/');
    expect(list()).toBeNull();
    cleanup();
    resetSlashCommands();

    const failing = fakeApi({ commands: 'fail' });
    const second = await chat(failing.api);
    await type(second.box, '/');
    expect(list()).toBeNull();
    cleanup();
    resetSlashCommands();

    const some = fakeApi({ commands: COMMANDS });
    const third = await chat(some.api);
    await type(third.box, 'hello /re');
    expect(list()).toBeNull();
    await type(third.box, '/zzz');
    expect(list()).toBeNull();
  });

  it('is clean for axe with the list open', async () => {
    const f = fakeApi({ commands: COMMANDS });
    const { box, view } = await chat(f.api);
    await type(box, '/');
    expect(list()).not.toBeNull();
    expect(blocking(await axeFindings(view.container))).toEqual([]);
  });
});

describe('message history with ↑ in the chat composer (P8-14)', () => {
  const entries = [said(1, 'first'), said(2, 'a report', 'agent'), said(3, 'second\nline two')];

  it('↑ recalls the user’s own messages newest first, ↓ walks back to empty', async () => {
    const f = fakeApi({ entries });
    const { box } = await chat(f.api);
    await key(box, 'ArrowUp');
    expect(box.value).toBe('second\nline two');
    expect(box.selectionStart).toBe(box.value.length); // the caret at its end
    // A recalled message of two lines: ↑ on its last line is the caret's (not handled).
    await key(box, 'ArrowUp');
    expect(box.value).toBe('second\nline two');
    box.setSelectionRange(0, 0);
    await key(box, 'ArrowUp');
    expect(box.value).toBe('first'); // the subordinate's report is not the user's
    await key(box, 'ArrowUp');
    expect(box.value).toBe('first'); // nothing older
    await key(box, 'ArrowDown');
    expect(box.value).toBe('second\nline two');
    await key(box, 'ArrowDown');
    expect(box.value).toBe('');
  });

  it('never replaces a draft; an edited recalled message is sent as edited', async () => {
    const f = fakeApi({ entries });
    const { box } = await chat(f.api);
    await type(box, 'my draft');
    await key(box, 'ArrowUp');
    expect(box.value).toBe('my draft');

    await type(box, '');
    await key(box, 'ArrowUp');
    box.setSelectionRange(0, 0);
    await key(box, 'ArrowUp');
    expect(box.value).toBe('first');
    await type(box, 'first, edited');
    await key(box, 'ArrowUp');
    await key(box, 'ArrowDown');
    expect(box.value).toBe('first, edited');
    await act(async () => {
      fireEvent.keyDown(box, { key: 'Enter' });
    });
    await waitFor(() => expect(f.sent).toEqual(['first, edited']));
    await waitFor(() => expect(box.value).toBe(''));
    // What was just sent is the newest entry now.
    await key(box, 'ArrowUp');
    expect(box.value).toBe('first, edited');
  });

  it('while the slash list is open, ↑/↓ move in the list, not in the history', async () => {
    const f = fakeApi({ entries, commands: COMMANDS });
    const { box } = await chat(f.api);
    await type(box, '/');
    await key(box, 'ArrowUp');
    expect(box.value).toBe('/');
    expect(options()[3]!.getAttribute('aria-selected')).toBe('true');
  });

  it('a recalled slash command does not open the list until it is edited', async () => {
    const f = fakeApi({ entries: [said(1, '/review')], commands: COMMANDS });
    const { box } = await chat(f.api);
    await key(box, 'ArrowUp');
    expect(box.value).toBe('/review');
    expect(list()).toBeNull();
    await key(box, 'ArrowDown');
    expect(box.value).toBe('');
  });
});

describe('the clarification box (P8-13, P8-14)', () => {
  const open: Question = { ...fx.question, holder: { type: 'user' }, version: 2 };
  const earlier = (n: number, answer: string, by: Question['answeredBy']): Question => ({
    ...fx.question,
    id: `q-old-${n}`,
    status: 'answered',
    answeredBy: by,
    answer,
    updatedAt: at(n),
  });

  function box(api: Api, questions: Question[]) {
    useAppStore.getState().apply(snapshot([open, ...questions]));
    render(
      <ApiContext.Provider value={api}>
        <ClarificationComposer question={open} onStale={() => {}} onSent={() => {}} />
      </ApiContext.Provider>,
    );
    return screen.getByRole('textbox') as HTMLTextAreaElement;
  }

  it('↑ recalls the user’s earlier answers to this Steward, not a supervisor’s', async () => {
    const f = fakeApi();
    const el = box(f.api, [
      earlier(1, 'use the old name', { type: 'user' }),
      earlier(2, 'from context', { type: 'agent', id: 'a-waykeeper-1' }),
      earlier(3, 'yes', { type: 'user' }),
    ]);
    await key(el, 'ArrowUp');
    expect(el.value).toBe('yes');
    await key(el, 'ArrowUp');
    expect(el.value).toBe('use the old name');
    await key(el, 'ArrowDown');
    await key(el, 'ArrowDown');
    expect(el.value).toBe('');
  });

  it('offers the skills and plugin commands, not the runtime’s own, and Enter inserts', async () => {
    const f = fakeApi({ commands: COMMANDS });
    const el = box(f.api, []);
    await waitFor(() => expect(f.commandReads).toEqual([fx.agent.id]));
    await type(el, '/');
    await waitFor(() => expect(list()).not.toBeNull());
    expect(names()).toEqual(['/research', '/review', '/xss']);
    await key(el, 'Enter');
    expect(el.value).toBe('/research ');
    // Cmd+Enter still answers.
    await type(el, '/research the cookie');
    await act(async () => {
      fireEvent.keyDown(el, { key: 'Enter', metaKey: true });
    });
    await waitFor(() => expect(f.answered).toEqual(['/research the cookie']));
  });
});
