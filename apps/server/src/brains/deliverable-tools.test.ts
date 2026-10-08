import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentAdapter,
  DeclarationLimits,
  Id,
  Project,
  SpawnOptions,
  Task,
} from '@galactic/protocol';
import { DEFAULT_DECLARATION_LIMITS } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { SCENARIOS, type FakeScenario, type FakeToolResult } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime } from '../runtime/compose.js';
import { gitRunner } from '../workspace/git.js';
import { HARMONIZER_SYSTEM_PROMPT, harmonizerBrain } from './harmonizer/index.js';
import { stewardPrompt } from './steward-prompt.js';
import { brainHarness, type BrainHarness } from './testing/index.js';
import { WAYKEEPER_SYSTEM_PROMPT, waykeeperDefinition } from './waykeeper/index.js';

/**
 * P9-04 acceptance with the scripted fake LLM: a Steward on the fake runtime (which serves the
 * server's tools like `claude-sdk`) declares a file in its worktree and an image through
 * `declare_deliverable`, is refused a secret and a path outside the project, and its Bash call
 * still reaches the permission gate; its Waykeeper — a scripted model following the prompt —
 * lists the task's deliverables, removes the Steward's scratch log with a reason, declares a
 * project command and is refused another project's task and the user's row. An ACP Steward is
 * spawned without the tools and is asked for a "Deliverables:" list instead.
 */

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const LONG = { timeoutMs: 20_000 };
const POSIX = process.platform !== 'win32';

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
let limits: DeclarationLimits;
let spawns: SpawnOptions[];

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-declare-tools-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  scenarios = { ...SCENARIOS };
  limits = { ...DEFAULT_DECLARATION_LIMITS };
  h = brainHarness({
    adapter: { scenarios },
    compose: {
      workspaces: {
        projectsRoot: join(tmp, 'projects'),
        dataDir: join(tmp, 'data'),
        home: join(tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
      deliverables: { limits: () => limits, tmpDirs: [join(tmp, 'no-strays')] },
    },
  });
  spawns = [];
  const spawn = h.adapter.spawn.bind(h.adapter);
  h.adapter.spawn = (opts) => {
    spawns.push(opts);
    return spawn(opts);
  };
});

afterEach(async () => {
  await h.dispose().catch(() => {});
  rmSync(tmp, { recursive: true, force: true });
});

async function gitProject(name: string): Promise<Project> {
  const dir = join(tmp, 'home', name);
  const created = (await h.commands.createProject({ name, workspace: dir })).value;
  await h.composed.workspaces!.prepareProject(created.id);
  writeFileSync(join(dir, 'README.md'), `${name}\n`);
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'base');
  return h.log.tables.projects.get(created.id)!;
}

const output = <T>(r: FakeToolResult | undefined): T => {
  expect(r?.status).toBe('ran');
  return (r as { output: T }).output;
};

