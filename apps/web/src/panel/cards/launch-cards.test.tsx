// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAUNCH_ACTIONS, OFF_SCRIPT_ACTIONS, type Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { inboxModel } from '../inbox-model.js';
import { glyphSpec } from '../../scene/beacons/beacon-look.js';
import { QuestionCard } from './QuestionCard.js';

/** P12-09: the launch approval card and the off-script card. */

const question = (id: string, kind: Question['kind'], context: Question['context']): Question => ({
  id,
  kind,
  originAgentId: 'a-waykeeper-1',
  holder: { type: 'user' },
  status: 'open',
  context,
  version: 4,
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
});

const launch = question('q-launch', 'launch', {
  text: 'Start a Steward with extra access',
  launch: {
    flags: ['chrome'],
    reason: 'Screenshots of the settings page for the PR',
    expectedUse: 'Open localhost:5173 and capture the settings page',
    check: 'The PR has two screenshots',
    taskId: fx.task.id,
    command: 'claude --chrome',
    cwd: '/work/wt/t-1',
    instructions: 'Take screenshots.',
  },
});
const offScript = question('q-off', 'permission', {
  text: 'The Steward tried a call outside what you approved',
  toolCall: { toolName: 'mcp__claude-in-chrome__navigate', input: { url: 'https://bank.example' } },
  offScript: {
    flag: 'chrome',
    expectedUse: 'Open localhost:5173 and capture the settings page',
    precedents: ['Open localhost:5173/login'],
    judgeReason: 'bank.example is not the local app',
  },
});

let api: { answer: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> };
const show = (node: React.ReactNode) =>
  render(<ApiContext.Provider value={api as unknown as Api}>{node}</ApiContext.Provider>);

beforeEach(() => {
  useAppStore.getState().reset();
  api = {
    answer: vi.fn(async () => ({ ok: true })),
    dismiss: vi.fn(async () => ({ ok: true })),
  };
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq: 5,
    agents: [fx.harmonizer, { ...fx.agent, id: 'a-waykeeper-1', role: 'waykeeper' }],
    bodies: [fx.body],
    projects: [fx.project],
    tasks: [fx.task],
    questions: [],
    proposals: [],
    statuses: [],
  });
  useAppStore.setState({ status: 'live' });
});
afterEach(() => cleanup());

describe('the launch card', () => {
  it('shows the command, the reason and what the flag adds, in order', async () => {
    show(<QuestionCard question={launch} />);
    const card = screen.getByRole('article');
    expect(card.classList.contains('question-launch')).toBe(true);
    within(card).getByText(/needs your approval/);
    within(card).getByText('Start Steward with extra access');
    within(card).getByText('claude --chrome');
    within(card).getByText('/work/wt/t-1');
    within(card).getByText('Screenshots of the settings page for the PR');
    within(card).getByText('--chrome');
    within(card).getByText(/controls your Chrome browser/);
    within(card).getByText('Open localhost:5173 and capture the settings page');
    within(card).getByText('The PR has two screenshots');
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('has exactly the three fixed buttons and no free-text box', () => {
    show(<QuestionCard question={launch} />);
    const card = screen.getByRole('article');
    for (const name of LAUNCH_ACTIONS) within(card).getByRole('button', { name });
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Answer' })).toBeNull();
  });

  it('Approve and start sends that exact answer', async () => {
    show(<QuestionCard question={launch} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Approve and start' })),
    );
    expect(api.answer).toHaveBeenCalledWith('q-launch', 'Approve and start', 4, expect.any(String));
  });

  it('its × says the Waykeeper is told', () => {
    show(<QuestionCard question={launch} />);
    const x = within(screen.getByRole('article')).getByRole('button', { name: /^Dismiss / });
    expect(x.getAttribute('aria-label')).toMatch(/^Dismiss the launch approval \(deny it\): /);
  });

  it('ranks with the user-held approvals and has the beacon glyph of a publish', () => {
    const model = inboxModel({ questions: { [launch.id]: launch }, proposals: {} });
    expect(model.waiting).toHaveLength(1);
    expect(glyphSpec('launch').symbol).not.toBe('?');
  });
});

describe('the off-script card', () => {
  it('shows the tool call, the approved use, the precedents and the judge reason', () => {
    show(<QuestionCard question={offScript} />);
    const card = screen.getByRole('article');
    within(card).getByText('The Steward tried to:');
    within(card).getByText('mcp__claude-in-chrome__navigate');
    within(card).getByText(/https:\/\/bank\.example/);
    within(card).getByText('Approved:');
    within(card).getByText('Open localhost:5173 and capture the settings page');
    within(card).getByText('Open localhost:5173/login');
    within(card).getByText('Why it was stopped:');
    within(card).getByText('bank.example is not the local app');
  });

  it('offers the two fixed buttons and never Allow similar, Allow or Refuse', () => {
    show(<QuestionCard question={offScript} />);
    const card = screen.getByRole('article');
    for (const name of OFF_SCRIPT_ACTIONS) within(card).getByRole('button', { name });
    expect(within(card).queryByRole('button', { name: /similar/i })).toBeNull();
    expect(within(card).queryByRole('button', { name: /^(Allow|Refuse)/ })).toBeNull();
  });

  it('Stop the Steward sends that exact answer', async () => {
    show(<QuestionCard question={offScript} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Stop the Steward' })),
    );
    expect(api.answer).toHaveBeenCalledWith('q-off', 'Stop the Steward', 4, expect.any(String));
  });

  it('its × denies the call', () => {
    show(<QuestionCard question={offScript} />);
    const x = within(screen.getByRole('article')).getByRole('button', { name: /^Dismiss / });
    expect(x.getAttribute('aria-label')).toMatch(/^Dismiss the permission request \(deny it\)/);
  });
});
