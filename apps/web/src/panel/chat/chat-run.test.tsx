// @vitest-environment jsdom
//
// P25-03 acceptance against a real server surface: the composed runtime behind the real Fastify
// routes (`/api/agents/:id/send`, `/conversation`, `/api/proposals/:id/decide`), the real
// Harmonizer and Waykeeper definitions whose "models" are P2-07 scripts, and the panel fed the
// way the session feeds it — snapshot, every committed event, status diffs, and the transcript
// from where the open chat's history ended (`conversationSince`, as `startSession` does).
// A request typed in the panel's chat produces a proposal card in the same thread; the
// Waykeeper's conversation shows its plan card.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import {
  brainHarness,
  buildApp,
  buildSnapshot,
  firstTurn,
  gitRunner,
  harmonizerBrain,
  waykeeperDefinition,
  type App,
  type BrainHarness,
  type ServerConfig,
} from '@galactic/server';
import { createApi } from '../../console/api.js';
import { conversationSince, useConversationStore } from '../../state/conversation.js';
import { useAppStore } from '../../state/store.js';
import { Panel } from '../Panel.js';

const TOKEN = 'chat-run-token-0123456789';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const LONG = { timeout: 20_000 };
const REQUEST = 'Start a new project: a tiny URL shortener';
const NAME = 'URL shortener';

let tmp: string;
let h: BrainHarness;
let app: App;
const unsubscribe: (() => void)[] = [];
const since: Record<Id, number> = {};

beforeEach(async () => {
  window.history.replaceState(null, '', '/');
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-chat-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  h = brainHarness({
    script: { strict: false },
    compose: {
      workspaces: {
        projectsRoot: join(tmp, 'projects'),
        dataDir: join(tmp, 'data'),
        home: join(tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
    },
  });
  const config: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    allowedHosts: ['localhost', '127.0.0.1'],
    dev: false,
    dataDir: join(tmp, 'data'),
    configPath: join(tmp, 'data', 'config.json'),
    dbPath: ':memory:',
    projectsRoot: join(tmp, 'projects'),
    autoApproveRemote: false,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    caps: {
      maxConcurrentAgents: 4,
      maxStewardsPerWaykeeper: 3,
      maxSpawnsPerHour: 30,
      maxSpawnsPerHourPerBrain: 20,
    },
  };
  const { log, statuses, transcripts, runtime, commands } = h.composed;
  app = buildApp({ config, log, statuses, transcripts, runtime, commands });
  await app.fastify.ready();

  const store = useAppStore.getState();
  store.reset();
  useConversationStore.getState().reset();
  store.apply({ type: 'snapshot', ...buildSnapshot(log, statuses) });
  useAppStore.setState({ status: 'live' });
  unsubscribe.push(log.subscribe((envelope) => store.apply({ type: 'event', ...envelope })));
  unsubscribe.push(
    statuses.subscribe((records, removed) =>
      store.apply({ type: 'status', statuses: records, removed }),
    ),
  );
  const open = new Map<Id, () => void>();
  useAppStore.setState({
    subscribeTranscript: (agentId) => {
      if (open.has(agentId)) return;
      // As the session's `transcriptSince`: from where the open chat's history page ended.
      const from = Math.max(
        useAppStore.getState().transcripts[agentId]?.at(-1)?.seq ?? 0,
        conversationSince(agentId),
      );
      since[agentId] = from;
      open.set(
        agentId,
        transcripts.subscribe(agentId, from, (chunks) =>
          useAppStore.getState().apply({ type: 'transcript', agentId, chunks }),
        ),
      );
    },
    unsubscribeTranscript: (agentId) => {
      open.get(agentId)?.();
      open.delete(agentId);
    },
  });
  unsubscribe.push(() => {
    for (const close of open.values()) close();
  });
});

afterEach(async () => {
  cleanup();
  for (const u of unsubscribe.splice(0)) u();
  await h.dispose().catch(() => {});
  await app.close().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
  window.history.replaceState(null, '', '/');
});

/** `fetch` for the page's api: straight into the Fastify routes, as a local client. */
const injectFetch = (async (url: string, init?: RequestInit) => {
  const res = await app.fastify.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST',
    url,
    headers: { host: 'localhost', ...((init?.headers as Record<string, string>) ?? {}) },
    ...(init?.body ? { payload: init.body as string } : {}),
  });
  return new Response(res.body, { status: res.statusCode });
}) as unknown as typeof fetch;

const settle = () => new Promise((r) => setTimeout(r, 10));

