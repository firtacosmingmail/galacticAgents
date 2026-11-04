// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Proposal, Question, Task } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { ApiError, type Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { inboxModel } from '../inbox-model.js';
import { QuestionCard } from './QuestionCard.js';
import { PlanCard, WorkCard } from './ProposalCard.js';

/**
 * P11-09: the publish approval card, the usage-limit card, and the provider chips of the plan and
 * work cards.
 */

const HASH = 'a'.repeat(64);
const question = (
  id: string,
  kind: Question['kind'],
  context: Question['context'],
  createdAt = fx.NOW,
): Question => ({
  id,
  kind,
  originAgentId: 'a-steward-1',
  holder: { type: 'user' },
  status: 'open',
  context,
  version: 3,
  createdAt,
  updatedAt: createdAt,
});

const publishAs = (id: string): Question => ({ ...publish, id });
const publish = question('q-pub', 'publish', {
  text: 'Post the launch announcement',
  publish: {
    platform: 'LinkedIn',
    account: 'Cosmin Firta',
    text: 'We launched today.',
    files: [{ path: 'out/launch.png', sha256: HASH }],
    fingerprint: HASH,
    taskId: fx.task.id,
  },
});
const limit = question('q-limit', 'clarification', {
  text: 'ChatGPT hit its usage limit.',
  options: ['Switch to Claude', 'Wait until it resets'],
  usageLimit: {
    provider: 'chatgpt',
    model: 'gpt-5.6-terra',
    resetsAt: '2026-11-04T10:00:00.000Z',
    taskId: fx.task.id,
    switchTo: [{ provider: 'claude' }],
  },
});

let api: {
  answer: ReturnType<typeof vi.fn>;
  decide: ReturnType<typeof vi.fn>;
  publishFile: ReturnType<typeof vi.fn>;
};

function world(extra: { tasks?: Task[]; agents?: Agent[] } = {}) {
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq: 5,
    agents: [fx.harmonizer, { ...fx.agent, id: 'a-steward-1' }, ...(extra.agents ?? [])],
    bodies: [fx.body],
    projects: [fx.project],
    tasks: [fx.task, ...(extra.tasks ?? [])],
    questions: [],
    proposals: [],
    statuses: [],
  });
  useAppStore.setState({ status: 'live' });
}
const show = (node: React.ReactNode) =>
  render(<ApiContext.Provider value={api as unknown as Api}>{node}</ApiContext.Provider>);

