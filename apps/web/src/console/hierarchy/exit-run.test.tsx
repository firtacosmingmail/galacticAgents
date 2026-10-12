// @vitest-environment jsdom
//
// P2-18 acceptance: the Phase 2 exit run driven entirely from the hierarchy console. A real
// server surface — the composed runtime (event log, commands, runtime, status store, workspaces on
// a temp folder with real git) behind the real Fastify routes — with the real Harmonizer and
// Waykeeper definitions whose "models" are P2-07 scripts, and fake-adapter Stewards that ask,
// request permission, commit in their worktrees and finish. The page is fed the way the session
// feeds it (snapshot, then every committed event, status diffs and transcript chunks) and every
// user step is a click or a keystroke on the page, sent through `/api` (Fastify `inject`).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id, Question } from '@galactic/protocol';
import {
  SCENARIOS,
  brainHarness,
  buildApp,
  buildSnapshot,
  firstTurn,
  gitRunner,
  harmonizerBrain,
  waykeeperDefinition,
  type App,
  type BrainHarness,
  type FakeScenario,
  type ServerConfig,
  type TurnContext,
} from '@galactic/server';
import { useAppStore } from '../../state/store.js';
import { createApi } from '../api.js';
import { HierarchyConsole } from './HierarchyConsole.js';

const TOKEN = 'exit-run-token-0123456789';
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const LONG = { timeout: 20_000 };
const REQUEST = 'Start a new project: build a CLI that converts CSV to Parquet';
const NAME = 'CSV to Parquet';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@test', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

