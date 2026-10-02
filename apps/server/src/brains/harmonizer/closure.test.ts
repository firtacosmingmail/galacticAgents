import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Question } from '@galactic/protocol';
import { tickingClock } from '../../test/world.js';
import { brainHarness, type BrainHarness, type HarnessBrain } from '../testing/index.js';
import { waykeeperDefinition } from '../waykeeper/index.js';
import { harmonizerBrain } from './index.js';

/**
 * P2-13 acceptance, end to end with the scripted fake-LLM harness (P2-07): the Waykeeper requests
 * closure → the Harmonizer asks the user "Anything else on <project>?" → the user closes (from
 * the panel, or by answering) → the Waykeeper is stopped and the project completed; the retention
 * clock then archives it. Real Harmonizer and Waykeeper definitions; scripts stand in for models.
 */

const USER = { type: 'user' } as const;
const DAY = 24 * 60 * 60 * 1000;
const lives: { h: BrainHarness; root: string }[] = [];
afterEach(async () => {
  for (const { h, root } of lives.splice(0)) {
    await h.dispose().catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

interface Setup {
  h: BrainHarness;
  clock: ReturnType<typeof tickingClock>;
  projectId: Id;
  hq: HarnessBrain;
  wk: HarnessBrain;
}

/** A project whose only task is closed, its Waykeeper, and a Harmonizer that relays closure. */
async function setup(): Promise<Setup> {
  const clock = tickingClock();
  const h = brainHarness({ compose: { log: { now: clock } } });
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-closure-')));
  lives.push({ h, root });
  const project = (await h.commands.createProject({ name: 'CSV tool', workspace: '/w/csv' })).value;
  const task = (await h.commands.createTask({ projectId: project.id, description: 'parse' })).value;
  await h.commands.closeTask(task.id, USER);
  const projectId = project.id;

  const hq = await h.startHarmonizer({
    definition: harmonizerBrain({ projectsRoot: root }),
    script: (s) =>
      s
        .once(/reported: .*every task is closed/s, async (t) => {
          const out = await t.call<{ questionId: Id }>('ask_closure', { projectId });
          expect(out.questionId).toMatch(/^q-/);
        })
        // The user answered the question: carry out their decision.
        .on(/answered (\S+): "Close CSV tool"/, async (t) => {
          await t.call('close_project', { projectId });
          t.say('Closed CSV tool.');
        })
        // The user closed it from the panel: the question was withdrawn, nothing to do.
        .on(/withdrawn|closed project|close project/, (t) => t.say('Noted.')),
  });
  const wk = await h.startBrain(
    waykeeperDefinition(),
    { runtime: 'fake', projectId, supervisorId: hq.agentId },
    {
      script: (s) =>
        s
          .once('wrap up', async (t) => {
            await t.call('request_project_closure', { summary: 'The CSV tool is built.' });
          })
          .on(() => {}), // a control event may reach it just before it is stopped
    },
  );
  return { h, clock, projectId, hq, wk };
}

function closureQuestion(h: BrainHarness): Question {
  const questions = h.log.tables.questions.all();
  expect(questions).toHaveLength(1);
  return questions[0]!;
}

async function relayed({ h, wk, hq, projectId }: Setup): Promise<Question> {
  wk.tell('wrap up');
  await h.settle();
  const q = closureQuestion(h);
  expect(q).toMatchObject({
    kind: 'clarification',
    status: 'open',
    originAgentId: hq.agentId,
    holder: USER,
    context: {
      text: 'Anything else on CSV tool? The CSV tool is built.',
      options: ['Close CSV tool', 'Something else: …'],
    },
  });
  expect(h.log.tables.projects.get(projectId)?.meta).toMatchObject({
    closureRequest: { by: wk.agentId, summary: 'The CSV tool is built.', questionId: q.id },
  });
  // Closing is the user's decision: nothing is closed yet and the Waykeeper stays available.
  expect(h.log.tables.projects.get(projectId)?.state).not.toBe('completed');
  expect(h.runtime.liveAgents().map((a) => a.id)).toContain(wk.agentId);
  return q;
}

async function expectClosed({ h, wk, projectId }: Setup): Promise<void> {
  await h.until(() => h.statuses.get(wk.agentId)?.state === 'stopped', {
    what: 'the Waykeeper to be stopped',
  });
  expect(h.log.tables.projects.get(projectId)?.state).toBe('completed');
  expect(h.runtime.liveAgents().map((a) => a.id)).not.toContain(wk.agentId);
  // Transcripts are kept: the Waykeeper's agent row and its events stay.
  expect(h.log.tables.agents.get(wk.agentId)).toBeDefined();
}

describe('closure relay end to end (P2-13)', () => {
  it('Waykeeper requests closure → Harmonizer asks → the user closes from the panel', async () => {
    const s = await setup();
    const q = await relayed(s);
    const { h, projectId } = s;

    await h.commands.control({ kind: 'project', id: projectId }, { action: 'close' }, USER);
    await expectClosed(s);
    await h.settle();
    // Closing answered the question: it is withdrawn, not left open for the user.
    expect(h.log.tables.questions.get(q.id)?.status).toBe('cancelled');
    s.hq.assertCalls(['ask_closure']);
    h.verify();

    // The retention clock started at the closure: the body is kept, then freed.
    const bodyId = h.log.tables.projects.get(projectId)!.bodyId;
    s.clock.advance(7 * DAY - 60_000);
    expect(h.composed.archival.sweep().archived).toEqual([]);
    s.clock.advance(120_000);
    expect(h.composed.archival.sweep().archived).toEqual([{ kind: 'project', id: projectId }]);
    expect(h.log.tables.bodies.get(bodyId)?.host).toBeUndefined();
  });

  it('… or by answering the question, which the Harmonizer carries out', async () => {
    const s = await setup();
    const q = await relayed(s);
    const { h } = s;

    await h.commands.answerQuestion({ questionId: q.id, answer: 'Close CSV tool', by: USER });
    await expectClosed(s);
    await h.settle();
    s.hq.assertCalls(['ask_closure', 'close_project']);
    expect(h.log.tables.questions.get(q.id)?.status).toBe('answered');
    h.verify();
  });
});