describe.skipIf(!POSIX)('agents declare deliverables (P9-04)', () => {
  it('the prompts and the tool lists', () => {
    expect(waykeeperDefinition().tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['declare_deliverable', 'remove_deliverable', 'list_deliverables']),
    );
    expect(harmonizerBrain({ projectsRoot: '/p' }).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['declare_deliverable', 'remove_deliverable', 'list_deliverables']),
    );
    expect(WAYKEEPER_SYSTEM_PROMPT).toMatch(/Deliverables\. .*declare_deliverable/);
    expect(WAYKEEPER_SYSTEM_PROMPT).toMatch(/remove_deliverable and a reason/);
    expect(WAYKEEPER_SYSTEM_PROMPT).toMatch(
      /dev command as a deliverable to leaving a dev server running/,
    );
    expect(HARMONIZER_SYSTEM_PROMPT).toMatch(/Deliverables of standalone tasks/);
    const brief = {
      task: { id: 't-1', description: 'build' },
      supervisor: 'waykeeper' as const,
      cwd: '/w',
    };
    expect(stewardPrompt(brief)).toMatch(/with declare_deliverable/);
    const listed = stewardPrompt({ ...brief, declares: false });
    expect(listed).not.toMatch(/with declare_deliverable/);
    expect(listed).toMatch(
      /under a line "Deliverables:".*"- <kind> \| <path, command or address> \| <title>"/,
    );
  });

  it('a Steward declares in its worktree; its Waykeeper reviews, removes scratch and declares a command', async () => {
    const project = await gitProject('Site');
    const other = await gitProject('Other');
    const otherTask = (await h.commands.createTask({ projectId: other.id, description: 'x' }))
      .value;
    let taskId: Id = '';
    const seen: Record<string, FakeToolResult> = {};
    scenarios['deliver'] = {
      steps: [
        {
          kind: 'script',
          run: async (io) => {
            const task: Task = h.log.tables.tasks.get(taskId)!;
            const wt = task.worktreePath!;
            writeFileSync(join(wt, 'report.md'), '# Report\n');
            writeFileSync(join(wt, 'home.png'), 'png');
            writeFileSync(join(wt, 'debug.log'), 'scratch\n');
            writeFileSync(join(wt, '.env'), 'TOKEN=1\n');
            const declare = (input: Record<string, unknown>) =>
              io.toolCall('declare_deliverable', input);
            seen['report'] = await declare({ kind: 'file', title: 'Report', path: 'report.md' });
            seen['image'] = await declare({ kind: 'image', title: 'Home page', path: 'home.png' });
            seen['log'] = await declare({ kind: 'file', title: 'Debug log', path: 'debug.log' });
            seen['secret'] = await declare({ kind: 'file', title: 'Env', path: '.env' });
            seen['outside'] = await declare({ kind: 'file', title: 'Hosts', path: '/etc/hosts' });
            seen['list'] = await io.toolCall('list_deliverables', {});
            // Its other tools still go through the gate: a push asks the user.
            seen['push'] = await io.toolCall('Bash', { command: 'git push origin main' });
          },
        },
        { kind: 'output', text: 'Done: the report and the screenshot are declared.' },
        { kind: 'idle' },
      ],
    };
    const hq = await h.startHarmonizer();
    let review: { deliverables: { deliverableId: Id; title: string }[] } | undefined;
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('plan', async (t) => {
              const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
                summary: 'A site',
                tasks: [{ description: 'build the site' }],
              });
              taskId = out.tasks[0]!.taskId;
            })
            .once(/was approved/, async (t) => {
              await t.call('spawn_steward', { taskId, instructions: 'scenario:deliver' });
            })
            .once(/reported/, async (t) => {
              review = await t.call('list_deliverables', { taskId });
              const log = review!.deliverables.find((d) => d.title === 'Debug log')!;
              await t.call('remove_deliverable', {
                deliverableId: log.deliverableId,
                reason: 'a scratch log',
              });
              await t.call('declare_deliverable', {
                kind: 'command',
                title: 'Dev server',
                command: 'pnpm dev',
              });
              await t.try('declare_deliverable', {
                taskId: otherTask.id,
                kind: 'url',
                title: 'Not mine',
                url: 'https://x.dev',
              });
              const user = h.log.tables.deliverables
                .of({ taskId })
                .find((d) => d.source === 'user')!;
              await t.try('remove_deliverable', { deliverableId: user.id, reason: 'no' });
              await t.call('report_status', { text: 'Reviewed the deliverables.' });
            }),
      },
    );
    wk.tell('plan');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await h.commands.decideProposal(
      h.log.tables.proposals.all()[0]!.id,
      { decision: 'approve' },
      { type: 'user' },
    );
    // The push reached the permission gate: a question for the user.
    await h.until(
      () =>
        h.log.tables.questions.all().some((q) => q.kind === 'permission' && q.status === 'open'),
      { ...LONG, what: 'the push asks' },
    );
    const push = h.log.tables.questions.all().find((q) => q.kind === 'permission')!;
    expect(push.context.toolCall).toMatchObject({ toolName: 'Bash' });
    // The user adds a row of their own before the review (decision 120: no agent may remove it).
    await h.commands.addDeliverable(
      { taskId, kind: 'url', title: 'My notes', source: 'user', url: 'https://notes.dev' },
      { type: 'user' },
      { origin: 'local' },
    );
    await h.commands.answerQuestion({ questionId: push.id, answer: 'no', by: { type: 'user' } });
    await h.until(() => wk.calls('report_status').length > 0, LONG);
    await h.done(LONG);

    // The Steward's spawn carried the two server tools; nothing else changed for its other tools.
    const stewardSpawn = spawns.find((o) => o.role === 'steward')!;
    expect(stewardSpawn.tools?.map((t) => t.name)).toEqual([
      'declare_deliverable',
      'list_deliverables',
    ]);
    expect(seen['push']).toMatchObject({ status: 'denied' });

    const task = h.log.tables.tasks.get(taskId)!;
    const wt = task.worktreePath!;
    expect(output(seen['report'])).toMatchObject({
      kind: 'file',
      title: 'Report',
      path: join(wt, 'report.md'),
      storage: 'worktree',
      source: 'agent',
    });
    expect(output(seen['image'])).toMatchObject({ kind: 'image', path: join(wt, 'home.png') });
    expect(output(seen['secret'])).toMatchObject({
      error: 'invalid',
      message: expect.stringMatching(/\(secret\)/),
    });
    expect(output(seen['outside'])).toMatchObject({
      error: 'invalid',
      message: expect.stringMatching(/outside/),
    });
    expect(output<{ deliverables: unknown[] }>(seen['list']).deliverables).toHaveLength(3);

    // The project's detected rows (P9-05: its folder) are not the agents' business here.
    const rows = h.log.tables.deliverables
      .of({ projectId: project.id })
      .filter((d) => d.source !== 'detected');
    expect(rows.map((d) => [d.title, d.source, d.removedReason ?? null])).toEqual([
      ['Report', 'agent', null],
      ['Home page', 'agent', null],
      ['Debug log', 'agent', 'a scratch log'],
      ['My notes', 'user', null],
      ['Dev server', 'agent', null],
    ]);
    const dev = rows.find((d) => d.title === 'Dev server')!;
    expect(dev).toMatchObject({ command: { line: 'pnpm dev', cwd: project.workspace } });
    expect(dev.taskId).toBeUndefined();
    expect(
      h.log.tables.deliverables.of({ projectId: other.id }).filter((d) => d.source !== 'detected'),
    ).toEqual([]);
    const [notMine, userRow] = wk.calls().filter((c) => !c.ok);
    expect(notMine).toMatchObject({
      tool: 'declare_deliverable',
      message: expect.stringMatching(/not a task of your project/),
    });
    expect(userRow).toMatchObject({
      tool: 'remove_deliverable',
      message: expect.stringMatching(/added by the user/),
    });
  });
});

