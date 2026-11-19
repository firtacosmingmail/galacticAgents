import { afterEach, describe, expect, it } from 'vitest';
import {
  GRANT_CONFLICT_OPTIONS,
  type Event,
  type EventOfType,
  type Id,
  type PermissionPolicy,
  type Question,
  type RequestJudgeInput,
  type RequestOrigin,
  type RequestVerdict,
  type SendGrant,
} from '@galactic/protocol';
import { FakeAdapter } from '../../adapters/fake/fake-adapter.js';
import { createFakeRequestJudge } from '../../adapters/fake/fake-request-judge.js';
import { SCENARIOS, type FakeScenario } from '../../adapters/fake/scenario.js';
import { openDatabase } from '../../db/database.js';
import { addSendGrant, liveGrants } from '../../domain/send-grants.js';
import { setWaykeeperApprovals } from '../../domain/waykeeper-approvals.js';
import { composeRuntime, type ComposedRuntime } from '../../runtime/compose.js';
import { userWordsFor } from '../../runtime/user-words.js';
import { renderSeed } from '../seed.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { waykeeperDefinition } from './index.js';
import type { BrainToolContext } from '../definition.js';
import {
  askGrantConflictTool,
  listSendGrantsTool,
  resolveGrantConflictTool,
} from '../grant-conflict-tools.js';
import { HARMONIZER_SYSTEM_PROMPT } from '../harmonizer/index.js';
import { answerSendPermissionTool, localStamp } from '../send-permission-tool.js';
import { wakeLine, type WakeScope } from '../wake.js';
import { WAYKEEPER_SYSTEM_PROMPT } from './index.js';

/**
 * P13-34 (SPEC decision 166): when Cosmin's new words about what may be sent conflict with a grant
 * in force, the decider asks him how to reconcile them; the earlier grant is paused meanwhile, and
 * the decider carries out his answer with `resolve_grant_conflict`.
 */

const USER = { type: 'user' } as const;
const COMMENT = 'gh pr comment 12 -b lgtm';
const POLICY: PermissionPolicy = { rules: { network: 'ask', push: 'ask', run_workspace: 'allow' } };
const WEEK_WORDS = 'send all messages about the launch to the users this week';
const TODAY_WORDS = 'send all messages about the launch to the users but just today';

const SCRIPTS: Record<string, FakeScenario> = {
  ...SCENARIOS,
  send: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: COMMENT },
        permissionAction: 'network',
      },
      { kind: 'finish', result: 'commented' },
    ],
  },
};

/** The judge: the comment sends; covered by the first grant in force once `covers` is set. */
interface JudgeScript {
  seen: RequestJudgeInput[];
  covers: boolean;
}

function judgeOf(script: JudgeScript) {
  return createFakeRequestJudge((input): RequestVerdict => {
    script.seen.push(input);
    const grant = script.covers ? input.grants?.[0] : undefined;
    return {
      verdict: 'approve',
      reason: 'it comments on the PR',
      kind: 'PR comment',
      similarTo: [],
      ...(input.mode !== 'task' ? { sendsOrSpends: true, summary: 'Comment on PR 12' } : {}),
      ...(grant ? { grantId: grant.id } : {}),
    };
  });
}

const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function runtime(script: JudgeScript) {
  const adapter = new FakeAdapter({ speed: 0, scenarios: SCRIPTS });
  const answers: { questionId: string; answer: string }[] = [];
  const answer = adapter.answer.bind(adapter);
  adapter.answer = (questionId, text) => {
    answers.push({ questionId, answer: text });
    return answer(questionId, text);
  };
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter],
    flushMs: 10,
    requestJudge: judgeOf(script),
    standaloneAuto: () => false,
  });
  lives.push(c);
  const events = (): Event[] => c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  const ofType = <T extends Event['type']>(type: T) =>
    events().filter((e): e is EventOfType<T> => e.type === type);
  const answersTo = (questionId: string) => answers.filter((a) => a.questionId === questionId);
  const heldOf = (stewardId: Id) =>
    c.log.tables.questions
      .all()
      .find((q) => q.originAgentId === stewardId && q.context.sendPermission !== undefined);
  const ctxOf = (brainId: Id, projectId?: Id): BrainToolContext => ({
    brainId,
    role: projectId ? 'waykeeper' : 'harmonizer',
    ...(projectId ? { projectId } : {}),
    actor: { type: 'agent', id: brainId },
    commands: c.commands,
    queries: c.queries,
    send: () => {
      throw new Error('not in this test');
    },
  });
  let n = 0;
  const say = (
    agentId: Id,
    text: string,
    opts: { replyTo?: Question; origin?: RequestOrigin } = {},
  ) =>
    c.log.runCommand((ctx) =>
      ctx.emit({
        type: 'message.sent',
        messageId: `m-user-${++n}`,
        agentId,
        sender: USER,
        text,
        interrupt: false,
        origin: opts.origin ?? 'local',
        ...(opts.replyTo
          ? {
              replyTo: {
                kind: 'question' as const,
                id: opts.replyTo.id,
                sender: { type: 'agent' as const, id: opts.replyTo.originAgentId },
                text: opts.replyTo.context.text,
              },
            }
          : {}),
      }),
    );
  return { ...c, events, ofType, answersTo, heldOf, ctxOf, say };
}

