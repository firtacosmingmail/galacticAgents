import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Id } from '@galactic/protocol';
import { brainHarness, type BrainHarness } from './testing/index.js';
import { HARMONIZER_SYSTEM_PROMPT, harmonizerBrain } from './harmonizer/index.js';
import { WAYKEEPER_SYSTEM_PROMPT, waykeeperDefinition } from './waykeeper/index.js';

/**
 * The shared supervision tools (P2-10), exercised through a Waykeeper; the Harmonizer (P2-08)
 * uses the same module.
 */

const lives: BrainHarness[] = [];
afterEach(async () => {
  for (const h of lives.splice(0)) await h.dispose().catch(() => {});
});

async function setup() {
  const h = brainHarness();
  lives.push(h);
  const hq = await h.startHarmonizer();
  const project = (await h.commands.createProject({ name: 'Docs', workspace: '/w/docs' })).value;
  return { h, hq, project };
}

const steward = async (h: BrainHarness, projectId: Id, supervisorId: Id, scenario: string) => {
  const t = (await h.commands.createTask({ projectId, description: scenario })).value;
  const { value } = await h.commands.spawnAgent({
    role: 'steward',
    runtime: 'fake',
    taskId: t.id,
    supervisorId,
    prompt: `scenario:${scenario}`,
  });
  return value.id;
};

