// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal, Question, Task } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { activateBody } from '../scene/picking/store.js';
import {
  asteroidTask,
  clarification,
  click,
  flush,
  inbox,
  main,
  MODES,
  navTo,
  openPanel,
  postedPaths,
  posts,
  projectTask,
  resetPage,
  selection,
  serverEvent,
  snapshot,
  teardownPage,
  type,
  workCard,
  type Mode,
  type PanelFetch,
} from './harness.js';

/**
 * P5-05: SPEC §4.3 "Requests the user must be able to make", line by line, with and without the
 * scene (the checklist, `docs/tasks/notes/P5-05-checklist.md`, links each requirement to its test
 * here or in `spec-4-2.test.tsx`). Requests made in conversation reach the Harmonizer as a chat
 * message (`POST /api/agents/:id/send`); the cards the server then posts are decided in the panel.
 */
vi.mock('../scene/SolarScene.js', () => ({ default: () => <div data-testid="solar-scene" /> }));
vi.mock('../scene/webgl.js', () => ({ webglAvailable: () => true }));

const HARMONIZER = 'Harmonizer';
const WAYKEEPER = 'Waykeeper · Auth refactor';
const ASTEROID_STEWARD = 'Steward · Fix the flaky date test';
const NOW = fx.NOW;

let fetchMock: PanelFetch;
afterEach(() => {
  cleanup();
  teardownPage();
});

/** The Waykeeper's plan: one card over two proposed tasks (decision 35). */
const planTasks: Task[] = [
  { ...projectTask, id: 't-p1', description: 'Write the token store', state: 'proposed' },
  { ...projectTask, id: 't-p2', description: 'Wire the login route', state: 'proposed' },
];
const plan: Proposal = {
  ...fx.proposal,
  id: 'pr-plan',
  requestText: 'Two steps to the new auth',
  meta: { plan: { projectId: 'p-1', waykeeperId: 'a-waykeeper-1', taskIds: ['t-p1', 't-p2'] } },
};
/** The Harmonizer's promotion card: the asteroid task grows into a moon project (decision 2). */
const promotion: Proposal = {
  ...fx.proposal,
  id: 'pr-promo',
  requestText: 'Promote "Fix the flaky date test" to a moon',
  kind: 'moon',
  proposedBody: { kind: 'moon', name: 'Date fixes' },
  meta: { request: { type: 'promotion', target: { kind: 'task', id: 't-2' }, name: 'Date fixes' } },
};
/** The Harmonizer's closure relay (decision 42), held by the user. */
const anythingElse: Question = {
  ...fx.question,
  id: 'q-close',
  originAgentId: 'a-harmonizer',
  holder: { type: 'user' },
  context: {
    text: 'Anything else on Auth refactor? The auth refactor is done.',
    options: ['Close Auth refactor', 'Something else: …'],
  },
};

