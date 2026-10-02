import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_POLICY,
  type Event,
  type Id,
  type PermissionPolicy,
  type Project,
  type Task,
} from '@galactic/protocol';
import { SCENARIOS, type FakeScenario, type FakeStep } from '../adapters/fake/scenario.js';
import { DEFAULT_CAPS } from '../runtime/caps.js';
import { gitRunner } from '../workspace/git.js';
import { harmonizerBrain } from './harmonizer/index.js';
import {
  brainHarness,
  type BrainHarness,
  type BrainScript,
  type TurnContext,
} from './testing/index.js';
import { waykeeperDefinition } from './waykeeper/index.js';

/**
 * P2-11 acceptance: the Steward lifecycle end to end on the P2-07 harness — real Waykeeper and
 * Harmonizer definitions driven by scripted models, real `DomainCommands`, a real workspace
 * service on a temp git repository, and fake Stewards that work and then *report by ending their
 * turn* (no `finish`): the report wakes the supervisor, which merges and closes.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const USER = { type: 'user' } as const;
const LONG = { timeoutMs: 20_000 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=user@test', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}

let tmp: string;
let h: BrainHarness;
let scenarios: Record<string, FakeScenario>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-st-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  scenarios = { ...SCENARIOS };
  h = brainHarness({
    adapter: { scenarios },
    compose: {
      workspaces: {
        projectsRoot: join(tmp, 'projects'),
        dataDir: join(tmp, 'data'),
        home: join(tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
    },
  });
});
afterEach(async () => {
  await h.dispose().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

const task = (id: Id): Task => h.log.tables.tasks.get(id)!;
const events = (): Event[] => h.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
const reportsTo = (supervisorId: Id) =>
  events().filter(
    (e): e is Extract<Event, { type: 'message.sent' }> =>
      e.type === 'message.sent' && e.agentId === supervisorId && e.sender.type === 'agent',
  );

/** A Steward scenario: a scripted stretch of work, then output lines; the turn then ends idle. */
function scenario(name: string, steps: FakeStep[], onMessage?: FakeScenario['onMessage']): void {
  scenarios[name] = { steps, ...(onMessage ? { onMessage } : {}) };
}

