import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Event, Id, Project, Task } from '@galactic/protocol';
import { SCENARIOS, type FakeScenario } from '../../adapters/fake/scenario.js';
import { AGENT_ID_ENV } from '../../runtime/process-attribution.js';
import { gitRunner } from '../../workspace/git.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { waykeeperDefinition } from './index.js';
import { WAYKEEPER_SYSTEM_PROMPT } from './prompt.js';
import { HARMONIZER_SYSTEM_PROMPT } from '../harmonizer/prompt.js';

/**
 * P4-14 acceptance with the brain harness: a Steward starts a background server in its worktree
 * that outlives its shell (an orphan) and reports; its Waykeeper — a scripted model following the
 * prompt's rule — lists the Steward's processes, stops the leftover, merges and closes the task.
 * Nothing is left running, and the server's sweep at the Steward's end finds nothing more to do.
 * Real git worktrees, a real process, the real process table.
 */

const POSIX = process.platform !== 'win32';
const NODE = process.execPath;
const MARK = `p414wk-${process.pid}`;
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
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
const pids = new Set<number>();
const shells: ChildProcess[] = [];

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return !stat.trim().startsWith('Z');
  } catch {
    return false;
  }
}

/**
 * `nohup node server &` from a shell that exits: an orphan in `cwd`, as a Steward would leave —
 * carrying its agent marker, as everything the supervisor starts for an agent does.
 */
function startOrphanServer(cwd: string, agentId: Id): Promise<number> {
  const script = `require('http').createServer(() => {}).listen(0, '127.0.0.1'); setInterval(() => {}, 1e6)`;
  const sh = spawn(
    '/bin/sh',
    ['-c', `"${NODE}" -e "${script}" ${MARK}-dev >/dev/null 2>&1 & echo $!`],
    {
      cwd,
      env: { ...process.env, [AGENT_ID_ENV]: agentId },
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  );
  shells.push(sh);
  let out = '';
  sh.stdout.on('data', (d: Buffer) => (out += d.toString()));
  return new Promise((resolve) =>
    sh.once('close', () => {
      const pid = Number(out.trim());
      pids.add(pid);
      resolve(pid);
    }),
  );
}

let sessionStart = 0;

/** The Steward of `taskId` (the fake runtime's "CLI"). */
const stewardOf = (taskId: Id): Id =>
  h.log.tables.agents.all().find((a) => a.role === 'steward' && a.taskId === taskId)!.id;

beforeEach(() => {
  sessionStart = Date.now() - 1_000;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-wk-procs-')));
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
      // The fake runtime runs no CLI: the sessions a supervisor would record are this test's.
      processes: {
        termMs: 1_000,
        settleMs: 1_000,
        groups: {
          agentGroups: () => [],
          agentSessions: () => [{ start: sessionStart, end: Date.now() }],
        },
      },
    },
  });
});

