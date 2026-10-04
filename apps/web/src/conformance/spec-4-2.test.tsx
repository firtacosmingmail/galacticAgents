// @vitest-environment jsdom
import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentState, ControlBody } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';
import { activateBody, activateSatellite, deselectFromScene } from '../scene/picking/store.js';
import {
  asteroidTask,
  click,
  flush,
  inbox,
  main,
  managed,
  MODES,
  nav,
  navTo,
  openPanel,
  postedPaths,
  posts,
  project,
  projectTask,
  resetPage,
  selection,
  serverEvent,
  snapshot,
  teardownPage,
  type,
  type Mode,
  type PanelFetch,
} from './harness.js';

/**
 * P5-05: SPEC §4.2 "Side panel", line by line, with and without the scene (the checklist,
 * `docs/tasks/notes/P5-05-checklist.md`, links each requirement to its test here). Each `describe`
 * is a §4.2 bullet; each `it` one requirement of it; every one runs once with the scene (its
 * three.js part stubbed) and once in list mode (the scene hidden by choice).
 */
vi.mock('../scene/SolarScene.js', () => ({ default: () => <div data-testid="solar-scene" /> }));
vi.mock('../scene/webgl.js', () => ({ webglAvailable: () => true }));

const HARMONIZER = 'Harmonizer';
const WAYKEEPER = 'Waykeeper · Auth refactor';
const STEWARD = 'Steward · Replace the session middleware';
const ASTEROID_STEWARD = 'Steward · Fix the flaky date test';

let fetchMock: PanelFetch;
afterEach(() => {
  cleanup();
  teardownPage();
});