let tmp: string;
let h: BrainHarness;
let app: App;
let scenarios: Record<string, FakeScenario>;
const unsubscribe: (() => void)[] = [];

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-exit-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  scenarios = { ...SCENARIOS };
  h = brainHarness({
    adapter: { scenarios },
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

  // The page's stream, as `startSession` would feed it.
  const store = useAppStore.getState();
  store.reset();
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
      open.set(
        agentId,
        transcripts.subscribe(agentId, 0, (chunks) =>
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

const task = (id: Id) => h.log.tables.tasks.get(id)!;
/** A click; the action it starts settles before the next step (the page's widgets run one at a time). */
const click = async (el: Element) => {
  fireEvent.click(el);
  await new Promise((r) => setTimeout(r, 10));
};

/** The tasks named "agent … finished" in a Waykeeper's turn prompt. */
const finishedTasks = (prompt: string): Id[] =>
  [...prompt.matchAll(/agent (\S+) finished/g)]
    .map((m) => h.log.tables.agents.get(m[1]!)?.taskId)
    .filter((t): t is Id => t !== undefined);

describe('the Phase 2 exit run from the hierarchy console (P2-18)', () => {
  it('request → card → body → plan → Stewards in worktrees → questions → merges → closure', async () => {
    const root = join(tmp, 'projects');
    const workspace = join(root, 'csv2parquet');
    let plan: Id[] = [];
    let relayed: { mine: Id; theirs: Id } | undefined;
    let closureQuestion: Id | undefined;

    // -- the Stewards: one asks a clarification its Waykeeper answers from context; the other
    //    asks one that goes up to the user, then needs a permission; both commit and finish.
    const commit = (taskId: Id, file: string) => {
      const wt = task(taskId).worktreePath!;
      writeFileSync(join(wt, file), `${file}\n`);
      git(wt, 'add', file);
      git(wt, 'commit', '-q', '-m', `add ${file}`);
    };
    scenarios['reader'] = {
      steps: [
        { kind: 'ask', text: 'Which CSV delimiter should the reader assume?' },
        { kind: 'script', run: async () => commit(plan[0]!, 'reader.txt') },
        { kind: 'finish', result: 'Done: the CSV reader.' },
      ],
    };
    scenarios['writer'] = {
      steps: [
        {
          kind: 'ask',
          text: 'Overwrite existing Parquet files?',
          options: ['yes', 'no'],
        },
        {
          kind: 'permission',
          toolName: 'Bash',
          input: { command: 'rm -rf out' },
          permissionAction: 'destructive',
        },
        { kind: 'script', run: async () => commit(plan[1]!, 'writer.txt') },
        { kind: 'finish', result: 'Done: the Parquet writer.' },
      ],
    };

    // -- the Waykeeper's "model": plan once, spawn, answer or escalate, merge, close, ask closure.
    const waykeeper = h.script('waykeeper');
    waykeeper
      .once(firstTurn, async (t) => {
        // A first-turn tool call works even for a brain started from inside another brain's tool
        // (P2-16 fixed the race P2-18 found).
        const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
          summary: 'Reader and writer',
          rationale: 'Two separable pieces',
          tasks: [{ description: 'read CSV' }, { description: 'write Parquet' }],
        });
        plan = out.tasks.map((x) => x.taskId);
      })
      .once(/proposal \S+ was approved/, async (t) => {
        await t.call('spawn_steward', { taskId: plan[0], instructions: 'scenario:reader' });
        await t.call('spawn_steward', { taskId: plan[1], instructions: 'scenario:writer' });
      })
      .on(/asked (q-\S+) \(held by you\)/, async (t) => {
        for (const [, id, text] of t.prompt.matchAll(/asked (q-\S+) \(held by you\): "([^"]*)"/g)) {
          if (text!.startsWith('Which CSV delimiter')) {
            // Answerable from the plan's context (decision 12): logged, shown read-only.
            await t.call('answer_question', { questionId: id, answer: 'comma (RFC 4180)' });
          } else {
            await t.call('escalate', { questionId: id });
            return;
          }
        }
      })
      .on(/finished/, async (t: TurnContext) => {
        for (const taskId of finishedTasks(t.prompt)) {
          const merged = await t.call<{ merged: boolean }>('merge_task', { taskId });
          if (!merged.merged) continue;
          const closed = await t.call<{ allTasksClosed?: boolean }>('close_task', { taskId });
          if (closed.allTasksClosed) {
            await t.call('request_project_closure', { summary: 'The CLI is built.' });
            return;
          }
        }
      });

    // -- the Harmonizer's "model": a work card, the Waykeeper, the relay, the closure question.
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
    const projectId = () => h.log.tables.projects.all().find((p) => p.name === NAME)!.id;
    await h.startHarmonizer({
      definition,
      scriptOptions: { strict: false },
      script: (s) =>
        s
          .once(/CSV to Parquet/, async (t) => {
            const related = await t.call<unknown[]>('find_related_work', { request: REQUEST });
            expect(related).toEqual([]);
            await t.call('propose', {
              type: 'new_project',
              requestText: REQUEST,
              name: NAME,
              kind: 'planet',
              rationale: 'A new application of its own',
            });
          })
          .once(/proposal (\S+) was approved/, async (t) => {
            const proposalId = /proposal (\S+) was approved/.exec(t.prompt)![1]!;
            const project = await t.call<{ projectId: Id }>('create_project', { proposalId });
            await t.call('spawn_waykeeper', { projectId: project.projectId });
          })
          .on(/(q-\S+) was escalated from agent \S+ to you/, async (t) => {
            const theirs = /(q-\S+) was escalated from agent \S+ to you/.exec(t.prompt)![1]!;
            const original = h.log.tables.questions.get(theirs)!;
            const out = await t.call<{ questionId: Id }>('ask_user', {
              text: `The writer Steward asks: ${original.context.text}`,
              options: ['yes', 'no'],
            });
            relayed = { mine: out.questionId, theirs };
          })
          .on(/you answered|user answered/, async (t) => {
            if (relayed && t.prompt.includes(`answered ${relayed.mine}`)) {
              const answer = h.log.tables.questions.get(relayed.mine)!.answer!;
              await t.call('answer_question', { questionId: relayed.theirs, answer });
            }
            if (closureQuestion && t.prompt.includes(`answered ${closureQuestion}: "Close`)) {
              await t.call('close_project', { projectId: projectId() });
              t.say(`Closed ${NAME}.`);
            }
          })
          .on(/every task is closed/, async (t) => {
            const out = await t.call<{ questionId: Id }>('ask_closure', {
              projectId: projectId(),
            });
            closureQuestion = out.questionId;
          }),
    });

    render(<HierarchyConsole token={TOKEN} api={createApi(TOKEN, injectFetch)} />);
    try {
      // 1. The request, typed to the Harmonizer.
      const chat = await screen.findByLabelText('chat with Harmonizer');
      fireEvent.change(within(chat).getByLabelText('message to Harmonizer'), {
        target: { value: REQUEST },
      });
      await click(within(chat).getByText('Send'));

      // 2. The sizing card: the user confirms another workspace, then approves.
      const card = await screen.findByLabelText(`proposal ${REQUEST}`, {}, LONG);
      expect(within(card).getByText('new project')).toBeTruthy();
      expect(within(card).getByText('planet')).toBeTruthy();
      await click(within(card).getByText('Edit'));
      const form = within(card).getByLabelText('edit card');
      fireEvent.change(within(form).getByDisplayValue(/csv-to-parquet|CSV/i), {
        target: { value: workspace },
      });
      await click(within(form).getByText('Save'));
      await waitFor(() => expect(h.log.tables.proposals.all()[0]?.workspace).toBe(workspace));
      await click(within(screen.getByLabelText(`proposal ${REQUEST}`)).getByText('Approve'));

      // 3. A planet, a Waykeeper, and its plan as one card.
      const planCard = await screen.findByLabelText('plan Reader and writer', {}, LONG);
      const project = h.log.tables.projects.get(projectId())!;
      expect(h.log.tables.bodies.get(project.bodyId)?.kind).toBe('planet');
      expect(project.workspace).toBe(workspace);
      expect(within(planCard).getByText(/read CSV/)).toBeTruthy();
      await click(within(planCard).getByText('Approve plan'));

      // 4. Two Stewards in their own worktrees; the reader's clarification is answered by the
      //    Waykeeper from context — visible read-only in the inbox.
      const inbox = screen.getByLabelText('question inbox');
      await waitFor(
        () =>
          within(inbox).getByLabelText(
            'answered question Which CSV delimiter should the reader assume?',
          ),
        LONG,
      );
      expect(
        within(inbox).getByLabelText(
          'answered question Which CSV delimiter should the reader assume?',
        ).textContent,
      ).toMatch(/Waykeeper · CSV to Parquet answered: “comma \(RFC 4180\)”/);
      const stewards = h.log.tables.agents.all().filter((a) => a.role === 'steward');
      expect(stewards).toHaveLength(2);
      expect(new Set(plan.map((id) => task(id).worktreePath)).size).toBe(2);

      // 5. The writer's clarification was escalated to the user (through the Harmonizer): answered
      //    inline in the inbox.
      const relay = await screen.findByLabelText(
        'clarification question The writer Steward asks: Overwrite existing Parquet files?',
        {},
        LONG,
      );
      expect(within(relay).getByText('held by you')).toBeTruthy();
      await click(within(relay).getByText('yes'));

      // 6. Its permission request, with the tool call and the action, answered by the user.
      const permission = await screen.findByLabelText(/permission question/, {}, LONG);
      expect(permission.textContent).toMatch(/destructive/);
      expect(permission.textContent).toMatch(/rm -rf out/);
      // A project Steward's request: Allow once, beside Allow similar (P9-17).
      expect(within(permission).getByText(/^Allow similar for /)).toBeTruthy();
      await click(within(permission).getByText('Allow once'));

      // 7. Merged branches, tasks closed, the closure question relayed: the user closes.
      const closure = await screen.findByLabelText(
        new RegExp(`clarification question Anything else on ${NAME}\\?`),
        {},
        LONG,
      );
      await click(within(closure).getByText(`Close ${NAME}`));
      await waitFor(
        () => expect(h.log.tables.projects.get(projectId())?.state).toBe('completed'),
        LONG,
      );

      // The tree shows it all: the completed project and its completed tasks.
      const tree = screen.getByLabelText(`project ${NAME}`);
      await waitFor(() =>
        expect(tree.querySelector('.node-head')?.textContent).toMatch(/^completed/),
      );
      expect(within(tree).getByLabelText('task read CSV').textContent).toMatch(/completed/);
      expect(within(tree).getByLabelText('task write Parquet').textContent).toMatch(/completed/);
      expect(git(workspace, 'ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual([
        'reader.txt',
        'writer.txt',
      ]);
      // Every question is resolved: nothing waits for the user.
      const open = Object.values(useAppStore.getState().world.questions).filter(
        (q: Question) => q.status === 'open',
      );
      expect(open).toEqual([]);
      expect(screen.getByLabelText('summary').textContent).toMatch(/open questions 0/);
      // The Harmonizer's chat carries the closure report from the Waykeeper.
      expect(within(chat).getByRole('log').textContent).toMatch(/every task is closed/);
    } catch (e) {
      console.log('brain transcripts:', h.report(), h.errors);
      throw e;
    }
  }, 60_000);
});
