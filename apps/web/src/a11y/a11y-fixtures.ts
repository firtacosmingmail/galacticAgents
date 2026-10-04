import { act, render } from '@testing-library/react';
import { createElement } from 'react';
import { expect, vi } from 'vitest';
import axe from 'axe-core';
import {
  DEFAULT_PERMISSION_POLICY,
  type HistoryQuestionsResponse,
  type HistoryWorkDetail,
  type HistoryWorkResponse,
  type PreflightResponse,
  type SettingsResponse,
} from '@galactic/protocol';
import type {
  Agent,
  Project,
  Proposal,
  Question,
  ServerMessage,
  StatusRecord,
  Task,
} from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { App } from '../App.js';
import { FakeWebSocket } from '../client/fake-socket.js';
import { useAppStore } from '../state/store.js';

/**
 * P5-04: one world with every panel surface populated — a Harmonizer, a project's Waykeeper with a
 * Steward, an asteroid Steward, open questions of both kinds held by the user and by a supervisor,
 * a supervisor's answer, a waiting card, a parked card and a plan — for the accessibility checks
 * and the keyboard tests.
 */

const later = (s: number) => new Date(Date.parse(fx.NOW) + s * 1000).toISOString();

export const waykeeper: Agent = {
  ...fx.harmonizer,
  id: 'a-waykeeper-1',
  role: 'waykeeper',
  projectId: 'p-1',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-kepler',
};
export const asteroidSteward: Agent = {
  ...fx.agent,
  id: 'a-steward-2',
  taskId: 't-2',
  supervisorId: 'a-harmonizer',
  bodyId: 'b-ast-1',
};
const billing: Project = {
  ...fx.project,
  id: 'p-2',
  name: 'Billing export',
  bodyId: 'b-luna',
  state: 'in_progress',
  createdAt: later(60),
};
const billingWaykeeper: Agent = { ...waykeeper, id: 'a-waykeeper-2', projectId: 'p-2' };
const quietAsteroid: Task = {
  ...fx.asteroidTask,
  id: 't-3',
  description: 'Bump the lint rules',
  state: 'in_progress',
  blockedBy: [],
};
/** Archived work and its Steward, for the history page. */
export const archivedTask: Task = {
  ...fx.asteroidTask,
  id: 't-old',
  description: 'Fix the flaky date test',
  blockedBy: [],
  state: 'archived',
  updatedAt: '2026-10-01T09:00:00.000Z',
};
const oldSteward: Agent = { ...fx.agent, id: 'a-st-old', taskId: 't-old', bodyId: 'b-ast-1' };
const working = (agentId: string): StatusRecord => ({ ...fx.status, agentId });

const { answer: _a, answeredBy: _b, ...permissionBase } = fx.permissionQuestion;
export const clarification: Question = { ...fx.question, holder: { type: 'user' }, version: 3 };
export const permission: Question = {
  ...permissionBase,
  status: 'open',
  version: 0,
  createdAt: later(5),
  updatedAt: later(5),
};
const supervisorHeld: Question = {
  ...fx.question,
  id: 'q-3',
  context: { ...fx.question.context, text: 'Which date format?' },
  createdAt: later(-60),
};
const supervisorAnswered: Question = {
  ...fx.question,
  id: 'q-4',
  context: { ...fx.question.context, text: 'Tabs or spaces?' },
  status: 'answered',
  answer: 'spaces',
  answeredBy: { type: 'agent', id: 'a-waykeeper-1' },
  version: 1,
};
const card: Proposal = { ...fx.proposal, createdAt: later(-120) };
const parkedCard: Proposal = {
  ...fx.proposal,
  id: 'pr-2',
  requestText: 'Build a billing service',
  kind: 'planet',
  proposedBody: { kind: 'planet', name: 'Billing' },
  state: 'parked',
  createdAt: later(-300),
  meta: {
    parked: {
      reason: 'no free planet',
      waitingFor: 'planet',
      occupied: [
        {
          bodyId: 'b-kepler',
          bodyName: 'Kepler',
          host: { kind: 'project', id: 'p-1' },
          occupant: 'Auth refactor',
          state: 'in_progress',
        },
      ],
      offers: ['downsize_moon', 'close_early'],
    },
  },
};

export function fullSnapshot(
  over: Partial<ServerMessage & { type: 'snapshot' }> = {},
): ServerMessage {
  return {
    type: 'snapshot',
    logId: 'log-a',
    seq: 10,
    agents: [fx.harmonizer, waykeeper, billingWaykeeper, fx.agent, asteroidSteward, oldSteward],
    bodies: [fx.body, fx.moon, fx.asteroid],
    projects: [fx.project, billing],
    tasks: [fx.task, fx.asteroidTask, quietAsteroid, archivedTask],
    questions: [clarification, permission, supervisorHeld, supervisorAnswered],
    proposals: [card, parkedCard],
    statuses: [
      working('a-harmonizer'),
      working('a-waykeeper-1'),
      working('a-waykeeper-2'),
      working('a-steward-1'),
      working('a-steward-2'),
    ],
    ...over,
  } as ServerMessage;
}