describe.each(MODES)('SPEC §4.2 side panel — $name', (mode: Mode) => {
  beforeEach(() => {
    fetchMock = resetPage(mode);
  });

  describe('§4.2 chat: Harmonizer by default, a Waykeeper when selected, the Harmonizer one click away', () => {
    it('§4.2.1 shows the chat with the Harmonizer by default', async () => {
      await openPanel(mode);
      expect(selection()).toEqual({ kind: 'harmonizer' });
      expect(main().getAttribute('aria-label')).toBe(`Conversation with ${HARMONIZER}`);
      expect(within(main()).getByRole('region', { name: `chat with ${HARMONIZER}` })).toBeTruthy();
      expect(within(main()).getByLabelText(`message to ${HARMONIZER}`)).toBeTruthy();
    });

    it('§4.2.2 selecting a Waykeeper by its planet or moon replaces the chat with its conversation', async () => {
      await openPanel(mode);
      if (mode.scene) act(() => void activateBody('b-luna', { x: 0, y: 0 }));
      // List mode has no planet to click: the project's navigation row selects its Waykeeper.
      else await navTo(/Auth refactor/);
      await flush();
      expect(selection()).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
      expect(within(main()).getByRole('region', { name: `chat with ${WAYKEEPER}` })).toBeTruthy();
      expect(within(main()).queryByRole('region', { name: `chat with ${HARMONIZER}` })).toBeNull();
    });

    it('§4.2.3 selecting a Waykeeper by its satellite replaces the chat with its conversation', async () => {
      await openPanel(mode);
      if (mode.scene) act(() => void activateSatellite('a-waykeeper-1'));
      // List mode has no satellite: the Waykeeper's managed-agents card links to it.
      else
        await click(
          within(screen.getByRole('article', { name: `card of ${WAYKEEPER}` })).getByRole('link', {
            name: WAYKEEPER,
          }),
        );
      await flush();
      expect(selection()).toEqual({ kind: 'waykeeper', id: 'a-waykeeper-1' });
      expect(within(main()).getByRole('region', { name: `chat with ${WAYKEEPER}` })).toBeTruthy();
    });

    it('§4.2.4 the Harmonizer is one click away: deselect', async () => {
      await openPanel(mode, '/waykeeper/a-waykeeper-1');
      if (mode.scene) act(() => void deselectFromScene());
      // The dock bar's "← Harmonizer" (in both modes) is the panel's deselect.
      else await click(within(main()).getByRole('link', { name: '← Harmonizer' }));
      await flush();
      expect(selection()).toEqual({ kind: 'harmonizer' });
      expect(within(main()).getByRole('region', { name: `chat with ${HARMONIZER}` })).toBeTruthy();
    });

    it('§4.2.5 the Harmonizer is one click away: click Earth', async () => {
      await openPanel(mode, '/steward/a-steward-2');
      if (mode.scene) act(() => void activateBody('b-earth', { x: 0, y: 0 }));
      // List mode: the navigation's Harmonizer row (headquarters) stands for Earth.
      else await click(within(nav()).getByRole('link', { name: /^Harmonizer/ }));
      await flush();
      expect(selection()).toEqual({ kind: 'harmonizer' });
      expect(within(main()).getByRole('region', { name: `chat with ${HARMONIZER}` })).toBeTruthy();
    });
  });

  describe('§4.2 Steward view: read-only, a message box only for an open clarification, stop/pause kept', () => {
    /** Selects the project's Steward: its satellite in the scene, its task's row in list mode. */
    async function selectSteward() {
      if (mode.scene) act(() => void activateSatellite('a-steward-1'));
      else await navTo(/Replace the session middleware/);
      await flush();
      expect(selection()).toEqual({ kind: 'steward', id: 'a-steward-1' });
      return within(screen.getByRole('region', { name: `view of ${STEWARD}` }));
    }
    const header = () => main().querySelector<HTMLElement>('header.stw-head')!;

    it('§4.2.6 selecting a Steward shows its status', async () => {
      await openPanel(mode);
      await selectSteward();
      expect(main().getAttribute('aria-label')).toBe(STEWARD);
      expect(within(header()).getByText('working')).toBeTruthy();
      expect(within(header()).getByText('task in progress')).toBeTruthy();
    });

    it('§4.2.7 … its current activity', async () => {
      await openPanel(mode);
      await selectSteward();
      expect(within(header()).getByText('Editing src/session.ts')).toBeTruthy();
    });

    it('§4.2.8 … its work (task, project, body, worktree, branch)', async () => {
      await openPanel(mode);
      await selectSteward();
      expect(within(header()).getByText('Replace the session middleware')).toBeTruthy();
      expect(within(header()).getByText('Auth refactor')).toBeTruthy();
      expect(within(header()).getByText('Luna (moon)')).toBeTruthy();
      expect(within(header()).getByText(projectTask.worktreePath!)).toBeTruthy();
      expect(within(header()).getByText(projectTask.branch!)).toBeTruthy();
    });

    it('§4.2.9 … its thought process (the transcript: thinking, tool calls, text)', async () => {
      await openPanel(mode);
      const view = await selectSteward();
      const transcript = view.getByRole('region', { name: 'transcript' });
      await vi.waitFor(() =>
        expect(within(transcript).getByText('Reading the middleware.')).toBeTruthy(),
      );
      expect(within(transcript).getByText('Read src/session.ts')).toBeTruthy();
      expect(within(transcript).getByText('The cookie name matters')).toBeTruthy();
    });

    it('§4.2.10 … its open question', async () => {
      await openPanel(mode);
      const view = await selectSteward();
      const open = view.getByRole('region', { name: 'open question' });
      expect(within(open).getByText(fx.question.context.text)).toBeTruthy();
    });

    it('§4.2.11a a message box appears only while the Steward has an open clarification', async () => {
      await openPanel(mode);
      const view = await selectSteward();
      const box = view.getByRole('form', { name: 'answer the clarification' });
      await type(within(box).getByRole('textbox'), 'Keep it');
      await click(within(box).getByRole('button', { name: 'Send answer' }));
      expect(posts(fetchMock, '/api/questions/q-1/answer')).toEqual([
        { answer: 'Keep it', version: 3 },
      ]);
      // Both of its clarifications answered: the box goes, the view says it is read-only.
      await serverEvent({
        type: 'question.answered',
        questionId: 'q-1',
        answer: 'Keep it',
        answeredBy: { type: 'user' },
        version: 4,
      });
      expect(view.getByRole('form', { name: 'answer the clarification' })).toBeTruthy();
      await serverEvent({
        type: 'question.answered',
        questionId: 'q-3',
        answer: 'ISO',
        answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
        version: 1,
      });
      expect(view.queryByRole('form', { name: 'answer the clarification' })).toBeNull();
      expect(view.getByText(/Read-only: Stewards take no messages/)).toBeTruthy();
    });

    it('§4.2.11b … and none for a Steward with only a permission request (allow / refuse only)', async () => {
      await openPanel(mode, '/steward/a-steward-2');
      const view = within(screen.getByRole('region', { name: `view of ${ASTEROID_STEWARD}` }));
      expect(view.queryByRole('form', { name: 'answer the clarification' })).toBeNull();
      const card = view.getByRole('article', { name: /^permission question/ });
      expect(within(card).getByRole('button', { name: 'Allow' })).toBeTruthy();
      expect(within(card).getByRole('button', { name: 'Refuse' })).toBeTruthy();
      expect(within(card).queryByRole('textbox')).toBeNull();
    });

    it('§4.2.12 stop and pause remain available on the Steward', async () => {
      await openPanel(mode);
      const view = await selectSteward();
      const controls = () => within(view.getByRole('group', { name: 'controls' }));
      await click(controls().getByRole('button', { name: 'Pause' }));
      await click(controls().getByRole('button', { name: 'Stop' }));
      await click(controls().getByRole('button', { name: 'Confirm stop' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: { kind: 'agent', id: 'a-steward-1' }, action: { action: 'pause' } },
        { target: { kind: 'agent', id: 'a-steward-1' }, action: { action: 'stop' } },
      ]);
    });
  });

  describe('§4.2 managed-agents section, with statuses', () => {
    const cardOf = (name: string) =>
      within(managed()).getByRole('article', { name: `card of ${name}` });

    it('§4.2.13 the Harmonizer’s: its Waykeepers and the asteroid Stewards, with their statuses', async () => {
      await openPanel(mode);
      expect(within(cardOf(WAYKEEPER)).getAllByText('working').length).toBeGreaterThan(0);
      expect(within(cardOf(ASTEROID_STEWARD)).getAllByText('working').length).toBeGreaterThan(0);
      expect(within(managed()).queryByRole('article', { name: `card of ${STEWARD}` })).toBeNull();
    });

    it('§4.2.14 a Waykeeper’s: the Stewards it manages, with their statuses', async () => {
      await openPanel(mode, '/waykeeper/a-waykeeper-1');
      expect(within(cardOf(STEWARD)).getAllByText('working').length).toBeGreaterThan(0);
      expect(
        within(managed()).queryByRole('article', { name: `card of ${ASTEROID_STEWARD}` }),
      ).toBeNull();
    });
  });

  describe('§4.2 question inbox: every open question, its kind, holder and context; answered inline', () => {
    const card = (text: RegExp) => within(inbox()).getByRole('article', { name: text });

    it('§4.2.15 lists every open question in the system', async () => {
      await openPanel(mode);
      expect(card(/^clarification question Keep the legacy cookie name/)).toBeTruthy();
      expect(card(/^permission question Run `git push/)).toBeTruthy();
      expect(card(/^clarification question Which date format/)).toBeTruthy();
    });

    it('§4.2.16 … with its kind', async () => {
      await openPanel(mode);
      expect(within(card(/^permission question/)).getByText('permission')).toBeTruthy();
      expect(within(card(/^clarification question Keep/)).getByText('clarification')).toBeTruthy();
    });

    it('§4.2.17 … who is currently holding it', async () => {
      await openPanel(mode);
      expect(within(card(/^clarification question Keep/)).getByText('held by you')).toBeTruthy();
      expect(
        within(card(/^clarification question Which date/)).getByText(`held by ${WAYKEEPER}`),
      ).toBeTruthy();
    });

    it('§4.2.18 … and the context to answer it: origin agent, task, body, last events', async () => {
      await openPanel(mode);
      const c = card(/^clarification question Keep/);
      expect(within(c).getByRole('link', { name: new RegExp(`^open ${STEWARD}`) })).toBeTruthy();
      const origin = c.querySelector<HTMLElement>('.origin')!;
      expect(origin.textContent).toContain('task "Replace the session middleware"');
      expect(origin.textContent).toContain('on Luna');
      expect(within(origin).getByText('last 1 events')).toBeTruthy();
      expect(within(origin).getByText('agent.tool_call')).toBeTruthy();
    });

    it('§4.2.19 answers inline: a clarification, a permission, a question a supervisor holds', async () => {
      await openPanel(mode);
      await click(
        within(card(/^clarification question Keep/)).getByRole('button', { name: 'yes' }),
      );
      await click(within(card(/^permission question/)).getByRole('button', { name: 'Allow' }));
      const held = card(/^clarification question Which date/);
      await type(within(held).getByRole('textbox', { name: 'answer' }), 'ISO 8601');
      await click(within(held).getByRole('button', { name: 'Answer' }));
      expect(posts(fetchMock, '/api/questions/q-1/answer')).toEqual([
        { answer: 'yes', version: 3 },
      ]);
      expect(posts(fetchMock, '/api/questions/q-2/answer')).toEqual([
        { answer: 'allow', version: 0 },
      ]);
      expect(posts(fetchMock, '/api/questions/q-3/answer')).toEqual([
        { answer: 'ISO 8601', version: 0 },
      ]);
    });
  });

  describe('§4.2 each agent’s status, its cost so far, its queries answered from the panel', () => {
    /** The text of the `dd` after the `dt` saying `label`, inside `root`. */
    const fact = (root: HTMLElement, label: string) =>
      [...root.querySelectorAll('dt')].find((dt) => dt.textContent === label)?.nextElementSibling
        ?.textContent;
    const barState = () => main().querySelector<HTMLElement>('.pnl-dock-state')!;

    it('§4.2.20 each agent’s status: in the navigation, in the dock bar, on its card', async () => {
      await openPanel(mode);
      expect(within(nav()).getByRole('link', { name: /^Harmonizer\s*working/ })).toBeTruthy();
      expect(within(barState()).getByText('working')).toBeTruthy();
      for (const [kind, id, name] of [
        ['waykeeper', 'a-waykeeper-1', WAYKEEPER],
        ['steward', 'a-steward-1', STEWARD],
        ['steward', 'a-steward-2', ASTEROID_STEWARD],
      ] as const) {
        act(() => useAppStore.getState().navigate({ route: 'panel', selection: { kind, id } }));
        await flush();
        expect(main().getAttribute('aria-label')).toContain(name);
        expect(within(barState()).getByText('working')).toBeTruthy();
      }
    });

    it('§4.2.21 each agent’s cost so far: the Harmonizer, a Waykeeper, the Stewards', async () => {
      await openPanel(mode);
      const cost = (name: string) =>
        within(within(managed()).getByRole('article', { name: `card of ${name}` })).getByRole(
          'definition',
          { name: 'cost so far' },
        ).textContent;
      expect(cost(WAYKEEPER)).toBe('$0.7500');
      expect(cost(ASTEROID_STEWARD)).toBe('$0.3000');
      // The Harmonizer's own, in its status view (P5-05 fix).
      await click(within(main()).getByRole('button', { name: 'Status' }));
      const system = within(main()).getByRole('region', { name: 'system status' });
      expect(fact(system, 'the Harmonizer itself')).toBe('$1.25');
      // The project Steward's, in its view.
      await navTo(/Replace the session middleware/);
      expect(fact(main(), 'cost')).toBe('$0.4200');
    });

    it('§4.2.22 responds to an agent’s query directly from the panel (its view, the inbox)', async () => {
      await openPanel(mode, '/steward/a-steward-1');
      const box = within(main()).getByRole('form', { name: 'answer the clarification' });
      await click(within(box).getByRole('button', { name: 'no' }));
      await click(
        within(within(inbox()).getByRole('article', { name: /^permission question/ })).getByRole(
          'button',
          { name: 'Refuse' },
        ),
      );
      expect(posts(fetchMock, '/api/questions/q-1/answer')).toEqual([{ answer: 'no', version: 3 }]);
      expect(posts(fetchMock, '/api/questions/q-2/answer')).toEqual([{ answer: 'no', version: 0 }]);
    });
  });

  describe('§4.2 control actions on any task, project or agent: direct, instant, no LLM', () => {
    const strip = (name: string) =>
      within(within(main()).getByRole('group', { name: `controls of ${name}` }));
    const T1 = { kind: 'task', id: 't-1' } as const;
    const P1 = { kind: 'project', id: 'p-1' } as const;
    const WK = { kind: 'agent', id: 'a-waykeeper-1' } as const;
    const onTask = (over: Partial<typeof projectTask>) => ({
      path: '/steward/a-steward-1',
      strip: STEWARD,
      world: snapshot({ tasks: [{ ...projectTask, ...over }, asteroidTask] }),
    });
    const onProject = (over: Partial<typeof project>, waykeeperState: AgentState = 'working') => ({
      path: '/waykeeper/a-waykeeper-1',
      strip: WAYKEEPER,
      world: snapshot({
        projects: [{ ...project, ...over }],
        statuses: [
          { ...fx.status, agentId: 'a-harmonizer' },
          { ...fx.status, agentId: 'a-waykeeper-1', state: waykeeperState },
          { ...fx.status, agentId: 'a-steward-1' },
          { ...fx.status, agentId: 'a-steward-2' },
        ],
      }),
    });

    interface Row {
      req: string;
      at: { path: string; strip: string; world: ReturnType<typeof snapshot> };
      /** An inline button of the strip ("Pause the task"), or one in its "More" menu. */
      inline?: string;
      more?: { group: 'task' | 'project' | 'agent'; button: string };
      /** The inline confirmation's "Yes, …" button. */
      confirm?: string;
      sent: ControlBody;
    }
    const ROWS: Row[] = [
      // a task (the Steward view's strip)
      {
        req: '§4.2.23 pause a task',
        at: onTask({}),
        inline: 'Pause the task',
        sent: { target: T1, action: { action: 'pause' } },
      },
      {
        req: '§4.2.24 resume a task',
        at: onTask({ state: 'paused' }),
        inline: 'Resume the task',
        sent: { target: T1, action: { action: 'resume' } },
      },
      {
        req: '§4.2.25 stop a task',
        at: onTask({}),
        more: { group: 'task', button: 'Stop' },
        confirm: 'Yes, stop',
        sent: { target: T1, action: { action: 'stop' } },
      },
      {
        req: '§4.2.26 cancel a task',
        at: onTask({}),
        more: { group: 'task', button: 'Cancel' },
        confirm: 'Yes, cancel',
        sent: { target: T1, action: { action: 'cancel' } },
      },
      {
        req: '§4.2.29 close a task now',
        at: onTask({ state: 'awaiting_closure' }),
        more: { group: 'task', button: 'Close' },
        confirm: 'Yes, close',
        sent: { target: T1, action: { action: 'close' } },
      },
      {
        req: '§4.2.30 archive a task now',
        at: onTask({ state: 'completed' }),
        more: { group: 'task', button: 'Archive now' },
        confirm: 'Yes, archive now',
        sent: { target: T1, action: { action: 'archive' } },
      },
      {
        req: '§4.2.31-1 pin a task (keep it visible)',
        at: onTask({ state: 'completed' }),
        more: { group: 'task', button: 'Pin' },
        sent: { target: T1, action: { action: 'pin', pinned: true } },
      },
      {
        req: '§4.2.31-2 unpin a task',
        at: onTask({ state: 'completed', pinned: true }),
        more: { group: 'task', button: 'Unpin' },
        sent: { target: T1, action: { action: 'pin', pinned: false } },
      },
      {
        req: '§4.2.32 reopen a task',
        at: onTask({ state: 'completed' }),
        more: { group: 'task', button: 'Reopen' },
        sent: { target: T1, action: { action: 'reopen' } },
      },
      // a project (the Waykeeper's dock bar)
      {
        req: '§4.2.33 pause a project',
        at: onProject({}),
        inline: 'Pause the project',
        sent: { target: P1, action: { action: 'pause' } },
      },
      {
        req: '§4.2.34 resume a project',
        at: onProject({ state: 'paused' }),
        inline: 'Resume the project',
        sent: { target: P1, action: { action: 'resume' } },
      },
      {
        req: '§4.2.35 stop a project',
        at: onProject({}),
        more: { group: 'project', button: 'Stop' },
        confirm: 'Yes, stop',
        sent: { target: P1, action: { action: 'stop' } },
      },
      {
        req: '§4.2.36 cancel a project',
        at: onProject({}),
        more: { group: 'project', button: 'Cancel' },
        confirm: 'Yes, cancel',
        sent: { target: P1, action: { action: 'cancel' } },
      },
      {
        req: '§4.2.38 close a project now (and §4.3.21a: from the panel)',
        at: onProject({ state: 'awaiting_closure' }),
        more: { group: 'project', button: 'Close' },
        confirm: 'Yes, close',
        sent: { target: P1, action: { action: 'close' } },
      },
      {
        req: '§4.2.39 archive a project now',
        at: onProject({ state: 'completed' }, 'stopped'),
        more: { group: 'project', button: 'Archive now' },
        confirm: 'Yes, archive now',
        sent: { target: P1, action: { action: 'archive' } },
      },
      {
        req: '§4.2.40 pin a project',
        at: onProject({}),
        more: { group: 'project', button: 'Pin' },
        sent: { target: P1, action: { action: 'pin', pinned: true } },
      },
      {
        req: '§4.2.41 reopen a project',
        at: onProject({ state: 'completed' }, 'stopped'),
        more: { group: 'project', button: 'Reopen' },
        sent: { target: P1, action: { action: 'reopen' } },
      },
      // an agent (the Waykeeper's dock bar; the Steward's own are §4.2.12)
      {
        req: '§4.2.42 pause an agent',
        at: onProject({}),
        inline: 'Pause the agent',
        sent: { target: WK, action: { action: 'pause' } },
      },
      {
        req: '§4.2.43 resume an agent',
        at: onProject({}, 'paused'),
        inline: 'Resume the agent',
        sent: { target: WK, action: { action: 'resume' } },
      },
      {
        req: '§4.2.44 stop an agent',
        at: onProject({}),
        more: { group: 'agent', button: 'Stop' },
        confirm: 'Yes, stop',
        sent: { target: WK, action: { action: 'stop' } },
      },
    ];

    it.each(ROWS)('$req', async (row) => {
      await openPanel(mode, row.at.path, row.at.world);
      const s = strip(row.at.strip);
      if (row.inline) await click(s.getByRole('button', { name: row.inline }));
      else {
        await click(s.getByRole('button', { name: 'More' }));
        const menu = within(main()).getByRole('group', { name: 'more controls' });
        const group = within(menu).getByRole('group', { name: `${row.more!.group} controls` });
        await click(within(group).getByRole('button', { name: row.more!.button }));
      }
      if (row.confirm) {
        // Destructive: nothing goes out before the inline confirmation (decision 56).
        expect(postedPaths(fetchMock)).toEqual([]);
        await click(within(main()).getByRole('button', { name: row.confirm }));
      }
      expect(posts(fetchMock, '/api/control')).toEqual([row.sent]);
      // A direct panel action: one control call, no message to any brain (no LLM in the loop).
      expect(postedPaths(fetchMock)).toEqual(['/api/control']);
    });

    // The Harmonizer itself (P5-06, decision 82): pause / resume, "Resume session" when
    // interrupted, and a confirmed restart; never a plain Stop.
    const HQ = { kind: 'agent', id: 'a-harmonizer' } as const;
    const withHq = (state: AgentState, agents = snapshot()) => {
      const snap = agents as Extract<ReturnType<typeof snapshot>, { type: 'snapshot' }>;
      return {
        ...snap,
        statuses: snap.statuses.map((r) => (r.agentId === 'a-harmonizer' ? { ...r, state } : r)),
      };
    };

    it('§4.2.42h-1 pause and resume the Harmonizer itself', async () => {
      await openPanel(mode);
      expect(strip(HARMONIZER).queryByRole('button', { name: /stop/i })).toBeNull();
      await click(strip(HARMONIZER).getByRole('button', { name: 'Pause the Harmonizer' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: HQ, action: { action: 'pause' } },
      ]);
      cleanup();
      fetchMock = resetPage(mode);
      await openPanel(mode, '/', withHq('paused'));
      await click(strip(HARMONIZER).getByRole('button', { name: 'Resume the Harmonizer' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: HQ, action: { action: 'resume' } },
      ]);
      expect(strip(HARMONIZER).queryByRole('button', { name: 'Resume session' })).toBeNull();
    });

    it('§4.2.42h-2 resume the session of an interrupted Harmonizer', async () => {
      await openPanel(mode, '/', withHq('interrupted'));
      await click(strip(HARMONIZER).getByRole('button', { name: 'Resume session' }));
      expect(postedPaths(fetchMock)).toEqual(['/api/agents/a-harmonizer/recover']);
    });

    it('§4.2.42h-3 restart the Harmonizer (confirmed); the dock follows the new one', async () => {
      await openPanel(mode);
      await click(strip(HARMONIZER).getByRole('button', { name: 'Restart Harmonizer' }));
      // Destructive: nothing goes out before the confirmation, which starts on "Keep".
      expect(postedPaths(fetchMock)).toEqual([]);
      expect(document.activeElement?.textContent).toBe('Keep');
      await click(within(main()).getByRole('button', { name: 'Yes, restart' }));
      expect(postedPaths(fetchMock)).toEqual(['/api/harmonizer/restart']);

      // The server's answer arrives on the stream: the old one stopped, a new one running.
      const before = snapshot() as Extract<ReturnType<typeof snapshot>, { type: 'snapshot' }>;
      const old = before.agents.find((a) => a.id === 'a-harmonizer')!;
      const fresh = { ...old, id: 'a-harmonizer-2', createdAt: '2999-01-01T00:00:00.000Z' };
      const after = withHq('stopped', { ...before, agents: [...before.agents, fresh] });
      after.statuses = [...after.statuses, { ...fx.status, agentId: fresh.id }];
      const socket = FakeWebSocket.instances.at(-1)!;
      await act(async () => socket.serverSends({ ...after, seq: 20 }));
      await flush();
      expect(selection()).toEqual({ kind: 'harmonizer' });
      await click(strip(HARMONIZER).getByRole('button', { name: 'Pause the Harmonizer' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: { kind: 'agent', id: 'a-harmonizer-2' }, action: { action: 'pause' } },
      ]);
    });

    it('§4.2.27 edit a task’s description', async () => {
      const at = onTask({});
      await openPanel(mode, at.path, at.world);
      await click(strip(at.strip).getByRole('button', { name: 'More' }));
      await click(
        within(within(main()).getByRole('group', { name: 'task controls' })).getByRole('button', {
          name: 'Edit',
        }),
      );
      await type(within(main()).getByLabelText('description'), 'Replace the session layer');
      await click(within(main()).getByRole('button', { name: 'Save' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        {
          target: T1,
          action: { action: 'edit', changes: { description: 'Replace the session layer' } },
        },
      ]);
    });

    it('§4.2.28 edit a task’s priority', async () => {
      const at = onTask({});
      await openPanel(mode, at.path, at.world);
      await click(strip(at.strip).getByRole('button', { name: 'More' }));
      await click(
        within(within(main()).getByRole('group', { name: 'task controls' })).getByRole('button', {
          name: 'Edit',
        }),
      );
      await type(within(main()).getByLabelText('priority'), 'high');
      await click(within(main()).getByRole('button', { name: 'Save' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: T1, action: { action: 'edit', changes: { priority: 'high' } } },
      ]);
    });

    it('§4.2.37 edit a project (its name; its trust level)', async () => {
      const at = onProject({});
      await openPanel(mode, at.path, at.world);
      await click(strip(at.strip).getByRole('button', { name: 'More' }));
      await click(
        within(within(main()).getByRole('group', { name: 'project controls' })).getByRole(
          'button',
          { name: 'Edit' },
        ),
      );
      await type(within(main()).getByLabelText('name'), 'Auth rewrite');
      await click(within(main()).getByRole('button', { name: 'Save' }));
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: P1, action: { action: 'edit', changes: { name: 'Auth rewrite' } } },
      ]);
    });

    it('§4.2.45 the same actions from a navigation row’s “⋯” and from the managed-agents card', async () => {
      await openPanel(mode);
      await click(within(nav()).getByRole('button', { name: 'Actions for Auth refactor' }));
      const actions = within(nav()).getByRole('group', { name: 'actions for Auth refactor' });
      await click(within(actions).getByRole('button', { name: 'Pause' }));
      const card = within(managed()).getByRole('article', { name: `card of ${ASTEROID_STEWARD}` });
      await click(
        within(within(card).getByRole('group', { name: /^task controls of/ })).getByRole('button', {
          name: 'Pause',
        }),
      );
      expect(posts(fetchMock, '/api/control')).toEqual([
        { target: P1, action: { action: 'pause' } },
        { target: { kind: 'task', id: 't-2' }, action: { action: 'pause' } },
      ]);
      expect(postedPaths(fetchMock)).toEqual(['/api/control', '/api/control']);
    });
  });

  describe('§4.2 history view and list mode', () => {
    it('§4.2.46a a history view of archived work (/history)', async () => {
      await openPanel(mode);
      await click(screen.getByRole('link', { name: 'History' }));
      expect(window.location.pathname).toBe('/history');
      expect(
        await screen.findByRole('button', { name: 'Inspect Fix the flaky date test' }),
      ).toBeTruthy();
      // The history page replaces the scene (decision 62).
      expect(screen.queryByTestId('solar-scene')).toBeNull();
    });

    it('§4.2.46b … and of past questions (/history)', async () => {
      await openPanel(mode);
      await click(screen.getByRole('link', { name: 'History' }));
      expect(window.location.pathname).toBe('/history');
      expect(await screen.findByText('Tabs or spaces?')).toBeTruthy();
    });

    it('§4.2.47 the panel works with the 3D scene hidden (list mode)', async () => {
      await openPanel(mode);
      if (mode.scene) {
        await click(screen.getByRole('button', { name: 'Hide scene' }));
        expect(screen.queryByTestId('solar-scene')).toBeNull();
      }
      expect(screen.getByRole('button', { name: 'Show scene' })).toBeTruthy();
      // Still the whole panel: navigation, chat, managed agents, inbox.
      expect(nav()).toBeTruthy();
      expect(within(main()).getByRole('region', { name: `chat with ${HARMONIZER}` })).toBeTruthy();
      expect(managed()).toBeTruthy();
      expect(inbox()).toBeTruthy();
    });
  });
});
