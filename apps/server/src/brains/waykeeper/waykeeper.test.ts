import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { proposalPlan, type Id, type Project, type Task } from '@galactic/protocol';
import { SCENARIOS, type FakeScenario } from '../../adapters/fake/scenario.js';
import { gitRunner } from '../../workspace/git.js';
import {
  brainHarness,
  type BrainHarness,
  type BrainScript,
  type HarnessBrain,
  type TurnContext,
} from '../testing/index.js';
import { waykeeperDefinition } from './index.js';

/**
 * P2-10 acceptance with the P2-07 harness: a real Waykeeper definition (its prompt and tools)
 * driven by a scripted model, real `DomainCommands`, a real workspace service on temp git
 * repositories, and fake Stewards whose scenarios commit in their worktrees.
 */

// Git sees no global or system config; every commit names its identity.
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const LONG = { timeoutMs: 20_000 };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=user@test', ...args], {
    cwd,
    env: { ...process.env, ...GIT_ENV },
    encoding: 'utf8',
  }).trim();
}
function commitFile(cwd: string, file: string, text: string, message: string): void {
  writeFileSync(join(cwd, file), text);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
}

let tmp: string;
let h: BrainHarness;
let scenarios: Record<string, FakeScenario>;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-wk-')));
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

/** A git workspace with a base commit holding `shared.txt`. */
async function gitProject(name = 'CSV tool'): Promise<{ project: Project; dir: string }> {
  const dir = join(tmp, 'home', name);
  const created = (await h.commands.createProject({ name, workspace: dir })).value;
  await h.composed.workspaces!.prepareProject(created.id);
  commitFile(dir, 'shared.txt', 'base\n', 'base content');
  return { project: h.log.tables.projects.get(created.id)!, dir };
}

const task = (id: Id): Task => h.log.tables.tasks.get(id)!;
const base = (dir: string) => git(dir, 'symbolic-ref', '--short', 'HEAD');

/**
 * A Steward scenario: after a beat (a model takes longer than its spawn), `work(task)` runs in the
 * Steward's task, then the Steward finishes. Registered under `name`; a Steward picks it with a
 * prompt that starts `scenario:<name>`.
 */
function steward(name: string, work: (task: Task) => void, pick: () => Task): void {
  scenarios[name] = {
    steps: [
      {
        kind: 'script',
        run: async () => {
          await sleep(15);
          work(pick());
        },
      },
      { kind: 'finish', result: 'done' },
    ],
  };
}

/** The agents named "agent … finished" in a turn prompt, with their tasks. */
function finishedTasks(prompt: string): Id[] {
  return [...prompt.matchAll(/agent (\S+) finished/g)]
    .map((m) => h.log.tables.agents.get(m[1]!)?.taskId)
    .filter((t): t is Id => t !== undefined);
}

async function startWaykeeper(
  project: Project,
  script: (s: BrainScript) => void,
): Promise<{ hq: HarnessBrain; wk: HarnessBrain }> {
  const hq = await h.startHarmonizer();
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    { script },
  );
  return { hq, wk };
}

/** The usual reaction to a finished Steward: merge, then close when the merge went in. */
async function mergeAndClose(t: TurnContext): Promise<void> {
  for (const taskId of finishedTasks(t.prompt)) {
    const merged = await t.call<{ merged: boolean; action?: string }>('merge_task', {
      taskId,
      note: 'scenario:resolve',
    });
    if (!merged.merged) continue;
    const closed = await t.call<{ allTasksClosed?: boolean }>('close_task', { taskId });
    if (closed.allTasksClosed) {
      await t.call('request_project_closure', { summary: 'The CSV tool is built.' });
      return;
    }
  }
}

const approve = (proposalId: Id) =>
  h.commands.decideProposal(proposalId, { decision: 'approve' }, { type: 'user' });