describe('Stewards on runtimes without server tools (P9-04)', () => {
  it('an ACP Steward is spawned without the tools; a fake one with them', async () => {
    const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-acp-tools-')));
    const fake = new FakeAdapter({ speed: 0 });
    const acpLike = new FakeAdapter({ speed: 0 });
    Object.defineProperty(acpLike, 'runtime', { value: 'acp' });
    const seen: SpawnOptions[] = [];
    for (const a of [fake, acpLike] as AgentAdapter[]) {
      const spawn = a.spawn.bind(a);
      a.spawn = (opts) => {
        seen.push(opts);
        return spawn(opts);
      };
    }
    const composed = composeRuntime(openDatabase(':memory:'), {
      adapters: [fake, acpLike],
      deliverables: { dataDir: join(tmpRoot, 'data') },
    });
    try {
      const ws = join(tmpRoot, 'app');
      mkdirSync(ws);
      const project = (await composed.commands.createProject({ name: 'App', workspace: ws })).value;
      const task = (await composed.commands.createTask({ projectId: project.id, description: 'x' }))
        .value;
      for (const runtime of ['acp', 'fake'] as const) {
        const result = await composed.runtime.spawn({
          role: 'steward',
          runtime,
          prompt: 'scenario:echo',
          cwd: ws,
          taskId: task.id,
          projectId: project.id,
        });
        expect(result.ok).toBe(true);
        if (result.ok) await composed.runtime.stop(result.agent.id, { type: 'user' });
      }
      expect(seen.map((o) => [o.role, o.tools?.map((t) => t.name) ?? null])).toEqual([
        ['steward', null],
        ['steward', ['declare_deliverable', 'list_deliverables']],
      ]);
    } finally {
      await composed.dispose();
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
