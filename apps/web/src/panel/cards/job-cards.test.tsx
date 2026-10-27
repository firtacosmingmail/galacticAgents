// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FINDING_ACTIONS,
  SPEND_ACTIONS,
  type Agent,
  type Area,
  type Body,
  type Job,
  type JobDraft,
  type Project,
  type Proposal,
  type ProposalJob,
  type Question,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import type { Api } from '../../console/api.js';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';
import { axeFindings, blocking } from '../../a11y/a11y-fixtures.js';
import { inboxModel } from '../inbox-model.js';
import { QuestionCard } from './QuestionCard.js';
import { ProposalCard } from './ProposalCard.js';

/**
 * P10-07 (SPEC decisions 142–145): the job card (new / change / stop), the long-term card, the
 * finding card (suggestion and reply) and the spend card, each with its fixed actions.
 */

const saturn: Body = { id: 'b-saturn', kind: 'planet', name: 'Saturn' };
const titan: Body = {
  id: 'b-titan',
  kind: 'moon',
  parentId: 'b-saturn',
  name: 'Titan',
  host: { kind: 'areas', id: 'p-shop' },
};
const rhea: Body = { id: 'b-rhea', kind: 'moon', parentId: 'b-saturn', name: 'Rhea' };
const jupiter: Body = { id: 'b-jupiter', kind: 'planet', name: 'Jupiter' };

const shop: Project = {
  id: 'p-shop',
  name: 'Shop',
  workspace: '/home/cosmin/work/shop',
  bodyId: 'b-saturn',
  state: 'in_progress',
  longTerm: true,
  purpose: 'Sell handmade lamps online',
  goals: ['100 orders a month'],
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
};
const plain: Project = {
  ...fx.project,
  id: 'p-plain',
  name: 'Blog',
  bodyId: 'b-kepler',
};
const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-wk-shop',
  role: 'waykeeper',
  projectId: 'p-shop',
  bodyId: 'b-saturn',
};
const runSteward: Agent = {
  ...fx.agent,
  id: 'a-run-1',
  supervisorId: 'a-wk-shop',
  bodyId: 'b-titan',
  taskId: 't-job-1',
};
const marketing: Area = {
  id: 'ar-1',
  projectId: 'p-shop',
  name: 'Marketing',
  bodyId: 'b-titan',
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
};

const draft: JobDraft = {
  name: 'Reviews digest',
  instructions: 'Read the new reviews and suggest improvements.',
  schedule: { kind: 'weekdays', at: '09:00' },
  provider: 'claude',
  unattendedRules: [
    {
      scope: 'prefix',
      tool: 'Bash',
      match: { kind: 'words', words: ['curl'] },
      categories: ['network'],
      label: 'curl …',
    },
  ],
};
const newsletter: Job = {
  id: 'j-1',
  projectId: 'p-shop',
  areaId: 'ar-1',
  taskId: 't-job-1',
  name: 'Weekly newsletter',
  instructions: 'Write the newsletter.',
  schedule: { kind: 'weekly', days: [1], at: '08:00' },
  provider: 'claude',
  unattendedRules: [],
  state: 'active',
  followUps: [],
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
};

const jobCard = (job: ProposalJob, extra: Partial<Proposal> = {}): Proposal => ({
  id: `pr-job-${job.action}`,
  requestText: `${job.action} a job`,
  kind: 'planet',
  proposedBody: { kind: 'planet', bodyId: 'b-saturn', name: 'Saturn' },
  workspace: shop.workspace,
  rationale: 'Asked for by the Waykeeper of Shop.',
  state: 'pending',
  createdAt: fx.NOW,
  updatedAt: fx.NOW,
  meta: { job },
  ...extra,
});

const created = jobCard({
  projectId: 'p-shop',
  waykeeperId: 'a-wk-shop',
  action: 'create',
  draft,
  area: { name: 'Feedback' },
  moonId: 'b-rhea',
});

const question = (
  id: string,
  kind: Question['kind'],
  context: Question['context'],
  createdAt = fx.NOW,
): Question => ({
  id,
  kind,
  originAgentId: runSteward.id,
  holder: { type: 'user' },
  status: 'open',
  context,
  version: 4,
  createdAt,
  updatedAt: createdAt,
});

const suggestion = question('q-sugg', 'clarification', {
  text: 'Customers keep asking for gift wrapping.',
  options: [...FINDING_ACTIONS.suggestion],
  finding: { jobId: 'j-1', runId: 'r-1', kind: 'suggestion', title: 'Offer gift wrapping' },
});
const reply = question('q-reply', 'clarification', {
  text: 'Anna asks when her lamp ships.',
  options: [...FINDING_ACTIONS.reply],
  finding: {
    jobId: 'j-1',
    runId: 'r-1',
    kind: 'reply',
    title: 'Reply to Anna',
    draft: 'Hi Anna, it ships Monday.',
  },
});
const spend = question('q-spend', 'spend', {
  text: 'Boost the newsletter post',
  spend: { amount: 1250, currency: 'USD', purpose: 'Boost the newsletter post', jobId: 'j-1' },
});

