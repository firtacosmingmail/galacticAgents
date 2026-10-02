import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@galactic/protocol';
import { brainHarness, type BrainHarness } from './testing/index.js';
import { waykeeperDefinition } from './waykeeper/index.js';

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
});