type Harness = ReturnType<typeof runtime>;

/** The coming local midnight, as the Waykeeper would write it for "today". */
function midnight(): string {
  const m = new Date();
  m.setHours(24, 0, 0, 0);
  return localStamp(m);
}

/** An Auto project with its Waykeeper and grant A ("this week"), plus the Harmonizer. */
async function setup(opts: { aEndsAt?: string } = {}) {
  const script: JudgeScript = { seen: [], covers: false };
  const c = runtime(script);
  const harmonizerId = (
    await c.commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value.id;
  const project = (
    await c.commands.createProject(
      { name: 'Site', workspace: '/w/site', permissionPolicy: POLICY },
      { origin: 'local' },
    )
  ).value;
  c.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER, true));
  const waykeeper = (
    await c.commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      prompt: 'scenario:echo',
      projectId: project.id,
      supervisorId: harmonizerId,
    })
  ).value;
  const endsAt = opts.aEndsAt ?? new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const grantA = c.log.runCommand((ctx) =>
    addSendGrant(
      ctx,
      {
        projectId: project.id,
        words: WEEK_WORDS,
        summary: 'Launch messages, this week',
        endsAt,
        createdBy: USER,
        origin: 'local',
        questionId: 'q-earlier',
      },
      Date.now(),
    ),
  ).value;
  const tool = (
    t: typeof askGrantConflictTool,
    input: Record<string, unknown>,
    brainId = waykeeper.id,
  ) => t.handler(input, brainId === waykeeper.id ? c.ctxOf(brainId, project.id) : c.ctxOf(brainId));
  const ask = (input: Record<string, unknown>, brainId?: Id) =>
    tool(askGrantConflictTool, input, brainId) as Promise<{ questionId: Id }>;
  const resolve = (input: Record<string, unknown>, brainId?: Id) =>
    tool(resolveGrantConflictTool, input, brainId);
  const grantOf = (id: Id): SendGrant | undefined =>
    c.log.tables.projects.get(project.id)?.sendGrants?.find((g) => g.id === id);
  return { c, script, harmonizerId, project, waykeeper, grantA, ask, resolve, grantOf };
}

/** A Steward of the project whose comment is held behind a send-permission question. */
async function heldSteward(c: Harness, projectId: Id, supervisorId: Id) {
  const task = (await c.commands.createTask({ description: 'comment on PR 12', projectId })).value;
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:send',
      taskId: task.id,
      supervisorId,
    })
  ).value;
  await until(() => c.heldOf(steward.id) !== undefined);
  return { steward, question: c.heldOf(steward.id)! };
}

const finished = (c: Harness, agentId: Id) =>
  c.ofType('agent.finished').some((e) => e.agentId === agentId);

/** Grant A in force, a held send whose card Cosmin answered with narrower words; asked. */
async function conflictViaCard() {
  const s = await setup();
  const held = await heldSteward(s.c, s.project.id, s.waykeeper.id);
  s.c.say(s.waykeeper.id, `yes, ${TODAY_WORDS}`, { replyTo: held.question });
  const { questionId } = await s.ask({
    grantIds: [s.grantA.id],
    newWords: TODAY_WORDS,
    sendQuestionId: held.question.id,
    options: ['Keep the weekly grant but skip today'],
  });
  return { ...s, held, questionId };
}