let api: { answer: ReturnType<typeof vi.fn>; decide: ReturnType<typeof vi.fn> };

function world(extra: { questions?: Question[]; proposals?: Proposal[] } = {}) {
  useAppStore.getState().apply({
    type: 'snapshot',
    logId: 'log-a',
    seq: 5,
    agents: [fx.harmonizer, waykeeper, runSteward],
    bodies: [fx.body, saturn, titan, rhea, jupiter],
    projects: [shop, plain],
    tasks: [],
    questions: extra.questions ?? [],
    proposals: extra.proposals ?? [],
    statuses: [],
    areas: [marketing],
    jobs: [newsletter],
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
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the job card (P10-07)', () => {
  it('shows a new job: moon, schedule, provider, instructions and its rule labels', async () => {
    world({ proposals: [created] });
    show(<ProposalCard proposal={created} />);
    const card = screen.getByRole('article');
    within(card).getByText('New recurring job');
    within(card).getByText('Reviews digest');
    within(card).getByText(/Feedback moon · new area/);
    within(card).getByText('weekdays 9:00');
    within(card).getByText('claude');
    within(card).getByText(/Read the new reviews/);
    within(card).getByText('May do without asking:');
    within(card).getByText('curl …');
    // Approve / Reject only: a job card is decided as the Waykeeper made it.
    expect(within(card).queryByRole('button', { name: 'Edit' })).toBeNull();
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    expect(api.decide).toHaveBeenCalledWith(created.id, { decision: 'approve' });
    within(card).getByRole('button', { name: 'Reject' });
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('says it asks for everything when there are no rules, and names an existing area', () => {
    const p = jobCard({
      projectId: 'p-shop',
      waykeeperId: 'a-wk-shop',
      action: 'create',
      draft: { ...draft, unattendedRules: [] },
      area: { areaId: 'ar-1' },
      moonId: 'b-titan',
    });
    world({ proposals: [p] });
    show(<ProposalCard proposal={p} />);
    screen.getByText("Nothing — it asks for anything outside the project's rules");
    screen.getByText('Marketing area on Titan');
  });

  it('collapses long instructions past six lines', () => {
    const long = Array.from({ length: 9 }, (_, i) => `step ${i + 1}`).join('\n');
    const p = jobCard({
      projectId: 'p-shop',
      waykeeperId: 'a-wk-shop',
      action: 'create',
      draft: { ...draft, instructions: long },
      area: { areaId: 'ar-1' },
    });
    world({ proposals: [p] });
    show(<ProposalCard proposal={p} />);
    expect(screen.queryByText(/step 9/)).toBeNull();
    const more = screen.getByRole('button', { name: /show all 9 lines/i });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    screen.getByText(/step 9/);
  });

  it('shows a change as before → after for the changed fields only', async () => {
    const before: JobDraft = {
      name: newsletter.name,
      instructions: newsletter.instructions,
      schedule: newsletter.schedule,
      provider: 'claude',
      unattendedRules: [],
    };
    const p = jobCard({
      projectId: 'p-shop',
      waykeeperId: 'a-wk-shop',
      action: 'change',
      jobId: 'j-1',
      draft: { ...before, schedule: { kind: 'daily', at: '07:30' } },
      before: { draft: before, areaId: 'ar-1' },
      moonId: 'b-titan',
    });
    world({ proposals: [p] });
    show(<ProposalCard proposal={p} />);
    const card = screen.getByRole('article');
    within(card).getByText('Change job');
    const changes = within(card).getByRole('list', { name: 'changes' });
    expect(within(changes).getAllByRole('listitem')).toHaveLength(1);
    expect(changes.textContent).toContain('Mon 8:00 → every day 7:30');
    expect(within(card).queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('shows a stop card with the job as it is', () => {
    const before: JobDraft = {
      name: newsletter.name,
      instructions: newsletter.instructions,
      schedule: newsletter.schedule,
      provider: 'claude',
      unattendedRules: [],
    };
    const p = jobCard({
      projectId: 'p-shop',
      waykeeperId: 'a-wk-shop',
      action: 'stop',
      jobId: 'j-1',
      before: { draft: before, areaId: 'ar-1' },
    });
    world({ proposals: [p] });
    show(<ProposalCard proposal={p} />);
    screen.getByText('Stop job');
    screen.getByText('Weekly newsletter');
    screen.getByText('Marketing area on Titan');
  });
});

describe('the long-term card (P10-07)', () => {
  const longTerm = (extra: Partial<Proposal>, meta: Record<string, unknown>): Proposal => ({
    ...fx.proposal,
    id: 'pr-lt',
    requestText: 'Run my lamp shop',
    kind: 'planet',
    proposedBody: { kind: 'planet', bodyId: 'b-jupiter', name: 'Jupiter' },
    ...extra,
    meta,
  });

  it('shows the purpose and goals of a new long-term project, never a downsize', async () => {
    const p = longTerm(
      {
        state: 'parked',
      },
      {
        request: { type: 'new_project' },
        longTerm: {
          purpose: 'Sell handmade lamps online',
          goals: ['100 orders', 'Ship in 2 days'],
        },
        parked: { reason: 'no free planet with moons', offers: ['close_early'] },
      },
    );
    world({ proposals: [p] });
    show(<ProposalCard proposal={p} />);
    const card = screen.getByRole('article');
    within(card).getByText('Sell handmade lamps online');
    const goals = within(card).getByRole('list', { name: 'goals' });
    expect(
      within(goals)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['100 orders', 'Ship in 2 days']);
    expect(within(card).queryByRole('button', { name: /make it a moon project/ })).toBeNull();
    expect(within(card).queryByRole('button', { name: /asteroid/ })).toBeNull();
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('says where a conversion moves the project, and offers no Edit', () => {
    const p = longTerm(
      { proposedBody: { kind: 'planet', bodyId: 'b-jupiter', name: 'Jupiter' } },
      { longTerm: { projectId: 'p-plain', purpose: 'Keep the blog alive', goals: [] } },
    );
    world({ proposals: [p] });
    show(<ProposalCard proposal={p} />);
    screen.getByText('Moves to Jupiter');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    screen.getByRole('button', { name: 'Approve' });
  });
});

describe('the finding card (P10-07)', () => {
  it('offers the suggestion actions, with the job and area', async () => {
    world({ questions: [suggestion] });
    show(<QuestionCard question={suggestion} />);
    const card = screen.getByRole('article');
    within(card).getByText(/Weekly newsletter · Marketing/);
    within(card).getByText('Offer gift wrapping');
    within(card).getByText('Customers keep asking for gift wrapping.');
    for (const action of FINDING_ACTIONS.suggestion)
      within(card).getByRole('button', { name: action });
    expect(within(card).queryByRole('textbox')).toBeNull();
    await act(async () =>
      fireEvent.click(within(card).getByRole('button', { name: 'Create a ticket' })),
    );
    expect(api.answer).toHaveBeenCalledWith('q-sugg', 'Create a ticket', 4, expect.any(String));
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('sends an edited reply in detail.text', async () => {
    world({ questions: [reply] });
    show(<QuestionCard question={reply} />);
    const card = screen.getByRole('article');
    const box = within(card).getByRole('textbox', { name: 'reply' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Hi Anna, it ships Monday.');
    fireEvent.change(box, { target: { value: 'Hi Anna, it ships Tuesday!' } });
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(expect.arrayContaining([...FINDING_ACTIONS.reply]));
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Send' })));
    expect(api.answer).toHaveBeenCalledWith('q-reply', 'Send', 4, expect.any(String), {
      choices: ['Send'],
      text: 'Hi Anna, it ships Tuesday!',
    });
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('drops a reply without its text', async () => {
    world({ questions: [reply] });
    show(<QuestionCard question={reply} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Drop' })));
    expect(api.answer).toHaveBeenCalledWith('q-reply', 'Drop', 4, expect.any(String));
  });
});

describe('the spend card (P10-07)', () => {
  it('shows the amount, purpose and origin with Approve / Refuse only', async () => {
    // The page's locale is the browser's; pin it to en-US for the expected text.
    const Real = Intl.NumberFormat;
    vi.spyOn(Intl, 'NumberFormat').mockImplementation(function (
      locale?: string | string[],
      options?: Intl.NumberFormatOptions,
    ) {
      return new Real(locale ?? 'en-US', options);
    } as typeof Intl.NumberFormat);
    world({ questions: [spend] });
    show(<QuestionCard question={spend} />);
    const card = screen.getByRole('article');
    expect(card.classList.contains('question-spend')).toBe(true);
    within(card).getByText('$');
    within(card).getByText('$1,250.00');
    within(card).getAllByText('Boost the newsletter post');
    within(card).getByText(/from job “Weekly newsletter”/);
    const buttons = within(card)
      .getAllByRole('button')
      .map((b) => b.textContent)
      .filter((t) => t !== '×');
    expect(buttons).toEqual([...SPEND_ACTIONS]);
    expect(within(card).queryByRole('button', { name: /Allow similar/ })).toBeNull();
    await act(async () => fireEvent.click(within(card).getByRole('button', { name: 'Approve' })));
    expect(api.answer).toHaveBeenCalledWith('q-spend', 'Approve', 4, expect.any(String));
    expect(blocking(await axeFindings(card))).toEqual([]);
  });

  it('ranks with permissions in the inbox, before clarifications', () => {
    const early = question(
      'q-clar',
      'clarification',
      { text: 'Which colour?' },
      '2026-09-30T09:00:00.000Z',
    );
    const late = { ...spend, createdAt: '2026-09-30T11:00:00.000Z' };
    const model = inboxModel({ questions: { [early.id]: early, [late.id]: late }, proposals: {} });
    expect(model.waiting.map((i) => (i.kind === 'question' ? i.question.id : '?'))).toEqual([
      'q-spend',
      'q-clar',
    ]);
  });
});