describe('Steward lifecycle (P2-11)', () => {
  it('a project task: spawned in its worktree under the project policy, reports done by ending its turn, the Waykeeper merges and closes', async () => {
    const dir = join(tmp, 'home', 'Notes app');
    const strict: PermissionPolicy = {
      rules: { ...DEFAULT_PERMISSION_POLICY.rules, network: 'deny' },
    };
    const created = (
      await h.commands.createProject({
        name: 'Notes app',
        workspace: dir,
        permissionPolicy: strict,
      })
    ).value;
    await h.composed.workspaces!.prepareProject(created.id);
    const project: Project = h.log.tables.projects.get(created.id)!;
    let taskId: Id = '';
    let fetched: unknown;
    scenario('write-notes', [
      {
        kind: 'script',
        run: async (io) => {
          // The project's table holds for the Steward: network is denied, no question asked.
          fetched = await io.toolCall('WebFetch', { url: 'https://example.com' });
          const wt = task(taskId).worktreePath!;
          writeFileSync(join(wt, 'notes.md'), '# Notes\n');
          git(wt, 'add', 'notes.md');
          git(wt, 'commit', '-q', '-m', 'add notes');
          io.output('Committed notes.md on my branch.');
          io.output('Done: added notes.md with a heading; nothing left over.');
        },
      },
    ]);

    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once(/was added to your project/, async (t) => {
              await t.call('spawn_steward', {
                taskId,
                instructions:
                  'scenario:write-notes\nAdd notes.md with a heading. Done when committed.',
              });
            })
            .once(/reported: .*Its report: Done:/, async (t) => {
              const merged = await t.call<{ merged: boolean }>('merge_task', { taskId });
              expect(merged.merged).toBe(true);
              await t.call('close_task', { taskId });
            }),
      },
    );
    taskId = (
      await h.commands.createTask({ description: 'write the notes', projectId: project.id })
    ).value.id;
    await h.until(() => task(taskId).state === 'completed', {
      ...LONG,
      what: 'the task to be closed',
    });
    await h.done(LONG);

    wk.assertCalls(['spawn_steward', 'merge_task', 'close_task']);
    // Spawned where the hierarchy puts it, with the project's policy and the default caps.
    const steward = h.log.tables.agents.all().find((a) => a.role === 'steward')!;
    expect(steward).toMatchObject({
      supervisorId: wk.agentId,
      taskId,
      caps: DEFAULT_CAPS,
      meta: { permissionPolicy: strict, workspace: dir },
    });
    expect(steward.meta?.['cwd']).toMatch(/\.galactic|worktrees/);
    expect(fetched).toMatchObject({ status: 'denied' });
    const prompt = steward.meta?.['prompt'] as string;
    expect(prompt.startsWith('scenario:write-notes')).toBe(true);
    expect(prompt).toContain(`Your task (${taskId}): write the notes`);
    expect(prompt).toContain(
      `Project: "Notes app" (${project.id}). You report to your project's Waykeeper.`,
    );
    expect(prompt).toMatch(/You are on branch galactic\//);
    expect(prompt).toContain('AskUserQuestion');
    expect(prompt).toContain('Never ask for permission in prose');
    expect(prompt).toContain('"Done:"');
    // The report is the turn's last text, from the Steward to its Waykeeper, and woke it once.
    const reports = reportsTo(wk.agentId).filter(
      (e) => e.sender.type === 'agent' && e.sender.id === steward.id,
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain('Its report: Done: added notes.md with a heading');
    expect(reports[0]!.text).not.toContain('Committed notes.md');
    // Merged into the base branch; the closed task's idle Steward was stopped.
    expect(existsSync(join(dir, 'notes.md'))).toBe(true);
    expect(git(dir, 'log', '--oneline')).toMatch(/add notes/);
    expect(h.statuses.get(steward.id)?.state).toBe('stopped');
    expect(task(taskId).meta?.['merge']).toBeDefined();
  });

  describe('an asteroid task with the Harmonizer', () => {
    function setup(script: (s: BrainScript) => void) {
      const root = join(tmp, 'projects');
      const definition = harmonizerBrain({ projectsRoot: root });
      return {
        root,
        start: async () => {
          const { value: card } = await h.commands.createProposal({
            requestText: 'rename the logs',
            kind: 'asteroid',
            proposedBody: { kind: 'asteroid', name: 'Rename logs' },
            workspace: join(root, 'scratch', 'rename-logs'),
            rationale: 'small',
            meta: {
              request: {
                type: 'standalone_task',
                name: 'Rename logs',
                description: 'rename the logs',
              },
            },
          });
          await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);
          const hq = await h.startHarmonizer({ definition, script });
          hq.tell(`go ${card.id}`);
          return hq;
        },
      };
    }
    const goRule = (instructions: string) => async (t: TurnContext) => {
      const proposalId = /go (pr-[0-9a-f-]+)/.exec(t.prompt)![1]!;
      const created = await t.call<{ taskId: Id }>('create_task', { proposalId });
      await t.call('spawn_steward', { taskId: created.taskId, instructions });
    };
    const theTask = () => h.log.tables.tasks.all()[0]!;

    it('reports done by ending its turn; the Harmonizer closes it', async () => {
      scenario('rename', [
        { kind: 'output', text: 'Renaming app.log.1 … app.log.3.' },
        { kind: 'output', text: 'Done: renamed three log files to the dated scheme.' },
      ]);
      const { root, start } = setup((s) =>
        s.once('go', goRule('scenario:rename')).once(/Its report: Done:/, async (t) => {
          await t.call('close_task', { taskId: theTask().id });
        }),
      );
      const hq = await start();
      await h.until(() => h.log.tables.tasks.all()[0]?.state === 'completed', {
        what: 'the asteroid task closed',
      });
      await h.done();

      hq.assertCalls(['create_task', 'spawn_steward', 'close_task']);
      const steward = h.log.tables.agents.all().find((a) => a.role === 'steward')!;
      expect(steward).toMatchObject({
        supervisorId: hq.agentId,
        meta: { cwd: join(root, 'scratch', 'rename-logs') },
      });
      const prompt = steward.meta?.['prompt'] as string;
      expect(prompt.startsWith('scenario:rename')).toBe(true);
      expect(prompt).toContain(
        'A standalone task, not part of a project. You report to the Harmonizer.',
      );
      expect(prompt).toContain('do not commit, push or switch branches');
      expect(reportsTo(hq.agentId)).toHaveLength(1);
      expect(h.statuses.get(steward.id)?.state).toBe('stopped');
    });

    it('a report that is not done: the Harmonizer tells the Steward, which reports again', async () => {
      scenario(
        'unsure',
        [{ kind: 'output', text: 'Not done: should the old names stay as symlinks?' }],
        (message) => [{ kind: 'output', text: `Done: renamed; ${message}` }],
      );
      const { start } = setup((s) =>
        s
          .once('go', goRule('scenario:unsure'))
          .once(/Its report: Not done:/, async (t) => {
            const steward = h.log.tables.agents.all().find((a) => a.role === 'steward')!;
            const told = await t.call<{ messageId: Id }>('tell_steward', {
              agentId: steward.id,
              text: 'keep symlinks',
            });
            expect(told.messageId).toBeDefined();
            // Only its own, running Stewards: never itself, never an unknown agent.
            expect(
              await t.try('tell_steward', {
                agentId: h.log.tables.agents.all().find((a) => a.role === 'harmonizer')!.id,
                text: 'x',
              }),
            ).toMatchObject({
              ok: false,
              error: 'invalid',
            });
          })
          .once(/Its report: Done: renamed; keep symlinks/, async (t) => {
            await t.call('close_task', { taskId: theTask().id });
          }),
      );
      const hq = await start();
      await h.until(() => h.log.tables.tasks.all()[0]?.state === 'completed', {
        what: 'the asteroid task closed',
      });
      await h.done();
      hq.assertCalls([
        'create_task',
        'spawn_steward',
        'tell_steward',
        'tell_steward',
        'close_task',
      ]);
      expect(reportsTo(hq.agentId)).toHaveLength(2);
    });

    it('a Steward that finishes without a result: its last words are the report', async () => {
      scenario('quiet', [{ kind: 'output', text: 'All three files renamed.' }, { kind: 'finish' }]);
      const { start } = setup((s) =>
        s
          .once('go', goRule('scenario:quiet'))
          .once(/finished: "All three files renamed\."/, async (t) => {
            await t.call('close_task', { taskId: theTask().id });
          }),
      );
      const hq = await start();
      await h.until(() => h.log.tables.tasks.all()[0]?.state === 'completed', {
        what: 'the asteroid task closed',
      });
      await h.done();
      hq.assertCalls(['create_task', 'spawn_steward', 'close_task']);
      const finished = events().find((e) => e.type === 'agent.finished');
      expect(finished).toMatchObject({ result: 'All three files renamed.' });
      // Finishing is its own report: no turn-end message on top.
      expect(reportsTo(hq.agentId)).toHaveLength(0);
    });
  });
});