describe.each(MODES)('SPEC §4.3 requests the user must be able to make — $name', (mode: Mode) => {
  beforeEach(() => {
    fetchMock = resetPage(mode);
  });

  describe('§4.3 ask for the status of anything — computed, no LLM call', () => {
    it('§4.3.1 the whole system', async () => {
      await openPanel(mode);
      await click(within(main()).getByRole('button', { name: 'Status' }));
      const system = within(within(main()).getByRole('region', { name: 'system status' }));
      expect(system.getByRole('list', { name: 'projects by state' })).toBeTruthy();
      expect(system.getByRole('list', { name: 'tasks by state' })).toBeTruthy();
      expect(system.getByRole('list', { name: 'agents by state' })).toBeTruthy();
      expect(system.getByText(/3 open: 1 permission, 2 clarification/)).toBeTruthy();
      expect(postedPaths(fetchMock)).toEqual([]);
    });

    it('§4.3.2 a project', async () => {
      await openPanel(mode);
      if (mode.scene) act(() => void activateBody('b-luna', { x: 0, y: 0 }));
      else await navTo(/Auth refactor/);
      await flush();
      await click(within(main()).getByRole('button', { name: 'Status' }));
      const status = within(
        within(main()).getByRole('region', { name: 'status of Auth refactor' }),
      );
      expect(
        within(status.getByRole('list', { name: 'tasks' })).getByText(
          'Replace the session middleware',
        ),
      ).toBeTruthy();
      expect(status.getAllByText('in progress').length).toBeGreaterThan(0);
      expect(postedPaths(fetchMock)).toEqual([]);
    });

    it('§4.3.3 a task', async () => {
      await openPanel(mode);
      if (mode.scene) act(() => void activateBody('b-ast-1', { x: 0, y: 0 }));
      else await navTo(/Fix the flaky date test/);
      await flush();
      expect(selection()).toEqual({ kind: 'steward', id: 'a-steward-2' });
      const task = within(main()).getByLabelText('task status');
      expect(within(task).getByText('task state')).toBeTruthy();
      expect(within(task).getByText('in progress')).toBeTruthy();
      expect(within(task).getByText('high')).toBeTruthy(); // its priority
      expect(postedPaths(fetchMock)).toEqual([]);
    });

    it('§4.3.4 an agent', async () => {
      await openPanel(mode, '/steward/a-steward-2');
      const view = within(screen.getByRole('region', { name: `view of ${ASTEROID_STEWARD}` }));
      expect(view.getByText('Running the tests')).toBeTruthy();
      expect(view.getAllByText('working').length).toBeGreaterThan(0);
      expect(view.getByText('17 / 500')).toBeTruthy(); // tool calls against the cap
      // And an agent from its card, without selecting it.
      await click(within(main()).getByRole('link', { name: '← Harmonizer' }));
      const card = within(screen.getByRole('article', { name: `card of ${WAYKEEPER}` }));
      expect(card.getByText('Planning')).toBeTruthy();
      expect(postedPaths(fetchMock)).toEqual([]);
    });
  });

  describe('§4.3 ask for new work: a task (standalone or in a project), a project', () => {
    /** Types a request to the Harmonizer; the server answers with one card in its thread. */
    async function request(text: string, card: Proposal) {
      await openPanel(mode, '/', snapshot({ proposals: [] }));
      const box = within(main()).getByLabelText(`message to ${HARMONIZER}`);
      await type(box, text);
      await act(async () => {
        fireEvent.keyDown(box, { key: 'Enter' });
      });
      await flush();
      expect(posts(fetchMock, '/api/agents/a-harmonizer/send')).toEqual([
        { text, interrupt: false },
      ]);
      await serverEvent({ type: 'proposal.created', proposal: card });
      const thread = within(within(main()).getByRole('log'));
      const shown = await thread.findByRole('article', { name: `proposal ${card.requestText}` });
      await click(within(shown).getByRole('button', { name: 'Approve' }));
      expect(posts(fetchMock, `/api/proposals/${card.id}/decide`)).toEqual([
        { decision: 'approve' },
      ]);
      return shown;
    }
    const card = (over: Partial<Proposal>): Proposal => ({
      ...fx.proposal,
      createdAt: new Date(Date.parse(NOW) + 3_600_000).toISOString(),
      ...over,
    });

    it('§4.3.5 a new standalone task', async () => {
      const shown = await request(
        'Fix the typo on the login page',
        card({
          id: 'pr-task',
          requestText: 'Fix the typo on the login page',
          kind: 'asteroid',
          proposedBody: { kind: 'asteroid', name: 'Typo' },
          meta: { request: { type: 'standalone_task', name: 'Typo', description: 'Fix it' } },
        }),
      );
      expect(within(shown).getByText('standalone task')).toBeTruthy();
    });

    it('§4.3.6 a new task added to an existing project', async () => {
      const shown = await request(
        'Add rate limiting to the auth refactor',
        card({
          id: 'pr-ptask',
          requestText: 'Add rate limiting to the auth refactor',
          kind: 'moon',
          proposedBody: { kind: 'moon', name: 'Luna', bodyId: 'b-luna' },
          meta: {
            request: {
              type: 'project_task',
              name: 'Rate limits',
              description: 'Add rate limiting',
              projectId: 'p-1',
            },
          },
        }),
      );
      expect(within(shown).getByText('project task')).toBeTruthy();
    });

    it('§4.3.7 start a new project', async () => {
      const shown = await request(
        'Start a new project: a tiny URL shortener',
        card({
          id: 'pr-project',
          requestText: 'Start a new project: a tiny URL shortener',
          kind: 'planet',
          proposedBody: { kind: 'planet', name: 'URL shortener' },
          meta: { request: { type: 'new_project', name: 'URL shortener' } },
        }),
      );
      expect(within(shown).getByText('new project')).toBeTruthy();
    });
  });

  describe('§4.3 answer a question raised by any agent', () => {
    it('§4.3.8 through its supervisor (the card in the supervisor’s conversation)', async () => {
      await openPanel(mode);
      if (mode.scene) act(() => void activateBody('b-luna', { x: 0, y: 0 }));
      else await navTo(/Auth refactor/);
      await flush();
      expect(selection()).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
      const thread = within(within(main()).getByRole('log'));
      const card = await thread.findByRole('article', {
        name: `clarification question ${clarification.context.text}`,
      });
      await click(within(card).getByRole('button', { name: 'no' }));
      expect(posts(fetchMock, '/api/questions/q-1/answer')).toEqual([{ answer: 'no', version: 3 }]);
    });

    it('§4.3.9 from the inbox (a clarification, a permission)', async () => {
      await openPanel(mode);
      const card = (name: RegExp) => within(inbox()).getByRole('article', { name });
      await click(
        within(card(/^clarification question Keep/)).getByRole('button', { name: 'yes' }),
      );
      await click(within(card(/^permission question/)).getByRole('button', { name: 'Refuse' }));
      expect(posts(fetchMock, '/api/questions/q-1/answer')).toEqual([
        { answer: 'yes', version: 3 },
      ]);
      expect(posts(fetchMock, '/api/questions/q-2/answer')).toEqual([{ answer: 'no', version: 0 }]);
    });

    it('§4.3.10 directly to the Steward — a clarification only', async () => {
      await openPanel(mode, '/steward/a-steward-1');
      const box = within(main()).getByRole('form', { name: 'answer the clarification' });
      await type(within(box).getByRole('textbox'), 'Rename it to session_id');
      await click(within(box).getByRole('button', { name: 'Send answer' }));
      expect(posts(fetchMock, '/api/questions/q-1/answer')).toEqual([
        { answer: 'Rename it to session_id', version: 3 },
      ]);
      // A permission is never answered by message: the asteroid Steward's has allow / refuse only.
      cleanup();
      await openPanel(mode, '/steward/a-steward-2');
      expect(within(main()).queryByRole('form', { name: 'answer the clarification' })).toBeNull();
      expect(within(main()).queryByRole('textbox')).toBeNull();
    });
  });

  describe('§4.3 approve, edit or reject a proposal or a task plan; confirm or decline a promotion', () => {
    const inboxCard = (name: string) => within(inbox()).getByRole('article', { name });
    const decided = (id: string) => posts(fetchMock, `/api/proposals/${id}/decide`);

    it('§4.3.11 approve a proposal', async () => {
      await openPanel(mode);
      await click(
        within(inboxCard(`proposal ${workCard.requestText}`)).getByRole('button', {
          name: 'Approve',
        }),
      );
      expect(decided('pr-1')).toEqual([{ decision: 'approve' }]);
    });

    it('§4.3.12 edit a proposal (size, body, workspace)', async () => {
      await openPanel(mode);
      const card = inboxCard(`proposal ${workCard.requestText}`);
      await click(within(card).getByRole('button', { name: 'Edit' }));
      const form = within(within(card).getByRole('form', { name: 'edit card' }));
      await type(form.getByLabelText('size'), 'asteroid');
      await type(form.getByLabelText('workspace'), '/home/cosmin/work/dark-mode');
      await click(form.getByRole('button', { name: 'Save' }));
      expect(decided('pr-1')).toEqual([
        {
          decision: 'edit',
          changes: {
            kind: 'asteroid',
            proposedBody: { kind: 'asteroid', name: 'Dark mode' },
            workspace: '/home/cosmin/work/dark-mode',
          },
        },
      ]);
    });

    it('§4.3.13 reject a proposal (with a reason)', async () => {
      await openPanel(mode);
      const card = inboxCard(`proposal ${workCard.requestText}`);
      await type(within(card).getByRole('textbox', { name: 'reason' }), 'not now');
      await click(within(card).getByRole('button', { name: 'Reject' }));
      expect(decided('pr-1')).toEqual([{ decision: 'reject', reason: 'not now' }]);
    });

    const withPlan = () =>
      snapshot({ tasks: [projectTask, asteroidTask, ...planTasks], proposals: [plan] });

    it('§4.3.14 approve a task plan (in the Waykeeper’s conversation)', async () => {
      await openPanel(mode, '/waykeeper/a-waykeeper-1', withPlan());
      const thread = within(within(main()).getByRole('log'));
      const card = await thread.findByRole('article', { name: `plan ${plan.requestText}` });
      await click(within(card).getByRole('button', { name: 'Approve plan' }));
      expect(decided('pr-plan')).toEqual([{ decision: 'approve' }]);
    });

    it('§4.3.15 edit a task plan, through its tasks', async () => {
      await openPanel(mode, '/', withPlan());
      const card = inboxCard(`plan ${plan.requestText}`);
      const task = within(
        within(card).getByLabelText('controls of Write the token store') as HTMLElement,
      );
      await click(task.getByRole('button', { name: 'Edit' }));
      await type(task.getByLabelText('description'), 'Write the token store with expiry');
      await click(task.getByRole('button', { name: 'Save' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        {
          target: { kind: 'task', id: 't-p1' },
          action: { action: 'edit', changes: { description: 'Write the token store with expiry' } },
        },
      ]);
    });

    it('§4.3.16 reject a task plan', async () => {
      await openPanel(mode, '/', withPlan());
      const card = inboxCard(`plan ${plan.requestText}`);
      await type(within(card).getByRole('textbox', { name: 'reason' }), 'split it differently');
      await click(within(card).getByRole('button', { name: 'Reject' }));
      expect(decided('pr-plan')).toEqual([{ decision: 'reject', reason: 'split it differently' }]);
    });

    it('§4.3.17 confirm a promotion', async () => {
      await openPanel(mode, '/', snapshot({ proposals: [promotion] }));
      const card = inboxCard(`proposal ${promotion.requestText}`);
      expect(within(card).getByText('task t-2')).toBeTruthy(); // what it moves
      await click(within(card).getByRole('button', { name: 'Approve' }));
      expect(decided('pr-promo')).toEqual([{ decision: 'approve' }]);
    });

    it('§4.3.18 decline a promotion', async () => {
      await openPanel(mode, '/', snapshot({ proposals: [promotion] }));
      const card = inboxCard(`proposal ${promotion.requestText}`);
      await click(within(card).getByRole('button', { name: 'Reject' }));
      expect(decided('pr-promo')).toEqual([{ decision: 'reject' }]);
    });
  });

  describe('§4.3 close a project; archive early, pin or reopen finished work', () => {
    it('§4.3.21b close a project by answering the Harmonizer’s “Anything else?”', async () => {
      await openPanel(mode, '/', snapshot({ questions: [anythingElse], proposals: [] }));
      const thread = within(within(main()).getByRole('log'));
      const card = await thread.findByRole('article', {
        name: `clarification question ${anythingElse.context.text}`,
      });
      await click(within(card).getByRole('button', { name: 'Close Auth refactor' }));
      expect(posts(fetchMock, '/api/questions/q-close/answer')).toEqual([
        { answer: 'Close Auth refactor', version: 0 },
      ]);
    });

    it('§4.3.24 reopen finished work from the history view', async () => {
      await openPanel(mode);
      await click(screen.getByRole('link', { name: 'History' }));
      const row = await screen.findByRole('listitem', { name: 'Fix the flaky date test' });
      await click(within(row).getByRole('button', { name: 'Reopen' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: { kind: 'task', id: 't-old' }, action: { action: 'reopen' } },
      ]);
    });
  });
});