describe('the panel chat against a real server (P25-03)', () => {
  it('a request typed in the chat gets its card in the thread; the Waykeeper shows its plan', async () => {
    const root = join(tmp, 'projects');
    h.script('waykeeper').once(firstTurn, async (t) => {
      await t.call('plan_tasks', {
        summary: 'Store and redirect',
        rationale: 'Two separable pieces',
        tasks: [{ description: 'store short links' }, { description: 'redirect them' }],
      });
      t.say('Here is the plan: two tasks.');
    });
    const definition = harmonizerBrain({
      projectsRoot: root,
      startWaykeeper: async ({ projectId, supervisorId }) => {
        const wk = await h.startBrain(waykeeperDefinition(), {
          runtime: 'fake',
          projectId,
          supervisorId,
        });
        return { agentId: wk.agentId };
      },
    });
    const harmonizer = await h.startHarmonizer({
      definition,
      scriptOptions: { strict: false },
      script: (s) =>
        s
          .once(/URL shortener/, async (t) => {
            await t.call('propose', {
              type: 'new_project',
              requestText: REQUEST,
              name: NAME,
              kind: 'planet',
              rationale: 'An application of its own',
            });
            t.say('That is a new project: please confirm the card.');
          })
          .once(/proposal (\S+) was approved/, async (t) => {
            const proposalId = /proposal (\S+) was approved/.exec(t.prompt)![1]!;
            const project = await t.call<{ projectId: Id }>('create_project', { proposalId });
            await t.call('spawn_waykeeper', { projectId: project.projectId });
          }),
    });

    render(<Panel token={TOKEN} api={createApi(TOKEN, injectFetch)} />);
    try {
      const chat = await screen.findByRole('region', { name: 'chat with Harmonizer' });
      const thread = within(chat).getByRole('log');
      await waitFor(() => expect(since[harmonizer.agentId]).toBeDefined());

      // 1. The request, typed in the panel's composer.
      fireEvent.change(within(chat).getByLabelText('message to Harmonizer'), {
        target: { value: REQUEST },
      });
      fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
      await settle();

      // 2. The card is in the same thread, after the request, with the brain's reply.
      const card = await within(thread).findByLabelText(`proposal ${REQUEST}`, {}, LONG);
      await within(thread).findByText('That is a new project: please confirm the card.', {}, LONG);
      const order = [...thread.querySelectorAll('[data-entry], [data-card]')].map(
        (n) => n.getAttribute('data-card') ?? n.textContent,
      );
      expect(order.findIndex((x) => x?.includes(REQUEST))).toBeLessThan(
        order.indexOf(h.log.tables.proposals.all()[0]!.id),
      );
      const lines = (log: HTMLElement, text: string) =>
        [...log.querySelectorAll('[data-entry]')].filter((n) => n.textContent?.includes(text));
      expect(lines(thread, REQUEST)).toHaveLength(1);
      expect(within(chat).queryByText('sending…')).toBeNull();

      // 3. Approved inline: a planet, a Waykeeper, its plan.
      fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
      await waitFor(
        () => expect(h.log.tables.proposals.all().some((p) => p.meta?.['plan'])).toBe(true),
        LONG,
      );
      await waitFor(() =>
        expect(within(thread).queryByRole('button', { name: 'Approve' })).toBeNull(),
      );

      // 4. The Waykeeper's conversation shows its plan card (and not the Harmonizer's card).
      const wk = h.log.tables.agents.all().find((a) => a.role === 'waykeeper')!;
      await waitFor(() => expect(useAppStore.getState().world.agents[wk.id]).toBeDefined());
      const nav = screen.getByRole('navigation', { name: 'navigation' });
      fireEvent.click(within(nav).getByRole('link', { name: new RegExp(NAME) }));
      const wkChat = await screen.findByRole('region', {
        name: `chat with Waykeeper · ${NAME}`,
      });
      const wkThread = within(wkChat).getByRole('log');
      const plan = await within(wkThread).findByLabelText('plan Store and redirect', {}, LONG);
      expect(within(plan).getByText(/store short links/)).toBeTruthy();
      expect(within(plan).getByRole('button', { name: 'Approve plan' })).toBeTruthy();
      expect(within(wkThread).queryByLabelText(`proposal ${REQUEST}`)).toBeNull();
      await within(wkThread).findByText('Here is the plan: two tasks.', {}, LONG);

      // 5. Back to the Harmonizer (one click): the history is read again, no line twice.
      fireEvent.click(within(screen.getByRole('main')).getByRole('link', { name: '← Harmonizer' }));
      const again = await screen.findByRole('region', { name: 'chat with Harmonizer' });
      const log = within(again).getByRole('log');
      await within(log).findByText('That is a new project: please confirm the card.');
      expect(lines(log, REQUEST)).toHaveLength(1);
      expect(
        within(log).getAllByText('That is a new project: please confirm the card.'),
      ).toHaveLength(1);
      expect(within(log).getByLabelText(`work card ${REQUEST}`)).toBeTruthy();
    } catch (e) {
      console.log('brain transcripts:', h.report(), h.errors);
      throw e;
    }
  }, 60_000);
});