afterEach(async () => {
  try {
    await h.dispose().catch(() => {});
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
    pids.clear();
    for (const sh of shells.splice(0)) sh.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (!POSIX) return;
  try {
    execFileSync('pkill', ['-9', '-f', MARK]);
  } catch {
    // nothing left
  }
});

async function gitProject(): Promise<Project> {
  const dir = join(tmp, 'home', 'Site');
  const created = (await h.commands.createProject({ name: 'Site', workspace: dir })).value;
  await h.composed.workspaces!.prepareProject(created.id);
  writeFileSync(join(dir, 'README.md'), 'site\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'base');
  return h.log.tables.projects.get(created.id)!;
}

const events = (): Event[] => h.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);

describe.skipIf(!POSIX)('Waykeepers clean up their Stewards’ processes (P4-14)', () => {
  it('the prompts make the check part of finishing a task', () => {
    for (const prompt of [WAYKEEPER_SYSTEM_PROMPT, HARMONIZER_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/list_steward_processes/);
      expect(prompt).toMatch(/stop_steward_processes/);
      expect(prompt).toMatch(/keep running/);
    }
    expect(WAYKEEPER_SYSTEM_PROMPT).toMatch(/Before merge_task and close_task/);
    expect(waykeeperDefinition().tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['list_steward_processes', 'stop_steward_processes']),
    );
  });

  it('lists the leftover dev server, stops it, merges and closes: nothing is left running', async () => {
    const project = await gitProject();
    let taskId: Id = '';
    let server = 0;
    // The Steward commits its work, starts a dev server that outlives its shell, and reports.
    scenarios['serve'] = {
      steps: [
        {
          kind: 'script',
          run: async () => {
            const task: Task = h.log.tables.tasks.get(taskId)!;
            writeFileSync(join(task.worktreePath!, 'index.html'), '<h1>site</h1>\n');
            git(task.worktreePath!, 'add', 'index.html');
            git(task.worktreePath!, 'commit', '-q', '-m', 'page');
            server = await startOrphanServer(task.worktreePath!, stewardOf(taskId));
          },
        },
        { kind: 'output', text: 'Done: the page is there; I left the dev server running.' },
        { kind: 'idle' },
      ],
    };
    const hq = await h.startHarmonizer();
    let listed: { processes: { pid: number; why: string; ports: number[] }[] } | undefined;
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('plan', async (t) => {
              const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
                summary: 'One page',
                tasks: [{ description: 'write the page' }],
              });
              taskId = out.tasks[0]!.taskId;
            })
            .once(/was approved/, async (t) => {
              await t.call('spawn_steward', { taskId, instructions: 'scenario:serve' });
            })
            .once(/reported/, async (t) => {
              const steward = h.queries
                .supervisedAgents(wk.agentId)
                .find((a) => a.agent.taskId === taskId)!.agent;
              // The prompt's rule: before merging and closing, list the Steward's processes…
              listed = await t.call('list_steward_processes', { agentId: steward.id });
              // …and stop the leftovers.
              await t.call('stop_steward_processes', {
                agentId: steward.id,
                pids: listed!.processes.map((p) => p.pid),
              });
              await t.call('merge_task', { taskId });
              await t.call('close_task', { taskId });
              await t.call('report_status', {
                text: `Closed ${taskId}; stopped its leftover dev server.`,
              });
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
    await h.until(() => wk.calls('report_status').length > 0, LONG);
    await h.done(LONG);
    await h.composed.processes!.idle();

    expect(listed!.processes).toEqual([
      expect.objectContaining({ pid: server, why: 'worktree', ports: [expect.any(Number)] }),
    ]);
    expect(alive(server)).toBe(false);
    expect(h.log.tables.tasks.get(taskId)!.state).toBe('completed');
    const stopped = events().filter((e) => e.type === 'agent.processes_stopped');
    // Stopped by the Waykeeper; the sweep when the task closed and the Steward ended found nothing.
    expect(stopped).toEqual([
      expect.objectContaining({ pids: [server], by: { type: 'agent', id: wk.agentId } }),
    ]);
    wk.assertCalls([
      'plan_tasks',
      'spawn_steward',
      'list_steward_processes',
      'stop_steward_processes',
      'merge_task',
      'close_task',
      'report_status',
    ]);
  });

  it('the safety net stops what a Steward left when it ends, even if its Waykeeper did not', async () => {
    const project = await gitProject();
    let taskId: Id = '';
    let server = 0;
    scenarios['serve-and-finish'] = {
      steps: [
        {
          kind: 'script',
          run: async () => {
            server = await startOrphanServer(
              h.log.tables.tasks.get(taskId)!.worktreePath!,
              stewardOf(taskId),
            );
          },
        },
        { kind: 'finish', result: 'Done.' },
      ],
    };
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('plan', async (t) => {
              const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
                summary: 'One page',
                tasks: [{ description: 'serve' }],
              });
              taskId = out.tasks[0]!.taskId;
            })
            .once(/was approved/, async (t) => {
              await t.call('spawn_steward', { taskId, instructions: 'scenario:serve-and-finish' });
            })
            .on(/finished/, () => undefined),
      },
    );
    wk.tell('plan');
    await h.until(() => h.log.tables.proposals.all().length > 0);
    await h.commands.decideProposal(
      h.log.tables.proposals.all()[0]!.id,
      { decision: 'approve' },
      { type: 'user' },
    );
    await h.until(() => events().some((e) => e.type === 'agent.processes_stopped'), {
      ...LONG,
      what: 'the sweep',
    });
    await h.done(LONG);
    await h.composed.processes!.idle();
    expect(alive(server)).toBe(false);
    expect(events().filter((e) => e.type === 'agent.processes_stopped')).toEqual([
      expect.objectContaining({ pids: [server], by: { type: 'system' }, sweep: 'agent_ended' }),
    ]);
  });
});