beforeEach(() => {
  useAppStore.getState().reset();
  api = {
    answer: vi.fn(async () => ({ ok: true })),
    decide: vi.fn(async () => ({ ok: true })),
    publishFile: vi.fn(async () => ({
      bytes: new ArrayBuffer(4),
      contentType: 'image/png',
      truncated: false,
    })),
  };
  URL.createObjectURL = vi.fn(() => 'blob:thumb');
  URL.revokeObjectURL = vi.fn();
  world();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the publish card', () => {
  it('shows platform, account, text and files', async () => {
    show(<QuestionCard question={publish} />);
    const card = screen.getByRole('article');
    expect(card.classList.contains('question-publish')).toBe(true);
    within(card).getByText('↗');
    within(card).getByText('LinkedIn');
    within(card).getByText('Cosmin Firta');
    expect((within(card).getByLabelText('text to post') as HTMLTextAreaElement).value).toBe(
      'We launched today.',
    );
    within(card).getByText('out/launch.png');
    const img = await within(card).findByRole('img', { name: 'out/launch.png' });
    expect(img.getAttribute('src')).toBe('blob:thumb');
    expect(img.classList.contains('publish-thumb')).toBe(true);
    expect(api.publishFile).toHaveBeenCalledWith('q-pub', 0);
    within(card).getByText(`from task “${fx.task.description}”`);
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('approve sends the edited text', async () => {
    const q = publishAs('q-pub-approve');
    show(<QuestionCard question={q} />);
    const card = screen.getByRole('article');
    fireEvent.change(within(card).getByLabelText('text to post'), { target: { value: 'Edited' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    expect(api.answer).toHaveBeenCalledWith('q-pub-approve', 'Approve', 3, expect.any(String), {
      choices: ['Approve'],
      text: 'Edited',
    });
  });

  it('approving an untouched text sends no text (it goes out as asked)', async () => {
    show(<QuestionCard question={publishAs('q-pub-plain')} />);
    const card = screen.getByRole('article');
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    expect(api.answer).toHaveBeenCalledWith('q-pub-plain', 'Approve', 3, expect.any(String));
  });

  it('a changed file shows a notice instead of a picture', async () => {
    api.publishFile.mockRejectedValueOnce(new ApiError(409, '409', 'changed'));
    show(<QuestionCard question={publishAs('q-pub-409')} />);
    await within(screen.getByRole('article')).findByText(/changed since the request/);
  });

  it('refuse is a danger button and sends no text', async () => {
    show(<QuestionCard question={publishAs('q-pub-refuse')} />);
    const refuse = within(screen.getByRole('article')).getByRole('button', { name: 'Refuse' });
    expect(refuse.classList.contains('danger')).toBe(true);
    await act(async () => fireEvent.click(refuse));
    expect(api.answer).toHaveBeenCalledWith('q-pub-refuse', 'Refuse', 3, expect.any(String));
  });

  it("the server's refusal is shown on the card", async () => {
    api.answer.mockRejectedValueOnce(
      new ApiError(400, 'the text is empty and there are no files', 'invalid'),
    );
    show(<QuestionCard question={publishAs('q-pub-err')} />);
    const card = screen.getByRole('article');
    fireEvent.change(within(card).getByLabelText('text to post'), { target: { value: '' } });
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    within(card).getByText(/the text is empty/);
  });

  it('its × reads as a refusal', () => {
    show(<QuestionCard question={publish} />);
    const x = within(screen.getByRole('article')).getByRole('button', { name: /^Dismiss / });
    expect(x.getAttribute('aria-label')).toMatch(/^Dismiss the publish approval \(refuse it\): /);
  });

  it('ranks first in the inbox with permission and spend', () => {
    const t = (n: number) => `2026-09-30T0${n}:00:00.000Z`;
    const qs = [
      question('q-c', 'clarification', { text: 'Which colour?' }, t(1)),
      { ...publish, createdAt: t(4) },
      question('q-s', 'spend', { text: 'Boost' }, t(3)),
      question('q-p', 'permission', { text: 'Run ls' }, t(2)),
    ];
    const model = inboxModel({
      questions: Object.fromEntries(qs.map((q) => [q.id, q])),
      proposals: {},
    });
    expect(model.waiting.map((i) => (i.kind === 'question' ? i.question.id : '?'))).toEqual([
      'q-p',
      'q-s',
      'q-pub',
      'q-c',
    ]);
  });

  it('keeps its actions inside the card at phone width (320 px): the box fills, never overflows', () => {
    const css = readFileSync(resolve(__dirname, '../../app.css'), 'utf8');
    expect(css).toMatch(/\.publish-edit textarea\s*{[^}]*width:\s*100%/);
    expect(css).toMatch(/\.publish-thumb\s*{[^}]*max-width:\s*100%/);
    show(<QuestionCard question={publish} />);
    const card = screen.getByRole('article');
    within(card).getByRole('button', { name: 'Approve' });
    within(card).getByRole('button', { name: 'Refuse' });
  });
});

describe('the publish and spend styles (P11-15)', () => {
  const css = () => readFileSync(resolve(__dirname, '../../app.css'), 'utf8');
  /** The custom properties set in the first block whose selector matches `selector`. */
  const tokens = (text: string): Record<string, string> =>
    Object.fromEntries(
      [...text.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
    );
  const block = (text: string, start: RegExp): string => {
    const at = text.search(start);
    expect(at).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let i = text.indexOf('{', at); i < text.length; i++) {
      if (text[i] === '{') depth++;
      if (text[i] === '}' && --depth === 0) return text.slice(at, i + 1);
    }
    throw new Error('unclosed block');
  };
  const luminance = (hex: string) => {
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const KEYS = [
    '--publish',
    '--publish-bg',
    '--publish-ink',
    '--spend',
    '--spend-bg',
    '--spend-ink',
  ];

  it('gives the publish and spend tokens a dark and a light value, ink readable on each', () => {
    const text = css();
    const dark = tokens(block(text, /:root\s*{/));
    const light = tokens(block(text, /@media \(prefers-color-scheme: light\)\s*{\s*\.pnl\s*{/));
    for (const key of KEYS) {
      expect(dark[key], `dark ${key}`).toBeDefined();
      expect(light[key], `light ${key}`).toBeDefined();
      expect(light[key]).not.toBe(dark[key]);
    }
    for (const theme of [dark, light]) {
      for (const kind of ['publish', 'spend']) {
        // The badge's and the pill's ink on their fill (WCAG AA for small text).
        expect(contrast(theme[`--${kind}-ink`]!, theme[`--${kind}`]!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('styles the publish pill itself, over the light theme’s plain pill', () => {
    const text = css();
    const rule = block(text, /\.pnl \.pill\.kind-publish\s*{/);
    expect(rule).toMatch(/background:\s*var\(--publish\)/);
    expect(rule).toMatch(/color:\s*var\(--publish-ink\)/);
    expect(rule).toMatch(/border:[^;]*var\(--publish\)/);
    show(<QuestionCard question={publish} />);
    expect(within(screen.getByRole('article')).getByText('publish').className).toBe(
      'pill kind-publish',
    );
  });
});

describe('the usage-limit card', () => {
  it('offers each option as a button and no free text', async () => {
    show(<QuestionCard question={limit} />);
    const card = screen.getByRole('article');
    within(card).getByText(/ChatGPT · gpt-5.6-terra hit its usage limit/);
    const buttons = within(card)
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t !== '×');
    expect(buttons).toEqual(['Switch to Claude', 'Wait until it resets']);
    expect(within(card).queryByRole('textbox')).toBeNull();
    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'Wait until it resets' })),
    );
    expect(api.answer).toHaveBeenCalledWith(
      'q-limit',
      'Wait until it resets',
      3,
      expect.any(String),
    );
  });
});

describe('provider chips on plan and work cards', () => {
  const planTask = (id: string, extra: Partial<Task>): Task => ({
    ...fx.task,
    id,
    description: `step ${id}`,
    state: 'proposed',
    ...extra,
  });
  it('plan card shows each task model chip and tags', () => {
    const tasks = [
      planTask('t-a', { provider: 'gemini', makesImages: true }),
      planTask('t-b', { provider: 'chatgpt', model: 'gpt-5.6-terra', publishes: true }),
    ];
    world({ tasks });
    const plan: Proposal = {
      ...fx.proposal,
      id: 'pr-plan',
      meta: {
        plan: { projectId: fx.project.id, waykeeperId: fx.harmonizer.id, taskIds: ['t-a', 't-b'] },
      },
    };
    show(<PlanCard proposal={plan} />);
    const card = screen.getByRole('article');
    within(card).getByText('Gemini');
    within(card).getByText('ChatGPT · gpt-5.6-terra');
    within(card).getByText('images');
    within(card).getByText('publishes');
  });

  it('work card shows the provider note and a standalone card its provider', () => {
    const note: Proposal = {
      ...fx.proposal,
      meta: { request: { type: 'new_project' }, providerNote: 'Gemini makes the images' },
    };
    show(<WorkCard proposal={note} />);
    screen.getByText('Gemini makes the images');
    cleanup();
    const solo: Proposal = {
      ...fx.proposal,
      meta: { request: { type: 'standalone_task', provider: 'chatgpt', model: 'gpt-5.6' } },
    };
    show(<WorkCard proposal={solo} />);
    screen.getByText('ChatGPT · gpt-5.6');
  });
});
