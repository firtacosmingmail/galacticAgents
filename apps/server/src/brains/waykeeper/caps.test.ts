import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import { gitRunner } from '../../workspace/git.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { waykeeperDefinition } from './index.js';

/**
 * P2-17 acceptance with the P2-07 harness: a real Waykeeper (prompt and tools) over real
 * `DomainCommands` tries one `spawn_steward` beyond its Stewards-per-Waykeeper cap. The refusal
 * comes back as a tool error naming the cap, and the Waykeeper reports it — in its own transcript
 * and, through `report_status`, in the Harmonizer's mailbox.
 */

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

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-caps-')));
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  h = brainHarness({
    compose: {
      caps: { maxStewardsPerWaykeeper: 2 },
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

describe('Waykeeper under the spawn caps (P2-17)', () => {
  it('sees a spawn beyond its Stewards cap refused as a tool error and reports it', async () => {
    const dir = join(tmp, 'home', 'CSV tool');
    const project = (await h.commands.createProject({ name: 'CSV tool', workspace: dir })).value;
    await h.composed.workspaces!.prepareProject(project.id);
    writeFileSync(join(dir, 'shared.txt'), 'base\n');
    git(dir, 'add', 'shared.txt');
    git(dir, 'commit', '-q', '-m', 'base');

    let plan: Id[] = [];
    let refusal = '';
    const hq = await h.startHarmonizer();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('plan', async (t) => {
              const out = await t.call<{ tasks: { taskId: Id }[] }>('plan_tasks', {
                summary: 'Three files',
                tasks: [{ description: 'a' }, { description: 'b' }, { description: 'c' }],
              });
              plan = out.tasks.map((x) => x.taskId);
            })
            .once(/was approved/, async (t) => {
              // Two Stewards that keep working (idle, live) fill the cap.
              await t.call('spawn_steward', { taskId: plan[0], instructions: 'scenario:echo' });
              await t.call('spawn_steward', { taskId: plan[1], instructions: 'scenario:echo' });
              const third = await t.try('spawn_steward', {
                taskId: plan[2],
                instructions: 'scenario:echo',
              });
              expect(third).toMatchObject({ ok: false, error: 'conflict' });
              refusal = third.message ?? '';
              t.say(`Task ${plan[2]} waits: ${refusal}`);
              await t.call('report_status', {
                text: `Spawn refused for task ${plan[2]}: ${refusal}. I start it when a Steward ends.`,
              });
            })
            // The Stewards' end-of-turn reports (P2-11) wake it; nothing to do in this test.
            .on(/reported: "Task/, () => Promise.resolve()),
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

    expect(refusal).toBe(
      `Stewards-per-Waykeeper cap: Waykeeper ${wk.agentId} already supervises 2 of 2 live ` +
        'Stewards; a slot frees when one of them finishes, fails or is stopped',
    );
    // In the Waykeeper's transcript: the refused call with its reason, and what it said about it.
    wk.assertCalls([
      'plan_tasks',
      'spawn_steward',
      'spawn_steward',
      'spawn_steward',
      'report_status',
    ]);
    const rendered = wk.transcript.render();
    expect(rendered).toContain('Stewards-per-Waykeeper cap');
    expect(rendered).toContain(`Task ${plan[2]} waits`);
    // …and in its persisted agent transcript, as the ops console shows it.
    h.composed.transcripts.flush();
    const persisted = h.composed.transcripts
      .read(wk.agentId)
      .map((c) => c.text)
      .join('');
    expect(persisted).toContain(`Task ${plan[2]} waits: Stewards-per-Waykeeper cap`);
    // The report reached the Harmonizer.
    await h.until(() => hq.prompts().some((p) => p.includes('Spawn refused')), LONG);
    // The refused spawn left no agent behind; the two Stewards still run.
    const stewards = h.queries.supervisedAgents(wk.agentId);
    expect(stewards.map((s) => s.agent.taskId).sort()).toEqual([plan[0], plan[1]].sort());
    expect(h.log.tables.agents.all().some((a) => a.taskId === plan[2])).toBe(false);
  });
});