export function settingsResponse(setupDone = true): SettingsResponse {
  return {
    settings: {
      projectsRoot: '/Users/me/GalacticProjects',
      defaultPermissionPolicy: structuredClone(DEFAULT_PERMISSION_POLICY),
      retentionDays: 7,
      caps: {
        maxConcurrentAgents: 4,
        maxStewardsPerWaykeeper: 3,
        maxSpawnsPerHour: 30,
        maxSpawnsPerHourPerBrain: 20,
        maxWallClockMs: 7_200_000,
        maxToolCalls: 500,
      },
      qualityTier: 'high',
      stewardsLoadUserSettings: true,
    },
    envOverrides: [],
    restartRequired: [],
    ...(setupDone ? { setupCompletedAt: '2026-10-03T10:05:00.000Z' } : {}),
  };
}

export const preflightReady: PreflightResponse = {
  ok: true,
  checkedAt: '2026-10-03T10:01:00.000Z',
  runtimes: [
    {
      runtime: 'claude-sdk',
      ok: true,
      installed: true,
      version: '2.1.0',
      sdkVersion: '0.2.0',
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      problems: [],
    },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A `fetch` that answers every panel endpoint with something harmless. */
export function quietFetch(
  extra?: (url: string, init?: RequestInit) => Response | undefined,
  { setupDone = true }: { setupDone?: boolean } = {},
) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const special = extra?.(url, init);
    if (special) return special;
    if (url === '/api/settings') return new Response(JSON.stringify(settingsResponse(setupDone)));
    if (url.startsWith('/api/preflight')) return new Response(JSON.stringify(preflightReady));
    if (url.endsWith('/messages')) return new Response(JSON.stringify({ messages: [] }));
    if (url.includes('/transcript')) return new Response(JSON.stringify({ chunks: [] }));
    const path = new URL(url, 'http://x').pathname;
    if (path === '/api/history/work')
      return json({
        items: [{ kind: 'task', item: archivedTask, cursor: 'c-1' }],
        hasMore: false,
      } satisfies HistoryWorkResponse);
    if (path === '/api/history/questions')
      return json({
        items: [{ question: supervisorAnswered, cursor: 'c-q' }],
        hasMore: false,
      } satisfies HistoryQuestionsResponse);
    if (path === '/api/history/work/task/t-old')
      return json({
        work: { kind: 'task', item: archivedTask },
        bodyName: 'Ceres',
        trail: { moves: [], archivedAt: '2026-10-01T09:00:00.000Z' },
        states: [{ at: '2026-10-01T09:00:00.000Z', from: 'completed', to: 'archived' }],
        tasks: [],
        subProjects: [],
        agents: [oldSteward],
        questions: [],
        moreQuestions: false,
      } satisfies HistoryWorkDetail);
    return new Response('{}');
  });
}

/** Renders the app at a URL and feeds it a snapshot over the fake socket. */
export async function openApp(
  path: string,
  initial: ServerMessage = fullSnapshot(),
): Promise<void> {
  window.history.replaceState(null, '', path);
  // The store keeps the route across tests (`reset()` leaves it): start from this URL's, or the
  // previous test's route changes to this one after mount and the route focus moves the focus
  // to the main heading in the middle of this test.
  useAppStore.getState().syncFromLocation();
  render(createElement(App));
  await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  await act(async () => {
    socket.serverOpens();
    socket.serverSends(initial);
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
}

/** A `matchMedia` stand-in: the listed queries match, nothing else does. */
export function stubMedia(matching: string[]) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

export interface AxeFinding {
  id: string;
  impact: string | null | undefined;
  /** `incomplete`: axe could not decide on its own (it asks for a review); counted all the same. */
  result: 'violation' | 'incomplete';
  help: string;
  targets: string[];
}

/**
 * Runs axe-core over the document (WCAG 2.x A/AA and best practices) and returns its violations
 * and the findings it could not decide alone ("incomplete": an `aria-label` on an element whose
 * role may not carry one, say), which the check treats like violations. Colour contrast needs a
 * layout engine and real CSS, neither of which jsdom has, so it is left to the manual check in the
 * P5-04 notes.
 */
export async function axeFindings(root: Element = document.body): Promise<AxeFinding[]> {
  const result = await axe.run(root, {
    resultTypes: ['violations', 'incomplete'],
    rules: { 'color-contrast': { enabled: false } },
  });
  const map = (result: AxeFinding['result']) => (v: axe.Result) => ({
    id: v.id,
    impact: v.impact,
    result,
    help: v.help,
    targets: v.nodes.map((n) => n.target.join(' ')),
  });
  return [...result.violations.map(map('violation')), ...result.incomplete.map(map('incomplete'))];
}

/** The findings that fail the check: serious and critical ones. */
export const blocking = (all: AxeFinding[]) =>
  all.filter((f) => f.impact === 'serious' || f.impact === 'critical');
