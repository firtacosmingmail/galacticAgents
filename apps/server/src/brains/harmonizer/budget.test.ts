import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import type { FakeScenario } from '../../adapters/fake/scenario.js';
import { History } from '../../runtime/history.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import type { ToolOutcome } from '../testing/transcript.js';
import { waykeeperDefinition } from '../waykeeper/index.js';
import { harmonizerBrain } from './index.js';

/**
 * P8-01 acceptance with the scripted fake LLM (P2-07): the user gives an asteroid task a budget
 * on its card; its Steward fails after a cost over it (a fake cost report); the user reopens the
 * task, and the Harmonizer's new `spawn_steward` for it comes back refused ("budget exceeded"),
 * while the running work was never stopped for money. The refusal
 * is visible in the Harmonizer's chat — the server's own line and the Harmonizer's reply — as
 * `GET /api/agents/:id/conversation` serves it.
 */

const USER = { type: 'user' } as const;

const SCENARIOS: Record<string, FakeScenario> = {
  spend: {
    steps: [{ kind: 'output', text: 'working' }],
    // `fail <usd>`: the session dies, its last report carrying that running total.
    onMessage: (message) => {
      const m = /^fail ([\d.]+)$/.exec(message);
      return m
        ? [{ kind: 'fail', error: 'crashed', reason: 'crash', cost: { usd: Number(m[1]) } }]
        : [];
    },
  },
};