describe('ask_grant_conflict (P13-34)', () => {
  it('a conflicting card answer opens the question with the fixed options first and pauses A', async () => {
    const { c, grantA, questionId, held, waykeeper, project, grantOf } = await conflictViaCard();
    const q = c.log.tables.questions.get(questionId)!;
    expect(q).toMatchObject({ kind: 'permission', status: 'open', holder: USER });
    expect(q.originAgentId).toBe(waykeeper.id);
    expect(q.context.options).toEqual([
      ...GRANT_CONFLICT_OPTIONS,
      'Keep the weekly grant but skip today',
    ]);
    expect(q.context.text).toBe(
      `Earlier you said: "${WEEK_WORDS}" (until ${grantA.endsAt}). Now you said: ` +
        `"${TODAY_WORDS}". These conflict. What should I do?`,
    );
    expect(q.context.grantConflict).toMatchObject({
      deciderId: waykeeper.id,
      projectId: project.id,
      grants: [{ id: grantA.id, words: WEEK_WORDS, endsAt: grantA.endsAt }],
      newWords: TODAY_WORDS,
      sendQuestionId: held.question.id,
    });
    expect(grantOf(grantA.id)!.pausedBy).toBe(questionId);
    expect(c.ofType('send_grant.paused')).toEqual([
      expect.objectContaining({ grantId: grantA.id, projectId: project.id, questionId }),
    ]);
    expect(liveGrants(c.log.tables, { projectId: project.id }, Date.now())).toEqual([]);
    // The send card is not answered meanwhile.
    expect(c.log.tables.questions.get(held.question.id)!.status).toBe('open');
  });

  it('while A is paused, a new send A would cover is held, not approved', async () => {
    const { c, script, project, waykeeper } = await conflictViaCard();
    script.covers = true;
    const second = await heldSteward(c, project.id, waykeeper.id);
    expect(second.question.context.sendPermission!.grants).toEqual([]);
    expect(script.seen.at(-1)!.grants).toEqual([]);
    expect(c.log.tables.questions.get(second.question.id)!.status).toBe('open');
    expect(c.answersTo(second.question.id)).toEqual([]);
  });

  it('a chat line (no card) opens the same question, without sendQuestionId', async () => {
    const { c, waykeeper, grantA, ask, grantOf } = await setup();
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    const { questionId } = await ask({ grantIds: [grantA.id], newWords: TODAY_WORDS });
    const q = c.log.tables.questions.get(questionId)!;
    expect(q.context.grantConflict!.sendQuestionId).toBeUndefined();
    expect(q.context.options).toEqual([...GRANT_CONFLICT_OPTIONS]);
    expect(grantOf(grantA.id)!.pausedBy).toBe(questionId);
  });

  it('the decider sees the grants, paused ones marked', async () => {
    const { c, waykeeper, project, grantA, questionId } = await conflictViaCard();
    const out = (await listSendGrantsTool.handler({}, c.ctxOf(waykeeper.id, project.id))) as {
      grants: unknown[];
    };
    expect(out.grants).toEqual([
      expect.objectContaining({ id: grantA.id, words: WEEK_WORDS, pausedBy: questionId }),
    ]);
  });

  it('refuses words that are not his, a grant of another scope or ended, one already paused', async () => {
    const { c, waykeeper, harmonizerId, grantA, ask, project } = await setup();
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    await expect(
      ask({ grantIds: [grantA.id], newWords: 'send nothing about the launch at all' }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('exact words') });
    // The Harmonizer decides standalone work: the project's grant is not in its scope.
    await expect(
      ask({ grantIds: [grantA.id], newWords: TODAY_WORDS }, harmonizerId),
    ).rejects.toMatchObject({ code: 'not_found' });
    // An ended grant is not in force.
    const p = c.log.tables.projects.get(project.id)!;
    const ended = { ...grantA, id: 'sg-ended', endsAt: '2020-01-01T00:00:00.000Z' };
    c.log.tables.projects.upsert({ ...p, sendGrants: [...p.sendGrants!, ended] });
    await expect(ask({ grantIds: ['sg-ended'], newWords: TODAY_WORDS })).rejects.toMatchObject({
      code: 'invalid',
    });
    await ask({ grantIds: [grantA.id], newWords: TODAY_WORDS });
    await expect(ask({ grantIds: [grantA.id], newWords: TODAY_WORDS })).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(
      c.ofType('question.opened').filter((e) => e.question.context.grantConflict),
    ).toHaveLength(1);
  });

  it('refuses more than 3 options of its own', async () => {
    const { c, waykeeper, grantA, ask } = await setup();
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    await expect(
      ask({ grantIds: [grantA.id], newWords: TODAY_WORDS, options: ['a', 'b', 'c', 'd'] }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('answer_send_permission waits for the conflict question', async () => {
    const { c, waykeeper, project, held } = await conflictViaCard();
    await expect(
      answerSendPermissionTool.handler(
        { questionId: held.question.id, decision: 'allow' },
        c.ctxOf(waykeeper.id, project.id),
      ),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('resolve_grant_conflict'),
    });
    expect(c.answersTo(held.question.id)).toEqual([]);
  });

  it('his new words and his answer are never task words', async () => {
    const { c, held, questionId, waykeeper } = await conflictViaCard();
    c.say(waykeeper.id, `and also ${TODAY_WORDS} please`);
    await c.commands.answerQuestion({
      questionId,
      answer: 'send the launch notes only today',
      by: USER,
    });
    const words = userWordsFor(c.log, c.log.tables.agents.get(held.steward.id)!.taskId!);
    expect(words.some((w) => w.includes('only today') || w.includes('just today'))).toBe(false);
  });
});

describe('resolve_grant_conflict (P13-34)', () => {
  it('Replace: A ends by the decider quoting his answer, the new grant is made, the card is answered', async () => {
    const { c, script, waykeeper, project, grantA, questionId, held, resolve, grantOf } =
      await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[0], by: USER });
    script.covers = true;
    const endsAt = midnight();
    const out = (await resolve({
      questionId,
      endGrantIds: [grantA.id],
      newGrant: { words: TODAY_WORDS, summary: 'Launch messages, today', endsAt },
    })) as { ended: Id[]; grant: { id: Id } };
    expect(out.ended).toEqual([grantA.id]);
    expect(grantOf(grantA.id)).toBeUndefined();
    expect(c.ofType('send_grant.removed')).toEqual([
      expect.objectContaining({
        grantId: grantA.id,
        by: { type: 'agent', id: waykeeper.id },
        reason: expect.stringContaining(GRANT_CONFLICT_OPTIONS[0]),
      }),
    ]);
    const added = c.ofType('send_grant.added').at(-1)!.grant;
    expect(added).toMatchObject({
      id: out.grant.id,
      projectId: project.id,
      words: TODAY_WORDS,
      endsAt: new Date(endsAt).toISOString(),
      createdBy: USER,
      questionId,
    });
    await until(() => finished(c, held.steward.id));
    expect(c.answersTo(held.question.id)).toEqual([
      { questionId: held.question.id, answer: 'allow' },
    ]);
    expect(
      c.ofType('permission.decided').find((e) => e.questionId === held.question.id),
    ).toMatchObject({ allowedBy: 'grant', grantId: added.id });
    // Twice: refused.
    await expect(resolve({ questionId, endGrantIds: [] })).rejects.toMatchObject({ code: 'stale' });
  });

  it('Keep the earlier grant: A counts again, no new grant, held sends it covers go out', async () => {
    const { c, script, grantA, questionId, held, resolve, grantOf } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[1], by: USER });
    script.covers = true;
    const before = c.ofType('send_grant.added').length;
    await resolve({ questionId, endGrantIds: [] });
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
    expect(c.ofType('send_grant.unpaused')).toEqual([
      expect.objectContaining({ grantId: grantA.id, questionId }),
    ]);
    expect(c.ofType('send_grant.added')).toHaveLength(before);
    await until(() => finished(c, held.steward.id));
    expect(
      c.ofType('permission.decided').find((e) => e.questionId === held.question.id),
    ).toMatchObject({ allowedBy: 'grant', grantId: grantA.id });
  });

  it('Keep both: A counts again and the new grant is made', async () => {
    const { c, grantA, questionId, resolve, grantOf, project } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[2], by: USER });
    await resolve({
      questionId,
      endGrantIds: [],
      newGrant: { words: TODAY_WORDS, summary: 'Launch messages, today', endsAt: midnight() },
    });
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
    expect(c.log.tables.projects.get(project.id)!.sendGrants).toHaveLength(2);
  });

  it('a free-text answer can be the new grant’s words', async () => {
    const { c, questionId, resolve, grantA } = await conflictViaCard();
    await c.commands.answerQuestion({
      questionId,
      answer: 'keep the week but only for the launch newsletter',
      by: USER,
    });
    await resolve({
      questionId,
      endGrantIds: [grantA.id],
      newGrant: { words: 'only for the launch newsletter', summary: 'Launch newsletter' },
    });
    expect(c.ofType('send_grant.added').at(-1)!.grant.words).toBe('only for the launch newsletter');
  });

  it('refuses: before he answered, another decider, a grant not in it, words not his', async () => {
    const { c, harmonizerId, questionId, resolve, grantA } = await conflictViaCard();
    await expect(resolve({ questionId, endGrantIds: [grantA.id] })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('has not answered'),
    });
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[0], by: USER });
    await expect(
      resolve({ questionId, endGrantIds: [grantA.id] }, harmonizerId),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(resolve({ questionId, endGrantIds: ['sg-other'] })).rejects.toMatchObject({
      code: 'invalid',
    });
    // A picked option is not his words for a grant.
    await expect(
      resolve({
        questionId,
        endGrantIds: [grantA.id],
        newGrant: { words: GRANT_CONFLICT_OPTIONS[0], summary: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      resolve({
        questionId,
        endGrantIds: [grantA.id],
        newGrant: { words: 'send everything to everyone forever', summary: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // Nothing changed.
    expect(c.ofType('send_grant.removed')).toEqual([]);
  });

  it('a decider never removes a grant directly', async () => {
    const { c, waykeeper, grantA } = await setup();
    await expect(
      c.commands.removeSendGrant({ grantId: grantA.id, by: { type: 'agent', id: waykeeper.id } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a paused A that expired meanwhile stays expired after Keep', async () => {
    const { c, waykeeper, grantA, ask, resolve, project } = await setup({
      aEndsAt: new Date(Date.now() + 400).toISOString(),
    });
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    const { questionId } = await ask({ grantIds: [grantA.id], newWords: TODAY_WORDS });
    await until(() => Date.now() > Date.parse(grantA.endsAt!) + 5);
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[1], by: USER });
    await resolve({ questionId, endGrantIds: [] });
    expect(liveGrants(c.log.tables, { projectId: project.id }, Date.now())).toEqual([]);
  });
});

describe('a grant-conflict question closed without an answer (P13-34)', () => {
  it('dismissed: A counts again', async () => {
    const { c, grantA, questionId, grantOf } = await conflictViaCard();
    await c.commands.dismissQuestion({ questionId, by: USER });
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
    expect(c.ofType('send_grant.unpaused')).toEqual([
      expect.objectContaining({ grantId: grantA.id, questionId }),
    ]);
  });

  it('its decider stopped: A counts again', async () => {
    const { c, waykeeper, grantA, questionId, grantOf } = await conflictViaCard();
    await c.commands.stopAgent(waykeeper.id, USER);
    await until(() => c.log.tables.questions.get(questionId)!.status !== 'open');
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
  });

  it('its project failed: its grants end and the question is withdrawn', async () => {
    const { c, project, questionId } = await conflictViaCard();
    await c.commands.setProjectState(project.id, 'failed');
    expect(c.log.tables.projects.get(project.id)!.sendGrants ?? []).toEqual([]);
    expect(c.log.tables.questions.get(questionId)!.status).toBe('cancelled');
  });
});

describe('the decider is woken and told (P13-34)', () => {
  const scopeOf = (c: Harness, brainId: Id): WakeScope => ({
    brainId,
    role: 'waykeeper',
    supervises: () => false,
    runsTask: () => false,
    runsProject: () => false,
    ownsProposal: () => false,
    question: (id) => c.log.tables.questions.get(id),
  });

  it('his answer wakes it with resolve_grant_conflict; a close says the grants count again', async () => {
    const { c, waykeeper, harmonizerId, questionId } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[0], by: USER });
    const answered = c.ofType('question.answered').find((e) => e.questionId === questionId)!;
    expect(wakeLine(answered, scopeOf(c, waykeeper.id))).toContain('resolve_grant_conflict');
    expect(wakeLine(answered, scopeOf(c, harmonizerId))).toBeUndefined();
  });

  it('a dismissal wakes it too', async () => {
    const { c, waykeeper, questionId } = await conflictViaCard();
    await c.commands.dismissQuestion({ questionId, by: USER });
    const closed = c.ofType('question.cancelled').find((e) => e.questionId === questionId)!;
    expect(wakeLine(closed, scopeOf(c, waykeeper.id))).toContain('count again');
  });
});

describe('the prompts (P13-34)', () => {
  it.each([
    ['Waykeeper', WAYKEEPER_SYSTEM_PROMPT],
    ['Harmonizer', HARMONIZER_SYSTEM_PROMPT],
  ])('the %s compares with the grants in force and asks on a conflict', (_name, prompt) => {
    expect(prompt).toContain('list_send_grants');
    expect(prompt).toContain('ask_grant_conflict');
    expect(prompt).toContain('resolve_grant_conflict');
    expect(prompt).toContain('Never end, narrow or replace a grant on your own');
  });
});

describe('a picked option decides the outcome in code (P13-34 fix round 1, Critical 1)', () => {
  const [REPLACE, KEEP_EARLIER, KEEP_BOTH] = GRANT_CONFLICT_OPTIONS;
  const today = { words: TODAY_WORDS, summary: 'Launch messages, today' };

  it('Replace: refused without ending every earlier grant or without the new grant', async () => {
    const { c, grantA, questionId, resolve, grantOf } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: REPLACE, by: USER });
    await expect(resolve({ questionId, endGrantIds: [], newGrant: today })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('end every earlier grant'),
    });
    await expect(resolve({ questionId, endGrantIds: [grantA.id] })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(grantOf(grantA.id)!.pausedBy).toBe(questionId);
  });

  it('Keep the earlier: refused when it ends a grant or makes one', async () => {
    const { c, grantA, questionId, resolve, grantOf } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: KEEP_EARLIER, by: USER });
    await expect(resolve({ questionId, endGrantIds: [grantA.id] })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(resolve({ questionId, endGrantIds: [], newGrant: today })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('make no new grant'),
    });
    expect(grantOf(grantA.id)!.pausedBy).toBe(questionId);
    expect(c.ofType('send_grant.removed')).toEqual([]);
  });

  it('Keep both: refused when it ends a grant or makes none', async () => {
    const { c, grantA, questionId, resolve } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: KEEP_BOTH, by: USER });
    await expect(
      resolve({ questionId, endGrantIds: [grantA.id], newGrant: today }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(resolve({ questionId, endGrantIds: [] })).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it("the decider's own option leaves the outcome to its judgement under the usual checks", async () => {
    const { c, grantA, questionId, resolve, grantOf } = await conflictViaCard();
    await c.commands.answerQuestion({
      questionId,
      answer: 'Keep the weekly grant but skip today',
      by: USER,
    });
    await resolve({ questionId, endGrantIds: [] });
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
  });
});

describe('the send card after the conflict (P13-34 fix round 1, Important 1)', () => {
  it('after "Keep the earlier, ignore the new words" his old reply never allows the card', async () => {
    const { c, waykeeper, project, questionId, held, resolve } = await conflictViaCard();
    await c.commands.answerQuestion({
      questionId,
      answer: GRANT_CONFLICT_OPTIONS[1],
      by: USER,
    });
    const out = (await resolve({ questionId, endGrantIds: [] })) as { sendQuestion?: string };
    expect(out.sendQuestion).toContain('no longer counts');
    const answer = (input: Record<string, unknown>) =>
      answerSendPermissionTool.handler(input, c.ctxOf(waykeeper.id, project.id));
    await expect(
      answer({
        questionId: held.question.id,
        decision: 'allow',
        grant: { words: TODAY_WORDS, summary: 'Launch messages, today', endsAt: midnight() },
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('new reply') });
    await expect(answer({ questionId: held.question.id, decision: 'allow' })).rejects.toMatchObject(
      {
        code: 'invalid',
      },
    );
    expect(c.ofType('send_grant.added')).toHaveLength(1); // A only
    expect(c.answersTo(held.question.id)).toEqual([]);
    // A new reply of his counts.
    c.say(waykeeper.id, 'fine, send this one comment', { replyTo: held.question });
    await answer({ questionId: held.question.id, decision: 'allow' });
    expect(c.answersTo(held.question.id)).toEqual([
      { questionId: held.question.id, answer: 'allow' },
    ]);
  });
});

describe('an answered conflict is not stranded (P13-34 fix round 1, Important 2)', () => {
  it("the project's current Waykeeper carries it out, not only the one that asked", async () => {
    const { c, harmonizerId, project, waykeeper, grantA, questionId, resolve, grantOf } =
      await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[1], by: USER });
    await c.commands.stopAgent(waykeeper.id, USER);
    expect(c.log.tables.questions.get(questionId)!.status).toBe('answered');
    expect(grantOf(grantA.id)!.pausedBy).toBe(questionId);
    const next = (
      await c.commands.spawnAgent({
        role: 'waykeeper',
        runtime: 'fake',
        prompt: 'scenario:echo',
        projectId: project.id,
        supervisorId: harmonizerId,
      })
    ).value;
    await resolveGrantConflictTool.handler(
      { questionId, endGrantIds: [] },
      c.ctxOf(next.id, project.id),
    );
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
    // The Harmonizer decides standalone work, not this project's.
    await expect(resolve({ questionId, endGrantIds: [] }, harmonizerId)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('the seed lists an answered conflict until it is carried out', async () => {
    const { c, waykeeper, project, questionId, resolve } = await conflictViaCard();
    const seed = () => renderSeed(c.queries, { brainId: waykeeper.id, projectId: project.id });
    expect(seed()).not.toContain(questionId);
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[2], by: USER });
    expect(seed()).toContain(`- ${questionId}: Cosmin answered "Keep both"`);
    await resolve({
      questionId,
      endGrantIds: [],
      newGrant: { words: TODAY_WORDS, summary: 'Launch messages, today' },
    });
    expect(seed()).not.toContain(questionId);
  });

  it('Resume grant: user-only, unpauses and closes the question when nothing is left paused', async () => {
    const { c, waykeeper, project, grantA, questionId, grantOf } = await conflictViaCard();
    await expect(
      c.commands.resumeSendGrant({ grantId: grantA.id, by: { type: 'agent', id: waykeeper.id } }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await c.commands.resumeSendGrant({
      grantId: grantA.id,
      scope: { projectId: project.id },
      by: USER,
    });
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
    expect(c.ofType('send_grant.unpaused').at(-1)).toMatchObject({
      grantId: grantA.id,
      reason: 'resumed by the user',
    });
    expect(c.log.tables.questions.get(questionId)!.status).toBe('cancelled');
    await expect(
      c.commands.resumeSendGrant({ grantId: grantA.id, by: USER }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('Resume grant on an answered conflict marks it resolved by the user', async () => {
    const { c, grantA, questionId, resolve } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[0], by: USER });
    await c.commands.resumeSendGrant({ grantId: grantA.id, by: USER });
    expect(c.log.tables.questions.get(questionId)!.meta).toMatchObject({
      grantConflictResolvedBy: 'user',
    });
    await expect(resolve({ questionId, endGrantIds: [grantA.id] })).rejects.toMatchObject({
      code: 'stale',
    });
  });

  it('a re-ask cannot take grants from an answered question (fix round 2, N4)', async () => {
    const { c, waykeeper, project, grantA, ask, grantOf } = await setup();
    const grantB = c.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          projectId: project.id,
          words: 'post the launch photos on Instagram',
          summary: 'Launch photos',
          createdBy: USER,
          origin: 'local',
          questionId: 'q-earlier-2',
        },
        Date.now(),
      ),
    ).value;
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    const first = await ask({ grantIds: [grantA.id, grantB.id], newWords: TODAY_WORDS });
    await c.commands.answerQuestion({
      questionId: first.questionId,
      answer: GRANT_CONFLICT_OPTIONS[0],
      by: USER,
    });
    c.say(waykeeper.id, `again: ${TODAY_WORDS}`);
    await expect(ask({ grantIds: [grantA.id], newWords: TODAY_WORDS })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('resolve_grant_conflict first'),
    });
    expect(grantOf(grantA.id)!.pausedBy).toBe(first.questionId);
    expect(grantOf(grantB.id)!.pausedBy).toBe(first.questionId);
    expect(c.ofType('send_grant.unpaused')).toEqual([]);
  });
});

describe('the decider is reminded once after a turn without resolving (P13-34 fix round 1)', () => {
  const harnesses: BrainHarness[] = [];
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.dispose();
  });

  it('an answered, unresolved conflict wakes the Waykeeper once more, and the seed lists it', async () => {
    const h = brainHarness({ adapter: { scenarios: SCRIPTS } });
    harnesses.push(h);
    const hq = await h.startHarmonizer();
    const project = (
      await h.commands.createProject(
        { name: 'Site', workspace: '/w/site', permissionPolicy: POLICY },
        { origin: 'local' },
      )
    ).value;
    h.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER, true));
    const wk = await h.startBrain(
      waykeeperDefinition(),
      { runtime: 'fake', projectId: project.id, supervisorId: hq.agentId },
      { scriptOptions: { strict: false } },
    );
    const grantA = h.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          projectId: project.id,
          words: WEEK_WORDS,
          summary: 'Launch messages, this week',
          createdBy: USER,
          origin: 'local',
          questionId: 'q-earlier',
        },
        Date.now(),
      ),
    ).value;
    h.log.runCommand((ctx) =>
      ctx.emit({
        type: 'message.sent',
        messageId: 'm-user-x',
        agentId: wk.agentId,
        sender: USER,
        text: `actually ${TODAY_WORDS}`,
        interrupt: false,
        origin: 'local',
      }),
    );
    await h.settle();
    const ctx: BrainToolContext = {
      brainId: wk.agentId,
      role: 'waykeeper',
      projectId: project.id,
      actor: { type: 'agent', id: wk.agentId },
      commands: h.commands,
      queries: h.queries,
      send: () => {
        throw new Error('not in this test');
      },
    };
    const { questionId } = (await askGrantConflictTool.handler(
      { grantIds: [grantA.id], newWords: TODAY_WORDS },
      ctx,
    )) as { questionId: Id };
    await h.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[1], by: USER });
    await h.settle();
    const prompts = wk.prompts().join('\n');
    expect(prompts.split('is not carried out yet').length - 1).toBe(1);
    expect(prompts).toContain('Grant-conflict answers to carry out');
  });
});

