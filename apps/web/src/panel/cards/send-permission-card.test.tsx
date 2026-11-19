// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Question, SendPermissionContext } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { RulesContext } from '../deliverables/use-deliverables.js';
import type { ClientRules } from '../deliverables/deliverables-model.js';
import { QuestionCard } from './QuestionCard.js';

/**
 * P13-30 (design 2026-11-18 §4.4 step 3): a held send's card — titled by what it sends, the held
 * call under it (the post as the publish card shows it, else the command's parts), Allow once /
 * Don't allow, and a reply box to its decider when there is one.
 */

const MAC: ClientRules = { local: true, download: true, edit: true, addOutside: true };
const HINT =
  'Reply with how far to allow it (only today, this campaign, these ads), or use the buttons.';
const send: SendPermissionContext = {
  summary: 'Posts a photo to Instagram as @myshop',
  parts: [
    { text: 'cd out', categories: ['run_workspace'] },
    { text: 'curl -X POST https://graph.instagram.com/me/media', categories: ['network'] },
  ],
  grants: [],
  deciderId: 'a-wk',
};
const card = (sendPermission: SendPermissionContext): Question => ({
  id: 'q-1',
  kind: 'permission',
  originAgentId: fx.agent.id,
  holder: { type: 'user' },
  status: 'open',
  context: {
    text: 'The Steward wants to post this to Instagram. Allow it?',
    toolCall: { toolName: 'Bash', input: { command: 'curl -X POST …' } },
    permissionAction: 'network',
    sendPermission,
  },
  version: 3,
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
});

let api: {
  answer: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  publishFile: ReturnType<typeof vi.fn>;
};

function show(q: Question) {
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
      <RulesContext.Provider value={MAC}>
        <QuestionCard question={q} />
      </RulesContext.Provider>
    </ApiContext.Provider>,
  );
}

beforeEach(() => {
  useAppStore.getState().reset();
  api = {
    answer: vi.fn(async () => ({ ok: true })),
    send: vi.fn(async () => ({ messageId: 'm-1' })),
    publishFile: vi.fn(async () => {
      throw new Error('no preview');
    }),
  };
});
afterEach(() => cleanup());

describe('the send card (P13-30)', () => {
  it('is titled by the summary and shows the call’s parts and the Waykeeper’s text', async () => {
    show(card(send));
    const article = screen.getByRole('article');
    expect(within(article).getByText(send.summary)).toBeTruthy();
    expect(within(article).getByText(card(send).context.text)).toBeTruthy();
    const parts = within(article).getByRole('list', { name: 'the command’s parts' });
    expect(
      within(parts)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['cd out', 'curl -X POST https://graph.instagram.com/me/media']);
    expect(blocking(await axeFindings(article))).toEqual([]);
  });

  it('Allow once answers allow and Don’t allow answers deny; no other permission buttons', async () => {
    show(card(send));
    expect(screen.queryByRole('button', { name: 'Refuse' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Allow similar/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Allow once' })));
    expect(api.answer.mock.calls[0]!.slice(0, 3)).toEqual(['q-1', 'allow', 3]);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: "Don't allow" })));
    expect(api.answer.mock.calls[1]!.slice(0, 3)).toEqual(['q-1', 'deny', 3]);
  });

  it('with a decider: the hint and a reply box that replies to the question in its chat', async () => {
    show(card(send));
    expect(screen.getByText(HINT)).toBeTruthy();
    const box = screen.getByRole('textbox', { name: 'reply' });
    fireEvent.change(box, { target: { value: 'only today' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Reply' })));
    expect(api.send).toHaveBeenCalledTimes(1);
    const [agentId, text, interrupt, replyTo] = api.send.mock.calls[0]!;
    expect([agentId, text, interrupt]).toEqual(['a-wk', 'only today', false]);
    expect(replyTo).toMatchObject({ kind: 'question', id: 'q-1', version: 3 });
    expect((box as HTMLInputElement).value).toBe('');
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('without a decider: the buttons only, no hint and no reply box', () => {
    const { deciderId: _none, ...plain } = send;
    show(card(plain));
    expect(screen.queryByText(HINT)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'reply' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeTruthy();
    expect(screen.getByRole('button', { name: "Don't allow" })).toBeTruthy();
  });

  it('shows a publish as the publish card does: platform, account, text, files', () => {
    show(
      card({
        ...send,
        parts: [],
        publish: {
          platform: 'Instagram',
          account: '@myshop',
          text: 'New in the shop: blue mugs',
          files: [{ path: 'mug.png', sha256: 'a'.repeat(64) }],
          fingerprint: 'b'.repeat(64),
        },
      }),
    );
    const article = screen.getByRole('article');
    expect(within(article).getByText('Instagram')).toBeTruthy();
    expect(within(article).getByText('@myshop')).toBeTruthy();
    expect(within(article).getByText('New in the shop: blue mugs')).toBeTruthy();
    const files = within(article).getByRole('list', { name: 'files to publish' });
    expect(within(files).getByText('mug.png')).toBeTruthy();
    expect(within(article).queryByRole('list', { name: 'the command’s parts' })).toBeNull();
  });
});

describe('the grant-conflict card (P13-34)', () => {
  const OPTIONS = [
    'Replace the earlier grant with the new one',
    'Keep the earlier grant and ignore the new words',
    'Keep both',
    'Keep the weekly grant but skip today',
  ];
  const conflict: Question = {
    id: 'q-2',
    kind: 'permission',
    originAgentId: 'a-wk',
    holder: { type: 'user' },
    status: 'open',
    context: {
      text: 'Earlier you said: "…". Now you said: "…". These conflict. What should I do?',
      options: OPTIONS,
      grantConflict: {
        deciderId: 'a-wk',
        grants: [
          {
            id: 'sg-1',
            words: 'send all launch messages this week',
            summary: 'Launch messages, this week',
            endsAt: '2026-11-22T22:00:00.000Z',
          },
        ],
        newWords: 'send the launch messages but just today',
        options: ['Keep the weekly grant but skip today'],
      },
    },
    version: 1,
    createdAt: fx.NOW,
    updatedAt: fx.NOW,
  };

  it('quotes the earlier grant with its end and the new words, offers the options in order', async () => {
    show(conflict);
    const article = screen.getByRole('article');
    const earlier = within(article).getByRole('list', { name: 'earlier grants' });
    expect(earlier.textContent).toContain('“send all launch messages this week”');
    expect(earlier.textContent).toContain('until ');
    expect(within(article).getByLabelText('new words').textContent).toBe(
      '“send the launch messages but just today”',
    );
    const buttons = within(article)
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => OPTIONS.includes(t ?? ''));
    expect(buttons).toEqual(OPTIONS);
    expect(within(article).queryByRole('button', { name: 'Allow once' })).toBeNull();
    expect(blocking(await axeFindings(article))).toEqual([]);
  });

  it('an option or his own words answer the question', async () => {
    show(conflict);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Keep both' })));
    expect(api.answer.mock.calls[0]!.slice(0, 3)).toEqual(['q-2', 'Keep both', 1]);
    fireEvent.change(screen.getByRole('textbox', { name: 'answer' }), {
      target: { value: 'only the newsletter' },
    });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Answer' })));
    expect(api.answer.mock.calls[1]!.slice(0, 3)).toEqual(['q-2', 'only the newsletter', 1]);
  });
});
