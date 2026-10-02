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

describe('closure needs the user’s word, checked in code (decision 11; review)', () => {
  it('refuses close_project and finished_work without a user answer, and acts on a confirmation', async () => {
    const clock = tickingClock();
    const h = brainHarness({ compose: { log: { now: clock } } });
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-closure-')));
    lives.push({ h, root });
    const project = (await h.commands.createProject({ name: 'Tool', workspace: '/w/tool' })).value;
    const done = (await h.commands.createTask({ description: 'old script' })).value;
    await h.commands.closeTask(done.id, USER);
    const outcomes: Record<string, unknown> = {};
    const asked: Id[] = [];
    const hq = await h.startHarmonizer({
      definition: harmonizerBrain({ projectsRoot: root }),
      script: (s) =>
        s
          .once('close it on your own', async (t) => {
            outcomes['close'] = await t.try('close_project', { projectId: project.id });
            outcomes['archive'] = await t.try('finished_work', {
              kind: 'task',
              id: done.id,
              action: 'archive',
            });
          })
          .once('please archive the old script', async (t) => {
            const out = await t.call<{ questionId: Id }>('ask_confirmation', {
              kind: 'task',
              id: done.id,
              action: 'archive',
            });
            asked.push(out.questionId);
          })
          .once(/answered (\S+): "No"/, async (t) => {
            outcomes['declined'] = await t.try('finished_work', {
              kind: 'task',
              id: done.id,
              action: 'archive',
              questionId: asked[0],
            });
            // A confirmation of another action does not count either.
            outcomes['other'] = await t.try('finished_work', {
              kind: 'task',
              id: done.id,
              action: 'reopen',
              questionId: asked[0],
            });
          })
          .once('ask again', async (t) => {
            const out = await t.call<{ questionId: Id }>('ask_confirmation', {
              kind: 'task',
              id: done.id,
              action: 'archive',
            });
            asked.push(out.questionId);
          })
          .once(/answered (\S+): "Archive/, async (t) => {
            outcomes['archived'] = await t.call('finished_work', {
              kind: 'task',
              id: done.id,
              action: 'archive',
              questionId: asked[1],
            });
          })
          .on(
            () => true,
            () => {},
            'anything else',
          ),
    });
    hq.tell('close it on your own');
    await h.settle();
    expect(outcomes['close']).toMatchObject({ ok: false, error: 'invalid' });
    expect(outcomes['archive']).toMatchObject({ ok: false, error: 'invalid' });
    expect(h.log.tables.projects.get(project.id)?.state).not.toBe('completed');
    expect(h.log.tables.tasks.get(done.id)?.state).toBe('completed');

    hq.tell('please archive the old script');
    await h.settle();
    expect(h.log.tables.questions.get(asked[0]!)).toMatchObject({
      status: 'open',
      holder: USER,
      context: { options: [expect.stringMatching(/^Archive task "old script"/), 'No'] },
    });
    await h.commands.answerQuestion({ questionId: asked[0]!, answer: 'No', by: USER });
    await h.settle();
    expect(outcomes['declined']).toMatchObject({ ok: false, error: 'invalid' });
    expect(outcomes['other']).toMatchObject({ ok: false, error: 'invalid' });
    expect(h.log.tables.tasks.get(done.id)?.state).toBe('completed');

    hq.tell('ask again');
    await h.settle();
    const q = h.log.tables.questions.get(asked[1]!)!;
    await h.commands.answerQuestion({ questionId: q.id, answer: q.context.options![0]!, by: USER });
    await h.until(() => h.log.tables.tasks.get(done.id)?.state === 'archived', {
      what: 'the task to be archived',
    });
    expect(outcomes['archived']).toMatchObject({ state: 'archived' });
  });
});