describe('common tools', () => {
  it('answer_question: a clarification held by the brain is answered and logged as its own', async () => {
    const { h, hq, project } = await setup();
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once(/asked (\S+) \(held by you\)/, async (t) => {
              const questionId = /asked (\S+) \(held by you\)/.exec(t.prompt)![1]!;
              const out = await t.call('answer_question', { questionId, answer: 'ISO 8601' });
              expect(out).toMatchObject({
                status: 'answered',
                answeredBy: { type: 'agent', id: t.agentId },
              });
              // A second answer is refused with who was first.
              expect(
                await t.try('answer_question', { questionId, answer: 'US', version: 0 }),
              ).toMatchObject({ ok: false });
            })
            .on(/finished/, (t) => t.say('good')),
      },
    );
    await steward(h, project.id, wk.agentId, 'asks');
    await h.until(() => h.log.tables.questions.all().some((q) => q.status === 'answered'));
    await h.done();
    const [q] = h.log.tables.questions.all();
    expect(q).toMatchObject({
      kind: 'clarification',
      answer: 'ISO 8601',
      answeredBy: { type: 'agent', id: wk.agentId },
    });
  });

  it('refuses permission questions, agents outside its reach, and reports to its supervisor', async () => {
    const { h, hq, project } = await setup();
    let stewardId: Id = '';
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            // Its task was added by someone else (here, the test): that wakes it (P2-08 review).
            .on(/was added to your project/, () => {})
            .once('check', async (t) => {
              const [q] = h.log.tables.questions.all();
              expect(q).toMatchObject({ kind: 'permission', holder: { type: 'user' } });
              const refused = await t.try('answer_question', {
                questionId: q!.id,
                answer: 'allow',
              });
              expect(refused).toMatchObject({ ok: false, error: 'invalid' });
              expect(refused.message).toMatch(/permission question/);
              expect(await t.try('stop_agent', { agentId: hq.agentId })).toMatchObject({
                ok: false,
                error: 'invalid',
              });
              expect(await t.try('pause_agent', { agentId: t.agentId })).toMatchObject({
                ok: false,
              });
              const listed =
                await t.call<{ agentId: Id; state: string }[]>('list_supervised_agents');
              expect(listed.map((a) => a.agentId)).toEqual([stewardId]);
              expect(await t.call('get_agent_status', { agentId: stewardId })).toMatchObject({
                role: 'steward',
                state: 'waiting_for_input',
                waitingOn: q!.id,
              });
              expect(await t.call('report_status', { text: 'waiting on a permission' })).toEqual({
                to: hq.agentId,
                messageId: expect.any(String),
              });
              await t.call('stop_agent', { agentId: stewardId });
            }),
      },
    );
    stewardId = await steward(h, project.id, wk.agentId, 'permission');
    await h.until(() => h.log.tables.questions.all().length > 0);
    await h.settle();
    // The permission question never woke the Waykeeper (strict script: no unexpected turn).
    const permissionId = h.log.tables.questions.all()[0]!.id;
    const lines = wk.runner.turns.flatMap((x) => x.items);
    expect(lines.filter((i) => JSON.stringify(i.event).includes(permissionId))).toEqual([]);
    wk.tell('check');
    await h.done();
    expect(h.statuses.get(stewardId)?.state).toBe('stopped');
    const reports = h.log
      .eventsSince(0, Number.MAX_SAFE_INTEGER)
      .map((e) => e.event)
      .filter(
        (e) => e.type === 'message.sent' && e.agentId === hq.agentId && e.sender.type === 'agent',
      );
    expect(reports).toEqual([expect.objectContaining({ text: 'waiting on a permission' })]);
  });

  it('ask_questions opens a set held by the supervisor; answer_question_set answers some and passes the rest up', async () => {
    const h = brainHarness();
    lives.push(h);
    const USER: Actor = { type: 'user' };
    const SET_LINE =
      /asked (\S+) \(question (\d+) of 3 in set (\S+) "Export details", held by you\)/g;
    let setId = '';
    let rows: Id[] = [];
    const hq = await h.startHarmonizer({
      definition: harmonizerBrain({ projectsRoot: '/w/projects' }),
      scriptOptions: { strict: false },
      script: (s) =>
        s.once(/in set qs-/, async (t) => {
          // The Waykeeper's set arrives as three lines with one set id, in the asker's order.
          const lines = [...t.prompt.matchAll(SET_LINE)];
          expect(lines.map((m) => m[2])).toEqual(['1', '2', '3']);
          expect(new Set(lines.map((m) => m[3]))).toEqual(new Set([setId]));
          // A set row is never answered alone.
          const alone = await t.try('answer_question', { questionId: rows[1], answer: ';' });
          expect(alone).toMatchObject({ ok: false, error: 'invalid' });
          expect(alone.message).toMatch(/part of set .* answer_question_set/);
          // It answers what it knows; the two others go up to the user in the same call.
          const out = await t.call('answer_question_set', {
            setId,
            answers: [{ questionId: rows[0], answer: 'UTF-8' }],
          });
          expect(out).toEqual({ answered: [rows[0]], passedUpTo: USER });
          // The rows it passed up are not its own any more.
          expect(
            await t.try('answer_question_set', {
              setId,
              answers: [{ questionId: rows[1], answer: ';' }],
            }),
          ).toMatchObject({ ok: false, error: 'conflict' });
        }),
    });
    const project = (await h.commands.createProject({ name: 'Docs', workspace: '/w/docs' })).value;
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      {
        script: (s) =>
          s
            .once('ask them', async (t) => {
              const out = await t.call<{ setId: Id; questionIds: Id[]; holder: Actor }>(
                'ask_questions',
                {
                  title: 'Export details',
                  questions: [
                    { text: 'Which encoding?' },
                    { text: 'Which delimiter?', options: [',', ';'] },
                    { text: 'Which columns?', options: ['id', 'name', 'date'], multiSelect: true },
                  ],
                },
              );
              expect(out.setId).toMatch(/^qs-/);
              expect(out.questionIds).toHaveLength(3);
              expect(out.holder).toEqual({ type: 'agent', id: hq.agentId });
              setId = out.setId;
              rows = out.questionIds;
              // ask_questions ends the turn.
              expect(await t.try('list_supervised_agents')).toMatchObject({
                ok: false,
                error: 'turn_ended',
              });
            })
            .once(/answered \S+ \(question 1 of 3 in set/, async (t) => {
              expect(t.prompt).toContain(
                `agent ${hq.agentId} answered ${rows[0]} (question 1 of 3 in set ${setId}): "UTF-8"`,
              );
              // Its own row, now held by the user: never escalated alone, never answered by it.
              const up = await t.try('escalate', { questionId: rows[1] });
              expect(up).toMatchObject({ ok: false, error: 'invalid' });
              expect(up.message).toMatch(/answer_question_set/);
              expect(
                await t.try('answer_question_set', {
                  setId,
                  answers: [{ questionId: rows[1], answer: ';' }],
                }),
              ).toMatchObject({ ok: false, error: 'conflict' });
            })
            .once(/question 2 of 3 in set[\s\S]*question 3 of 3 in set/, () => {}),
      },
    );
    wk.tell('ask them');
    await h.until(
      () =>
        rows.length === 3 &&
        rows.slice(1).every((id) => h.log.tables.questions.get(id)?.holder.type === 'user'),
    );
    await h.settle();
    await h.commands.answerQuestionSet({
      setId,
      by: USER,
      answers: [
        { questionId: rows[1]!, answer: { choices: [';'] } },
        { questionId: rows[2]!, answer: { choices: [], skipped: true } },
      ],
    });
    await h.done();
    expect(wk.calls('ask_questions')[0]).toMatchObject({ turnEnded: true });
    const last = wk.runner.turns.at(-1)!;
    expect(last.items.map((i) => i.line)).toEqual([
      `user answered ${rows[1]} (question 2 of 3 in set ${setId}): ";"`,
      `user answered ${rows[2]} (question 3 of 3 in set ${setId}): "(skipped by the user)"`,
    ]);
  });

  it('ask_questions from the Harmonizer goes to the user; one question is refused', async () => {
    const h = brainHarness();
    lives.push(h);
    const hq = await h.startHarmonizer({
      definition: harmonizerBrain({ projectsRoot: '/w/projects' }),
      script: (s) =>
        s.once('ask the user', async (t) => {
          const one = await t.try('ask_questions', {
            title: 'Just one',
            questions: [{ text: 'Only this?' }],
          });
          expect(one).toMatchObject({ ok: false, error: 'invalid' });
          const out = await t.call('ask_questions', {
            title: 'Setup',
            questions: [{ text: 'Which repo?' }, { text: 'Which branch?' }],
          });
          expect(out).toMatchObject({
            holder: { type: 'user' },
            questionIds: [expect.any(String), expect.any(String)],
          });
        }),
    });
    hq.tell('ask the user');
    await h.until(() => h.log.tables.questions.all().length === 2);
    await h.done();
    expect(h.log.tables.questions.all().every((q) => q.holder.type === 'user')).toBe(true);
  });

  it('both prompts say when to ask a set and that a held set is answered with answer_question_set', () => {
    for (const prompt of [HARMONIZER_SYSTEM_PROMPT, WAYKEEPER_SYSTEM_PROMPT]) {
      expect(prompt).toMatch(/ask_questions/);
      expect(prompt).toMatch(/2–10/);
      expect(prompt).toMatch(/answer_question_set/);
      expect(prompt).toMatch(/never re(word|-ask)/i);
    }
    expect(HARMONIZER_SYSTEM_PROMPT).toMatch(/Never re-ask a set with ask_user/);
  });
});
