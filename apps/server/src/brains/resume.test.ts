import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Event, Id } from '@galactic/protocol';
import { SCENARIOS, type FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase, type Database } from '../db/database.js';
import { gitRunner } from '../workspace/git.js';
import { harmonizerBrain } from './harmonizer/index.js';
import { brainHarness, type BrainHarness, type HarnessBrain } from './testing/index.js';
import { waykeeperDefinition } from './waykeeper/index.js';

/**
 * P2-16 acceptance: the hierarchy survives a kill -9. A running hierarchy — the Harmonizer, a
 * project's Waykeeper, two Stewards (one asking a clarification, one idle after its report), the
 * Harmonizer's own questions to the user and a pending card — is dropped without a shutdown (a
 * second harness over the same database and fake session store, as `runtime/recovery.test.ts`
 * does). Recovery brings the brains back as brains, supervisors first, folds what they had not
 * consumed into their first turn, and the Harmonizer tells the user what was recovered.
 */

const USER = { type: 'user' } as const;
const LONG = { timeoutMs: 4_000 };

const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const dbs: Database[] = [];
const dirs: string[] = [];
const lives: BrainHarness[] = [];
afterEach(async () => {
  // The newest life first: an older one's dispose must not write into a live one's database.
  for (const h of lives.splice(0).reverse()) await h.dispose().catch(() => {});
  for (const d of dbs.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface World {
  db: Database;
  tmp: string;
  sessions: Map<string, number>;
  scenarios: Record<string, FakeScenario>;
}

function world(): World {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-resume-')));
  dirs.push(tmp);
  for (const d of ['home', 'data', 'projects']) mkdirSync(join(tmp, d));
  return {
    db,
    tmp,
    sessions: new Map(),
    scenarios: {
      ...SCENARIOS,
      notes: { steps: [{ kind: 'output', text: 'Done: wrote notes.md; nothing left over.' }] },
    },
  };
}

function boot(w: World): BrainHarness {
  const h = brainHarness({
    db: w.db,
    adapter: { scenarios: w.scenarios, sessionStore: w.sessions },
    // Real worktrees (two Stewards of one project run side by side only in a git workspace).
    compose: {
      workspaces: {
        projectsRoot: join(w.tmp, 'projects'),
        dataDir: join(w.tmp, 'data'),
        home: join(w.tmp, 'home'),
        git: gitRunner({ env: GIT_ENV }),
      },
    },
    // Recovery reports what it could not resume through `onError`; the tests assert on states.
    failOnErrors: false,
  });
  lives.push(h);
  return h;
}

const hqDefinition = () => harmonizerBrain({ projectsRoot: '/w/projects' });

/** Registers the brain definitions recovery resumes brains with (what `index.ts` does). */
function defineBrains(h: BrainHarness): void {
  h.composed.defineBrains({ harmonizer: hqDefinition, waykeeper: () => waykeeperDefinition() });
}

const events = (h: BrainHarness): { seq: number; event: Event }[] =>
  h.log.eventsSince(0, Number.MAX_SAFE_INTEGER);

/** Life 1: a running hierarchy, settled. */
async function firstLife(h: BrainHarness, w: World) {
  const hq = await h.startHarmonizer({
    definition: hqDefinition(),
    scriptOptions: { strict: false },
    script: (s) =>
      s
        .once('ask me', (t) => t.call('ask_user', { text: 'Which name for the CLI?' }))
        .once('ask more', (t) => t.call('ask_user', { text: 'Which licence?' })),
  });
  const project = (
    await h.commands.createProject({ name: 'Notes', workspace: join(w.tmp, 'home', 'Notes') })
  ).value;
  await h.composed.workspaces!.prepareProject(project.id);
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
    {
      scriptOptions: { strict: false },
      script: (s) =>
        s.on(/was added to your project/, async (t) => {
          for (const m of t.prompt.matchAll(/task (\S+) was added to your project[^:]*: "([^"]+)"/g)) {
            await t.call('spawn_steward', {
              taskId: m[1],
              instructions: `scenario:${m[2]!.split(' ')[0]}\nDo it.`,
            });
          }
        }),
    },
  );
  const asking = (await h.commands.createTask({ description: 'asks first', projectId: project.id }))
    .value;
  const notes = (await h.commands.createTask({ description: 'notes now', projectId: project.id }))
    .value;
  const stewardOf = (taskId: Id) =>
    h.log.tables.agents.all().find((a) => a.role === 'steward' && a.taskId === taskId);
  await h.until(
    () =>
      h.statuses.get(stewardOf(asking.id)?.id ?? '')?.state === 'waiting_for_input' &&
      h.statuses.get(stewardOf(notes.id)?.id ?? '')?.state === 'idle',
    { ...LONG, what: 'one Steward asking, one idle' },
  );
  hq.tell('ask me');
  await h.settle(LONG);
  hq.tell('ask more');
  await h.settle(LONG);
  // A card waiting for the user: nothing may be created or spawned for it across the restart.
  const card = (
    await h.commands.createProposal({
      requestText: 'rename the logs',
      kind: 'asteroid',
      proposedBody: { kind: 'asteroid', name: 'Rename logs' },
      workspace: '/w/projects/scratch/rename-logs',
      rationale: 'small',
      meta: { request: { type: 'standalone_task', name: 'Rename logs', description: 'rename' } },
    })
  ).value;
  await h.settle(LONG);
  const [nameQ, licenceQ] = h.log.tables.questions
    .all()
    .filter((q) => q.originAgentId === hq.agentId)
    .map((q) => q.id);
  return {
    hq,
    wk,
    project,
    card,
    asker: stewardOf(asking.id)!,
    noter: stewardOf(notes.id)!,
    nameQ: nameQ!,
    licenceQ: licenceQ!,
    askedQ: h.statuses.get(stewardOf(asking.id)!.id)!.pendingQuestionId!,
  };
}

describe('hierarchy restart and resume (P2-16)', () => {
  it('a kill -9 drill: brains come back as brains, supervisors first, nothing duplicated, the user is told', async () => {
    const w = world();
    const h1 = boot(w);
    const one = await firstLife(h1, w);
    const agentsBefore = h1.log.tables.agents.all().length;
    const noterReports = (h: BrainHarness) =>
      events(h).filter(
        ({ event: e }) =>
          e.type === 'message.sent' &&
          e.agentId === one.wk.agentId &&
          e.sender.type === 'agent' &&
          e.sender.id === one.noter.id,
      );
    expect(noterReports(h1)).toHaveLength(1);

    // kill -9: what was committed last never reached a turn — the user's line to the Waykeeper,
    // and the user's answer to the Harmonizer's first question.
    h1.crash();
    const late = h1.runtime.send(one.wk.agentId, 'please add a README task too', {
      sender: USER,
    });
    await h1.commands.answerQuestion({ questionId: one.nameQ, answer: 'notes-cli', by: USER });

    // Second life over the same database and session store.
    const h2 = boot(w);
    defineBrains(h2);
    const said: string[] = [];
    h2.script('harmonizer', { strict: false })
      .once(/the server restarted — recovered/, (t) => {
        const line = /recovered: (\d+) agents? resumed, (\d+) needs? attention/.exec(t.prompt)!;
        const text = `recovered: ${line[1]} resumed, ${line[2]} need attention`;
        said.push(text);
        t.say(text);
      })
      .once('how is it going?', async (t) => {
        await t.call('report_status', {});
      });
    h2.script('waykeeper', { strict: false }).once('what do you supervise?', async (t) => {
      await t.call('list_supervised_agents', {});
    });
    const seqBefore = h2.log.currentSeq();
    const { report, resumed } = await h2.recover();
    expect(h2.composed.announceRecovery(report)).toBe(true);

    // Every agent came back: the brains through their runners.
    expect([...report.resumed].sort()).toEqual(
      [one.hq.agentId, one.wk.agentId, one.asker.id, one.noter.id].sort(),
    );
    expect(report.needAttention).toEqual([]);
    expect(resumed.map((b) => b.agentId).sort()).toEqual([one.hq.agentId, one.wk.agentId].sort());
    // Supervisors first: the Harmonizer, then the Waykeeper, then the Stewards.
    const respawned = events(h2)
      .filter(({ seq, event }) => seq > seqBefore && event.type === 'agent.spawned')
      .map(({ event }) => (event as Extract<Event, { type: 'agent.spawned' }>).agentId);
    expect(respawned.slice(0, 2)).toEqual([one.hq.agentId, one.wk.agentId]);
    expect(new Set(respawned.slice(2))).toEqual(new Set([one.asker.id, one.noter.id]));

    await h2.until(
      () => h2.statuses.get(one.asker.id)?.state === 'waiting_for_input',
      { ...LONG, what: 'the asking Steward to ask again' },
    );
    await h2.settle(LONG);
    for (const id of [one.hq.agentId, one.wk.agentId, one.asker.id, one.noter.id]) {
      expect(['working', 'idle', 'waiting_for_input']).toContain(h2.statuses.get(id)?.state);
    }

    const hq2 = h2.brains.find((b) => b.agentId === one.hq.agentId)! as HarnessBrain;
    const wk2 = h2.brains.find((b) => b.agentId === one.wk.agentId)! as HarnessBrain;
    // The first turn after the resume folds what the brain had not consumed.
    const wkResume = wk2.prompts().find((p) => p.includes('your session as the waykeeper was resumed'))!;
    expect(wkResume).toContain('the user said: "please add a README task too"');
    const hqResume = hq2.prompts().find((p) => p.includes('your session as the harmonizer was resumed'))!;
    expect(hqResume).toContain(`answered ${one.nameQ}: "notes-cli"`);
    // … and only that: nothing the brain already saw or did itself.
    expect(hqResume).not.toContain('Which licence?');
    expect(wkResume).not.toContain('was added to your project');
    // The late message is delivered once, inside the turn; it never reaches the session raw.
    const deliveries = events(h2).filter(
      ({ event: e }) => e.type === 'message.delivered' && e.messageId === late.id,
    );
    expect(deliveries).toHaveLength(1);

    // The user is told, in the Harmonizer's chat.
    expect(said).toEqual(['recovered: 4 resumed, 0 need attention']);
    h2.composed.transcripts.flush();
    expect(h2.composed.transcripts.read(one.hq.agentId).map((c) => c.text)).toContain(
      'recovered: 4 resumed, 0 need attention',
    );

    // The brains have their tools: a scripted turn works.
    hq2.tell('how is it going?');
    wk2.tell('what do you supervise?');
    await h2.settle(LONG);
    expect(hq2.calls('report_status')).toMatchObject([{ ok: true }]);
    expect(wk2.calls('list_supervised_agents')).toMatchObject([{ ok: true }]);

    // No duplicate questions: the Steward's question was cancelled with its session and asked
    // again, held by its (resumed) Waykeeper — not climbed to the user; the Harmonizer's open
    // question to the user survived; nothing else is open.
    const questions = h2.log.tables.questions.all();
    expect(questions.find((q) => q.id === one.askedQ)?.status).toBe('cancelled');
    const open = questions.filter((q) => q.status === 'open');
    expect(open.map((q) => q.id).sort()).toEqual(
      [one.licenceQ, h2.statuses.get(one.asker.id)!.pendingQuestionId!].sort(),
    );
    expect(open.find((q) => q.originAgentId === one.asker.id)?.holder).toEqual({
      type: 'agent',
      id: one.wk.agentId,
    });
    expect(questions.find((q) => q.id === one.nameQ)?.status).toBe('answered');

    // No duplicate spawns, no second Harmonizer, the card still waits; the idle Steward's report
    // was not sent a second time.
    expect(h2.log.tables.agents.all()).toHaveLength(agentsBefore);
    expect(h2.runtime.liveAgents().filter((a) => a.role === 'harmonizer')).toHaveLength(1);
    expect(h2.log.tables.proposals.get(one.card.id)?.state).toBe('pending');
    expect(noterReports(h2)).toHaveLength(1);
    h2.verify();
  });

  it('a brain whose session cannot be resumed gets a fresh, re-seeded session on the same row', async () => {
    const w = world();
    const h1 = boot(w);
    const one = await firstLife(h1, w);
    await h1.composed.shutdown();
    // Forget the Waykeeper's session, as a runtime that lost it would.
    h1.log.runCommand((ctx) => {
      const { sessionRef: _ref, ...rest } = ctx.tables.agents.get(one.wk.agentId)!;
      ctx.tables.agents.upsert(rest);
    });

    const h2 = boot(w);
    defineBrains(h2);
    h2.script('waykeeper', { strict: false }).once('what do you supervise?', async (t) => {
      await t.call('list_supervised_agents', {});
    });
    const { report } = await h2.recover();
    expect(report.resumed).toContain(one.wk.agentId);
    await h2.settle(LONG);
    const wk2 = h2.brains.find((b) => b.agentId === one.wk.agentId)!;
    const first = wk2.prompts()[0]!;
    expect(first).toContain('your previous session could not be resumed');
    // Re-seeded from the database: its Stewards are in the state block.
    expect(first).toContain(one.noter.id);
    wk2.tell('what do you supervise?');
    await h2.settle(LONG);
    expect(wk2.calls('list_supervised_agents')).toMatchObject([{ ok: true }]);
    expect(h2.log.tables.agents.all().filter((a) => a.role === 'waykeeper')).toHaveLength(1);
  });

  it("the panel's resume action brings an interrupted brain back as a brain", async () => {
    const w = world();
    const h1 = boot(w);
    const one = await firstLife(h1, w);
    await h1.composed.shutdown(); // every agent interrupted

    const h2 = boot(w);
    defineBrains(h2);
    h2.script('waykeeper', { strict: false }).once('what do you supervise?', async (t) => {
      await t.call('list_supervised_agents', {});
    });
    // No startup recovery: the user resumes the Waykeeper from the panel (POST …/recover).
    const result = await h2.runtime.recoverAgent(one.wk.agentId);
    expect(result.ok).toBe(true);
    const runner = h2.composed.runnerOf(one.wk.agentId);
    expect(runner?.definition.role).toBe('waykeeper');
    expect(h2.runtime.hasMailbox(one.wk.agentId)).toBe(true);
    await runner!.settled();
    h2.tell(one.wk.agentId, 'what do you supervise?');
    await h2.until(() => runner!.turns.length >= 2 && runner!.state === 'idle', LONG);
    await runner!.settled();
    const outcome = h2.transcript(one.wk.agentId)!.calls('list_supervised_agents');
    expect(outcome).toMatchObject([{ ok: true }]);
    // A second resume is refused: it runs.
    expect((await h2.runtime.recoverAgent(one.wk.agentId)).ok).toBe(false);
  });
});