describe('fix round 2 (P13-34)', () => {
  const grantBOf = (c: Harness, projectId: Id) =>
    c.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          projectId,
          words: 'post the launch photos on Instagram',
          summary: 'Launch photos',
          createdBy: USER,
          origin: 'local',
          questionId: 'q-earlier-2',
        },
        Date.now(),
      ),
    ).value;

  it('N1: words from a card reply bind the card even when the decider leaves it out', async () => {
    const { c, waykeeper, project, grantA, ask, resolve } = await setup();
    const held = await heldSteward(c, project.id, waykeeper.id);
    c.say(waykeeper.id, `yes, ${TODAY_WORDS}`, { replyTo: held.question });
    const { questionId } = await ask({ grantIds: [grantA.id], newWords: TODAY_WORDS });
    expect(c.log.tables.questions.get(questionId)!.context.grantConflict!.sendQuestionId).toBe(
      held.question.id,
    );
    const answer = (input: Record<string, unknown>) =>
      answerSendPermissionTool.handler(input, c.ctxOf(waykeeper.id, project.id));
    const allowWithGrant = {
      questionId: held.question.id,
      decision: 'allow',
      grant: { words: TODAY_WORDS, summary: 'Launch messages, today' },
    };
    await expect(answer(allowWithGrant)).rejects.toMatchObject({ code: 'invalid' });
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[1], by: USER });
    await resolve({ questionId, endGrantIds: [] });
    await expect(answer(allowWithGrant)).rejects.toMatchObject({ code: 'invalid' });
    await expect(answer({ questionId: held.question.id, decision: 'allow' })).rejects.toMatchObject(
      {
        code: 'invalid',
      },
    );
    expect(c.answersTo(held.question.id)).toEqual([]);
  });

  it('N1: a plain line taken as the card answer binds the card too', async () => {
    const { c, waykeeper, project, grantA, ask } = await setup();
    const held = await heldSteward(c, project.id, waykeeper.id);
    c.say(waykeeper.id, `ok so ${TODAY_WORDS}`);
    const { questionId } = await ask({ grantIds: [grantA.id], newWords: TODAY_WORDS });
    expect(c.log.tables.questions.get(questionId)!.context.grantConflict!.sendQuestionId).toBe(
      held.question.id,
    );
  });

  it('N1: the words of a pending chat-line conflict never allow a card answered with them', async () => {
    const { c, waykeeper, project, grantA, ask } = await setup();
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    const { questionId } = await ask({ grantIds: [grantA.id], newWords: TODAY_WORDS });
    expect(
      c.log.tables.questions.get(questionId)!.context.grantConflict!.sendQuestionId,
    ).toBeUndefined();
    const held = await heldSteward(c, project.id, waykeeper.id);
    c.say(waykeeper.id, `yes, ${TODAY_WORDS}`, { replyTo: held.question });
    await expect(
      answerSendPermissionTool.handler(
        {
          questionId: held.question.id,
          decision: 'allow',
          grant: { words: TODAY_WORDS, summary: 'Launch messages, today' },
        },
        c.ctxOf(waykeeper.id, project.id),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(c.answersTo(held.question.id)).toEqual([]);
  });

  it('N2: a grant he resumed drops out of the question; resolve carries out the rest', async () => {
    const { c, waykeeper, project, grantA, ask, resolve, grantOf } = await setup();
    const grantB = grantBOf(c, project.id);
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    const { questionId } = await ask({ grantIds: [grantA.id, grantB.id], newWords: TODAY_WORDS });
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[0], by: USER });
    await c.commands.resumeSendGrant({ grantId: grantA.id, by: USER });
    // Replace ends only what the question still pauses: B.
    await resolve({
      questionId,
      endGrantIds: [grantB.id],
      newGrant: { words: TODAY_WORDS, summary: 'Launch messages, today' },
    });
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
    expect(grantOf(grantB.id)).toBeUndefined();
    expect(renderSeed(c.queries, { brainId: waykeeper.id, projectId: project.id })).not.toContain(
      questionId,
    );
  });

  it('N2: resuming every grant of an answered question takes it out of the seed', async () => {
    const { c, waykeeper, project, grantA, questionId } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[0], by: USER });
    await c.commands.resumeSendGrant({ grantId: grantA.id, by: USER });
    expect(renderSeed(c.queries, { brainId: waykeeper.id, projectId: project.id })).not.toContain(
      questionId,
    );
  });

  it('N3: a look-alike of a fixed option is refused', async () => {
    const { c, waykeeper, grantA, ask } = await setup();
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    for (const lookalike of [
      'Replace the earlier grant with the new one.',
      '  keep BOTH!  ',
      'keep the earlier grant and ignore the new words…',
    ]) {
      await expect(
        ask({ grantIds: [grantA.id], newWords: TODAY_WORDS, options: [lookalike] }),
      ).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('offered already'),
      });
    }
  });
});