const lives: { h: BrainHarness; root: string }[] = [];
afterEach(async () => {
  for (const { h, root } of lives.splice(0)) {
    await h.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Harmonizer under a dollar budget (P8-01)', () => {
  it('sees a spawn over the budget refused, and the refusal shows in its chat', async () => {
    const h = brainHarness({ adapter: { scenarios: SCENARIOS } });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-budget-hq-')));
    lives.push({ h, root });
    const definition = harmonizerBrain({
      projectsRoot: root,
      stewardPrompt: () => 'scenario:spend',
      ensureDir: () => {},
      startWaykeeper: () => Promise.reject(new Error('no projects here')),
    });

    // The user's card, with a budget the user gave it, approved.
    const { value: card } = await h.commands.createProposal({
      requestText: 'rename the logs',
      kind: 'asteroid',
      proposedBody: { kind: 'asteroid', name: 'Rename logs' },
      workspace: join(root, 'logs'),
      rationale: 'small',
      meta: {
        request: { type: 'standalone_task', name: 'Rename logs', description: 'rename the logs' },
      },
    });
    await h.commands.decideProposal(
      card.id,
      { decision: 'edit', changes: { budgetUsd: 0.1 } },
      USER,
    );
    await h.commands.decideProposal(card.id, { decision: 'approve' }, USER);
    const task = h.log.tables.tasks.all()[0]!;
    expect(task.budgetUsd).toBe(0.1);

    let refused: ToolOutcome | undefined;
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('go', async (t) => {
            await t.call<{ taskId: Id }>('create_task', { proposalId: card.id });
            await t.call('spawn_steward', { taskId: task.id });
          })
          // The user reopened the failed task: it starts a Steward again.
          .once(/reopened task/, async (t) => {
            refused = await t.try('spawn_steward', { taskId: task.id });
            t.say(`Not started: ${refused.message ?? ''}`);
          })
          // The Steward's report, its failure and the exceeded notice: nothing to do yet.
          .on(/reported|failed \(crash\)|budget exceeded/, () => {}),
    });

    hq.tell('go');
    await h.until(() => h.log.tables.agents.all().some((a) => a.role === 'steward'), {
      what: 'the Steward',
    });
    const steward = h.log.tables.agents.all().find((a) => a.role === 'steward')!;
    await h.until(() => h.statuses.get(steward.id)?.state === 'idle', { what: 'its first turn' });
    // The Steward's session fails having cost $0.20: over the $0.10 budget.
    h.runtime.send(steward.id, 'fail 0.2', { sender: USER });
    await h.until(() => h.log.tables.tasks.get(task.id)?.state === 'failed', { what: 'failure' });
    await h.until(() => h.log.eventsSince(0).some((e) => e.event.type === 'budget.exceeded'), {
      what: 'the budget to be exceeded',
    });
    await h.settle();
    await h.commands.control({ kind: 'task', id: task.id }, { action: 'reopen' }, USER);
    await h.until(() => refused !== undefined, { what: 'the respawn' });
    await h.done();

    expect(refused).toMatchObject({ ok: false, error: 'conflict' });
    expect(refused?.message).toMatch(
      /^budget exceeded: task "rename the logs" \(.+\) has spent \$0\.20 of its \$0\.10 budget, so no new steward is started for it/,
    );
    expect(h.log.tables.agents.all().filter((a) => a.role === 'steward')).toHaveLength(1);

    // The Harmonizer's chat, as the panel reads it: the server's lines and the reply.
    h.composed.transcripts.flush();
    const chat = new History(h.log.db)
      .conversation(hq.agentId, { limit: 100 })
      .entries.map((e) => `${e.kind === 'message' ? (e.sender?.type ?? '?') : 'reply'}: ${e.text}`);
    expect(chat).toContainEqual(
      expect.stringMatching(
        /^system: Budget exceeded: task "rename the logs" .* has spent \$0\.20 of its \$0\.10 budget/,
      ),
    );
    expect(chat).toContainEqual(
      expect.stringMatching(
        /^system: Spawn refused: a new steward for task .* Raise or remove the budget/,
      ),
    );
    expect(chat).toContainEqual(
      expect.stringMatching(/^reply: Not started: budget exceeded: task/),
    );
    hq.assertCalls(['create_task', 'spawn_steward', 'spawn_steward']);
  });

  it('starts the refused Waykeeper again once the user raises the budget (review fix)', async () => {
    const h = brainHarness({ adapter: { scenarios: SCENARIOS } });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-budget-wk-')));
    lives.push({ h, root });
    const definition = harmonizerBrain({
      projectsRoot: root,
      startWaykeeper: async ({ projectId, supervisorId }) => {
        const wk = await h.startBrain(
          waykeeperDefinition(),
          { runtime: 'fake', projectId, supervisorId },
          { scriptOptions: { strict: false } },
        );
        return { agentId: wk.agentId };
      },
    });
    const project = (
      await h.commands.createProject({ name: 'Docs', workspace: join(root, 'docs') })
    ).value;
    const target = { kind: 'project' as const, id: project.id };
    await h.commands.setBudget(target, 0.1, USER, { origin: 'local' });

    let refused: ToolOutcome | undefined;
    let restarted: ToolOutcome | undefined;
    const hq = await h.startHarmonizer({
      definition,
      script: (s) =>
        s
          .once('go', async (t) => {
            refused = await t.try('spawn_waykeeper', { projectId: project.id });
          })
          // The wake line for the raised budget names the unattended project.
          .once(
            /has no running Waykeeper: if the budget now allows it, spawn_waykeeper/,
            async (t) => {
              restarted = await t.try('spawn_waykeeper', { projectId: project.id });
              t.say('Started the Waykeeper of Docs again.');
            },
          )
          .on(/reported|failed \(crash\)|budget exceeded/, () => {}),
    });

    // Its first Waykeeper spends over the budget and fails (a crash).
    const first = (
      await h.commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        projectId: project.id,
        supervisorId: hq.agentId,
        prompt: 'scenario:spend',
      })
    ).value;
    await h.until(() => h.statuses.get(first.id)?.state === 'idle', { what: 'its first turn' });
    h.runtime.send(first.id, 'fail 0.2', { sender: USER });
    await h.until(() => h.log.eventsSince(0).some((e) => e.event.type === 'budget.exceeded'), {
      what: 'the budget to be exceeded',
    });
    await h.settle();

    hq.tell('go');
    await h.until(() => refused !== undefined, { what: 'the refused spawn' });
    expect(refused).toMatchObject({ ok: false, error: 'conflict' });
    expect(h.log.tables.agents.all().filter((a) => a.role === 'waykeeper')).toHaveLength(1);

    // The user raises the budget on the Mac: the Harmonizer is woken and starts the Waykeeper.
    await h.commands.setBudget(target, 1, USER, { origin: 'local' });
    await h.until(() => restarted !== undefined, { what: 'the restart' });
    await h.done();
    expect(restarted?.ok, restarted?.message).toBe(true);
    const wk = h.log.tables.agents.all().filter((a) => a.role === 'waykeeper');
    expect(wk.map((a) => a.projectId)).toEqual([project.id, project.id]);
    expect(h.statuses.get(wk[1]!.id)?.state).not.toBe('failed');
    hq.assertCalls(['spawn_waykeeper', 'spawn_waykeeper']);
  });
});