describe('Waykeeper brain (P2-10)', () => {
  it('presents the plan once, as a single card; approval approves its tasks and wakes it', async () => {
    const { project } = await gitProject();
    const { hq, wk } = await startWaykeeper(project, (s) =>
      s
        .once('plan the CSV tool', async (t) => {
          await t.call('plan_tasks', {
            summary: 'Reader, writer, CLI',
            rationale: 'Three separable pieces',
            tasks: [
              { description: 'read CSV' },
              { description: 'write Parquet' },
              { description: 'CLI entry point', blockedBy: [0, 1] },
            ],
          });
        })
        .once(/proposal \S+ was approved/, async (t) => {
          // Plan once: a second plan is refused; later work goes through create_task.
          const again = await t.try('plan_tasks', {
            summary: 'again',
            tasks: [{ description: 'x' }],
          });
          expect(again).toMatchObject({ ok: false, error: 'invalid_transition' });
          await t.call('create_task', { description: 'README' });
        }),
    );
    wk.tell('plan the CSV tool');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await h.settle();

    const cards = h.log.tables.proposals.all();
    expect(cards).toHaveLength(1);
    const plan = proposalPlan(cards[0])!;
    expect(plan).toMatchObject({ projectId: project.id, waykeeperId: wk.agentId });
    expect(plan.taskIds.map((id) => task(id).state)).toEqual(['proposed', 'proposed', 'proposed']);
    expect(task(plan.taskIds[2]!).blockedBy).toEqual(plan.taskIds.slice(0, 2));
    expect(wk.calls('plan_tasks')[0]).toMatchObject({ ok: true, turnEnded: true });
    // A Steward cannot start on a proposed task, and nothing is added while the card waits.
    expect(h.queries.supervisedAgents(wk.agentId)).toEqual([]);

    await approve(cards[0]!.id);
    await h.done();
    expect(plan.taskIds.map((id) => task(id).state)).toEqual(['approved', 'approved', 'approved']);
    expect(h.queries.projectTasks(project.id).map((t) => t.description)).toContain('README');
    wk.assertCalls(['plan_tasks', 'plan_tasks', 'create_task']);
    // The card is the Waykeeper's: its decision never reaches the Harmonizer's mailbox.
    expect(hq.prompts().join('\n')).not.toMatch(/was approved/);
  });

  it('merges and closes a finished Steward’s task, and asks for closure when all are closed', async () => {
    const { project, dir } = await gitProject();
    let plan: Id[] = [];
    steward(
      'write-a',
      (t) => commitFile(t.worktreePath!, 'a.txt', 'a\n', 'task A'),
      () => task(plan[0]!),
    );
    steward(
      'write-b',
      (t) => commitFile(t.worktreePath!, 'b.txt', 'b\n', 'task B'),
      () => task(plan[1]!),
    );
    const { hq, wk } = await startWaykeeper(project, (s) =>
      s
        .once('plan', async (t) => {
          const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
            summary: 'Two files',
            tasks: [{ description: 'write a' }, { description: 'write b' }],
          });
          plan = out.tasks.map((x) => x.taskId);
        })
        .once(/was approved/, async (t) => {
          const a = await t.call<{ cwd: string; branch: string }>('spawn_steward', {
            taskId: plan[0],
            instructions: 'scenario:write-a\nWrite a.txt.',
          });
          expect(a.cwd).toBe(join(dir, '.galactic', 'worktrees', plan[0]!));
          expect(a.branch).toMatch(/^galactic\//);
          await t.call('spawn_steward', { taskId: plan[1], instructions: 'scenario:write-b' });
          // One Steward per task.
          expect(
            await t.try('spawn_steward', { taskId: plan[1], instructions: 'again' }),
          ).toMatchObject({ ok: false, error: 'conflict' });
        })
        .on(/finished/, mergeAndClose),
    );
    wk.tell('plan');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await approve(h.log.tables.proposals.all()[0]!.id);
    await h.until(() => wk.calls('request_project_closure').length > 0, LONG);
    await h.done(LONG);

    expect(plan.map((id) => task(id).state)).toEqual(['completed', 'completed']);
    expect(git(dir, 'ls-tree', '--name-only', 'HEAD').split('\n').sort()).toEqual([
      'a.txt',
      'b.txt',
      'shared.txt',
    ]);
    expect(plan.map((id) => task(id).meta?.['merge'])).toEqual([
      expect.objectContaining({ branchDeleted: true }),
      expect.objectContaining({ branchDeleted: true }),
    ]);
    // Closing the task stopped nothing still needed; the Stewards had finished.
    expect(wk.calls('close_task').map((c) => c.ok)).toEqual([true, true]);
    // The closure request reached the Harmonizer as a report and is recorded on the project.
    const reports = h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter(
        (e) => e.type === 'message.sent' && e.agentId === hq.agentId && e.sender.type === 'agent',
      );
    expect(reports).toEqual([
      expect.objectContaining({
        sender: { type: 'agent', id: wk.agentId },
        text: expect.stringContaining('every task is closed'),
      }),
    ]);
    expect(h.log.tables.projects.get(project.id)!.meta).toMatchObject({
      closureRequest: { by: wk.agentId, summary: 'The CSV tool is built.' },
    });
    expect(wk.calls('request_project_closure')[0]).toMatchObject({ ok: true, turnEnded: true });
  });

  it('sends the Steward back to resolve a conflict with the project’s own merged work', async () => {
    const { project, dir } = await gitProject();
    let plan: Id[] = [];
    steward(
      'edit-a',
      (t) => commitFile(t.worktreePath!, 'shared.txt', 'from A\n', 'task A'),
      () => task(plan[0]!),
    );
    // B waits for A's merge before it finishes, so the order is fixed: A merges, B conflicts.
    scenarios['edit-b'] = {
      steps: [
        {
          kind: 'script',
          run: async () => {
            commitFile(task(plan[1]!).worktreePath!, 'shared.txt', 'from B\n', 'task B');
            while (task(plan[0]!).state !== 'completed') await sleep(5);
          },
        },
        { kind: 'finish', result: 'done' },
      ],
    };
    // The send-back: merge the base branch in the kept worktree, resolve, commit.
    steward(
      'resolve',
      (t) => {
        const wt = t.worktreePath!;
        try {
          git(wt, 'merge', '-q', base(dir));
        } catch {
          // the expected conflict
        }
        writeFileSync(join(wt, 'shared.txt'), 'from A\nfrom B\n');
        git(wt, 'add', 'shared.txt');
        git(wt, 'commit', '-q', '--no-edit');
      },
      () => task(plan[1]!),
    );
    const { wk } = await startWaykeeper(project, (s) =>
      s
        .once('plan', async (t) => {
          const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
            summary: 'Both edit the shared file',
            tasks: [{ description: 'edit a' }, { description: 'edit b' }],
          });
          plan = out.tasks.map((x) => x.taskId);
        })
        .once(/was approved/, async (t) => {
          await t.call('spawn_steward', { taskId: plan[0], instructions: 'scenario:edit-a' });
          await t.call('spawn_steward', { taskId: plan[1], instructions: 'scenario:edit-b' });
        })
        .on(/finished/, mergeAndClose),
    );
    wk.tell('plan');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await approve(h.log.tables.proposals.all()[0]!.id);
    await h.until(() => wk.calls('request_project_closure').length > 0, LONG);
    await h.done(LONG);

    const merges = wk.calls('merge_task').map((c) => c.value as Record<string, unknown>);
    const sentBack = merges.find((m) => m['action'] === 'steward_sent_back');
    expect(sentBack).toMatchObject({
      merged: false,
      reason: 'conflict',
      external: false,
      files: ['shared.txt'],
      how: 'respawned',
    });
    // The same task got a second Steward, in the same worktree, under the same Waykeeper.
    const stewardsOfB = h.log.tables.agents.all().filter((a) => a.taskId === plan[1]);
    expect(stewardsOfB).toHaveLength(2);
    expect(stewardsOfB.every((a) => a.supervisorId === wk.agentId)).toBe(true);
    expect(stewardsOfB.map((a) => a.id)).toContain(sentBack!['stewardId']);
    // No question reached the user; the merge went in after the resolution.
    expect(h.log.tables.questions.all()).toEqual([]);
    expect(plan.map((id) => task(id).state)).toEqual(['completed', 'completed']);
    expect(readFileSync(join(dir, 'shared.txt'), 'utf8')).toBe('from A\nfrom B\n');
  });

  it('asks the user when the base branch holds commits from outside the project', async () => {
    const { project, dir } = await gitProject();
    let plan: Id[] = [];
    steward(
      'edit-c',
      (t) => {
        commitFile(t.worktreePath!, 'shared.txt', 'from C\n', 'task C');
        // Meanwhile the user edits the same file on the base branch by hand.
        commitFile(dir, 'shared.txt', 'from the user\n', 'user: hotfix the shared file');
      },
      () => task(plan[0]!),
    );
    const { wk } = await startWaykeeper(project, (s) =>
      s
        .once('plan', async (t) => {
          const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
            summary: 'One task',
            tasks: [{ description: 'edit c' }],
          });
          plan = out.tasks.map((x) => x.taskId);
        })
        .once(/was approved/, (t) =>
          t.call('spawn_steward', { taskId: plan[0], instructions: 'scenario:edit-c' }),
        )
        .once(/finished/, async (t) => {
          const out = await t.call<Record<string, unknown>>('merge_task', { taskId: plan[0] });
          expect(out).toMatchObject({
            merged: false,
            external: true,
            action: 'asked_user',
            externalCount: 1,
            externalCommits: [expect.objectContaining({ subject: 'user: hotfix the shared file' })],
          });
          // Asking again does not open a second question.
          const again = await t.call<Record<string, unknown>>('merge_task', { taskId: plan[0] });
          expect(again).toMatchObject({ action: 'asked_user', questionId: out['questionId'] });
          // Not closed while unmerged.
          expect(await t.try('close_task', { taskId: plan[0] })).toMatchObject({
            ok: false,
            error: 'invalid',
          });
        })
        .once(/user answered/, (t) => t.say('I will merge again when you say so.')),
    );
    wk.tell('plan');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await approve(h.log.tables.proposals.all()[0]!.id);
    await h.until(() => h.log.tables.questions.all().length > 0, LONG);
    await h.settle(LONG);

    const [question] = h.log.tables.questions.all();
    expect(question).toMatchObject({
      kind: 'clarification',
      originAgentId: wk.agentId,
      holder: { type: 'user' },
      status: 'open',
    });
    const text = question!.context.text;
    for (const part of [
      'shared.txt',
      task(plan[0]!).branch!,
      base(dir),
      'user: hotfix the shared file',
    ]) {
      expect(text).toContain(part);
    }
    // The Steward was not sent back; its work is kept.
    expect(h.log.tables.agents.all().filter((a) => a.taskId === plan[0])).toHaveLength(1);
    expect(task(plan[0]!).worktreePath).toBeDefined();

    await h.commands.answerQuestion({
      questionId: question!.id,
      answer: 'I will resolve it myself',
      by: { type: 'user' },
    });
    await h.done(LONG);
  });

  it('runs one Steward at a time in a workspace that is not a git repository', async () => {
    const dir = join(tmp, 'home', 'plain folder');
    mkdirSync(dir);
    writeFileSync(join(dir, 'notes.txt'), 'mine\n');
    const project = (await h.commands.createProject({ name: 'Plain', workspace: dir })).value;
    scenarios['hold'] = { steps: [{ kind: 'silence', ms: 10_000 }] };
    let plan: Id[] = [];
    const { wk } = await startWaykeeper(project, (s) =>
      s
        .once('plan', async (t) => {
          const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
            summary: 'Two notes',
            tasks: [{ description: 'one' }, { description: 'two' }],
          });
          plan = out.tasks.map((x) => x.taskId);
        })
        .once(/was approved/, async (t) => {
          const first = await t.call<Record<string, unknown>>('spawn_steward', {
            taskId: plan[0],
            instructions: 'scenario:hold',
          });
          expect(first).toMatchObject({ cwd: dir, serialised: true });
          const second = await t.try('spawn_steward', { taskId: plan[1], instructions: 'x' });
          expect(second).toMatchObject({ ok: false, error: 'conflict' });
          expect(second.message).toMatch(/one at a time/);
          // Nothing to merge: the Steward works in the workspace itself.
          expect(await t.call('merge_task', { taskId: plan[0] })).toMatchObject({
            merged: true,
            serialised: true,
          });
        }),
    );
    wk.tell('plan');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await approve(h.log.tables.proposals.all()[0]!.id);
    await h.done(LONG);
    // The folder was left as it is: no repository was made without the user's consent.
    expect(h.log.tables.projects.get(project.id)!.meta).toMatchObject({
      workspace: { git: false, serialStewards: true },
    });
    expect(existsSync(join(dir, '.git'))).toBe(false);
  });
});