describe('fix round 3 (P13-34)', () => {
  it('Replace needs his new words in full: a quote dropping "but just today" is refused', async () => {
    const { c, grantA, questionId, resolve, grantOf } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[0], by: USER });
    await expect(
      resolve({
        questionId,
        endGrantIds: [grantA.id],
        newGrant: {
          words: 'send all messages about the launch to the users',
          summary: 'Launch messages',
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('in full') });
    expect(grantOf(grantA.id)!.pausedBy).toBe(questionId);
    await resolve({
      questionId,
      endGrantIds: [grantA.id],
      newGrant: { words: TODAY_WORDS, summary: 'Launch messages, today', endsAt: midnight() },
    });
    expect(c.ofType('send_grant.added').at(-1)!.grant.words).toBe(TODAY_WORDS);
  });

  it('Keep both needs his new words in full too', async () => {
    const { c, questionId, resolve } = await conflictViaCard();
    await c.commands.answerQuestion({ questionId, answer: GRANT_CONFLICT_OPTIONS[2], by: USER });
    await expect(
      resolve({
        questionId,
        endGrantIds: [],
        newGrant: { words: 'messages about the launch to the users', summary: 'x' },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('fix round 4 (P13-34)', () => {
  it('M2: a typed answer that is a fixed option, give or take case, quotes and punctuation, is enforced as it', async () => {
    const { c, grantA, questionId, resolve, grantOf } = await conflictViaCard();
    await c.commands.answerQuestion({
      questionId,
      answer: '  “keep the EARLIER grant and ignore the new words.”  ',
      by: USER,
    });
    await expect(resolve({ questionId, endGrantIds: [grantA.id] })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('end no grant'),
    });
    await expect(
      resolve({
        questionId,
        endGrantIds: [],
        newGrant: { words: TODAY_WORDS, summary: 'Launch messages, today' },
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('make no new grant'),
    });
    await resolve({ questionId, endGrantIds: [] });
    expect(grantOf(grantA.id)!.pausedBy).toBeUndefined();
  });

  it('M5: a decider option that is a fixed one in quotation marks is refused', async () => {
    const { c, waykeeper, grantA, ask } = await setup();
    c.say(waykeeper.id, `actually ${TODAY_WORDS}`);
    for (const lookalike of [
      '"Keep both"',
      "'Replace the earlier grant with the new one'",
      '“Keep the earlier grant and ignore the new words.”',
      '‘keep both’!',
    ]) {
      await expect(
        ask({ grantIds: [grantA.id], newWords: TODAY_WORDS, options: [lookalike] }),
      ).rejects.toMatchObject({
        code: 'invalid',
        message: expect.stringContaining('offered already'),
      });
    }
  });
});
