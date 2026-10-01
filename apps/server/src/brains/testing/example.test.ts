import { afterEach, describe, expect, it } from 'vitest';
import type { Id, Question, Task } from '@galactic/protocol';
import type { BrainDefinition } from '../definition.js';
import { WAKE_RULES, type WakeRules } from '../wake.js';
import { brainDefinition, brainHarness, tool, type BrainHarness } from './index.js';

/**
 * A worked example of the brain harness (P2-07), meant to be copied by the Harmonizer (P2-08)
 * and Waykeeper (P2-10) tests: a tiny brain definition whose tools call `DomainCommands`, a
 * script per brain that reacts to its turn prompts and chains tool results, and assertions on
 * the transcript, the database and the harness's own verification.
 */

const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
});

// -- the tiny brains ---------------------------------------------------------------------------

/**
 * Today's wake table does not wake a brain when a question it asked itself is answered (a
 * Steward's answer reaches it through the adapter; a brain is not blocked). These brains add
 * that rule through `wakeRules`; P2-08/P2-10 should make it part of `WAKE_RULES`.
 */
const answered = WAKE_RULES['question.answered']!;
const wakeRules: WakeRules = {
  ...WAKE_RULES,
  'question.answered': {
    wakes: (e, s) => s.question(e.questionId)?.originAgentId === s.brainId || answered.wakes(e, s),
    describe: answered.describe,
  },
};

const createTask = tool(
  'create_task',
  async (input, ctx) => {
    const { description } = input as { description: string };
    const { value } = await ctx.commands.createTask({
      description,
      ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    });
    return { id: value.id, bodyId: value.bodyId };
  },
  { inputSchema: { type: 'object', properties: { description: { type: 'string' } } } },
);

/** A clarification question; it is held by the asker's supervisor, or the user at the top. */
const ask = (name: string) =>
  tool(
    name,
    async (input, ctx) => {
      const { text } = input as { text: string };
      const { value } = await ctx.commands.openQuestion({
        kind: 'clarification',
        originAgentId: ctx.brainId,
        context: { text },
      });
      return { questionId: value.id, holder: value.holder };
    },
    { endsTurn: true },
  );

const answerQuestion = tool('answer_question', async (input, ctx) => {
  const { questionId, answer } = input as { questionId: Id; answer: string };
  const { value } = await ctx.commands.answerQuestion({ questionId, answer, by: ctx.actor });
  return { status: value.status };
});

const harmonizer: BrainDefinition = brainDefinition(
  'harmonizer',
  [createTask, ask('ask_user'), answerQuestion],
  { systemPrompt: 'You are the Harmonizer of the example.', wakeRules },
);
const waykeeper: BrainDefinition = brainDefinition('waykeeper', [createTask, ask('escalate')], {
  systemPrompt: 'You are the Waykeeper of the example.',
  wakeRules,
});

/** The id and answer out of a prompt line like `user answered q-…: "ISO 8601"`. */
const answerIn = (prompt: string) => /answered (\S+): "(.*)"/.exec(prompt)?.slice(1) ?? [];

describe('brain harness — worked example', () => {
  it('Harmonizer: creates a task, asks the user, and finishes the job with the answer', async () => {
    const h = brainHarness();
    lives.push(h);
    const hq = await h.startHarmonizer({
      definition: harmonizer,
      script: (s) =>
        s
          .once('fix the flaky date test', async (t) => {
            // Use the id the first call returned in the second one.
            const task = await t.call<{ id: Id }>('create_task', {
              description: 'fix the flaky date test',
            });
            const asked = await t.call<{ questionId: Id }>('ask_user', {
              text: `Should ${task.id} also cover time zones?`,
            });
            expect(asked.questionId).toMatch(/^q-/);
          })
          .once(/user answered/, async (t) => {
            const [questionId, answer] = answerIn(t.prompt);
            // Earlier turns' results are in the transcript.
            const asked = t.transcript.last('ask_user')!.value as { questionId: Id };
            expect(questionId).toBe(asked.questionId);
            await t.call('create_task', { description: `time zones: ${answer}` });
          }),
    });

    hq.tell('fix the flaky date test');
    await hq.waitForTurns(2);
    const [question] = h.log.tables.questions.all();
    expect(question).toMatchObject({ kind: 'clarification', holder: { type: 'user' } });
    await h.commands.answerQuestion({
      questionId: question!.id,
      answer: 'yes',
      by: { type: 'user' },
    });
    await h.done(); // settles every brain and verifies every script

    hq.assertCalls(['create_task', 'ask_user', 'create_task']);
    expect(hq.calls('ask_user')[0]).toMatchObject({ ok: true, turnEnded: true });
    const tasks = h.log.tables.tasks.all().map((t: Task) => t.description);
    expect(tasks).toEqual(['fix the flaky date test', 'time zones: yes']);
    // Its own question and task never woke it: three turns (spawn, the request, the answer).
    expect(hq.turns).toHaveLength(3);
  });

  it('Waykeeper under the Harmonizer: its question is held and answered by the Harmonizer', async () => {
    const h = brainHarness();
    lives.push(h);
    // Start the Harmonizer first: every Waykeeper and Steward needs a supervisor (P2-20).
    const hq = await h.startHarmonizer({
      definition: harmonizer,
      script: (s) =>
        s.once(/asked (\S+) \(held by you\)/, async (t) => {
          const questionId = /asked (\S+) \(held by you\)/.exec(t.prompt)![1]!;
          await t.call('answer_question', { questionId, answer: 'ISO 8601' });
        }),
    });
    const project = (await h.commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
    const wk = await h.startBrain(
      waykeeper,
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('plan the export', (t) => t.call('escalate', { text: 'Which date format?' }))
            .once(/answered/, async (t) => {
              const [, format] = answerIn(t.prompt);
              await t.call('create_task', { description: `export dates as ${format}` });
            }),
      },
    );

    wk.tell('plan the export');
    await h.done();

    const escalated = wk.calls('escalate')[0]!;
    expect(escalated.value).toMatchObject({ holder: { type: 'agent', id: hq.agentId } });
    const question = h.log.tables.questions.get(
      (escalated.value as { questionId: Id }).questionId,
    ) as Question;
    expect(question).toMatchObject({
      status: 'answered',
      answer: 'ISO 8601',
      answeredBy: { type: 'agent', id: hq.agentId },
    });
    expect(h.queries.projectTasks(project.id).map((t) => t.description)).toEqual([
      'export dates as ISO 8601',
    ]);
    hq.assertCalls(['answer_question']);
    wk.assertCalls(['escalate', 'create_task']);
  });
});
