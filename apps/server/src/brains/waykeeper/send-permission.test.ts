import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  Event,
  EventOfType,
  Id,
  PermissionPolicy,
  Question,
  RequestJudgeInput,
  RequestOrigin,
  RequestVerdict,
} from '@galactic/protocol';
import { FakeAdapter } from '../../adapters/fake/fake-adapter.js';
import { createFakeRequestJudge } from '../../adapters/fake/fake-request-judge.js';
import { SCENARIOS, type FakeScenario } from '../../adapters/fake/scenario.js';
import { openDatabase } from '../../db/database.js';
import { setWaykeeperApprovals } from '../../domain/waykeeper-approvals.js';
import { composeRuntime, type ComposedRuntime } from '../../runtime/compose.js';
import type { BrainToolContext } from '../definition.js';
import { brainHarness, type BrainHarness } from '../testing/index.js';
import { harmonizerBrain, HARMONIZER_SYSTEM_PROMPT } from '../harmonizer/index.js';
import { answerSendPermissionTool, localStamp } from '../send-permission-tool.js';
import { WAKE_RULES, wakeLine, type WakeScope } from '../wake.js';
import { waykeeperDefinition, WAYKEEPER_SYSTEM_PROMPT } from './index.js';

/**
 * P13-28 (design 2026-11-18 §4.4 step 4): the decider of a held send — the project's Waykeeper,
 * or the Harmonizer for standalone work — turns Cosmin's reply into an answer with
 * `answer_send_permission`. The server checks the reply is there and the grant's words are his.
 */

const USER = { type: 'user' } as const;
const COMMENT = 'gh pr comment 12 -b lgtm';
const POLICY: PermissionPolicy = { rules: { network: 'ask', push: 'ask', run_workspace: 'allow' } };

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

/** The judge: the comment sends; covered by the first live grant once `covers` is set. */
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
const dirs: string[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function runtime(script: JudgeScript, standalone: { auto: boolean }) {
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
    standaloneAuto: () => standalone.auto,
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
  /** The brain's tool context, as the runner builds it. */
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
  /** The user writes to `agentId`, replying to `question` when given. */
  let n = 0;
  const say = (
    agentId: Id,
    text: string,
    opts: { replyTo?: Question; origin?: RequestOrigin; at?: string } = {},
  ) =>
    c.log.runCommand(
      (ctx) =>
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
      opts.at ? { at: opts.at } : {},
    );
  return { ...c, events, ofType, answersTo, heldOf, ctxOf, say };
}

type Harness = ReturnType<typeof runtime>;

async function harmonizerOf(c: Harness): Promise<Id> {
  return (
    await c.commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value.id;
}

/** An Auto project with its Waykeeper (an echoing stand-in: the tool is called directly). */
async function autoProject(c: Harness, harmonizerId: Id, name = 'Site') {
  const project = (
    await c.commands.createProject(
      { name, workspace: `/w/${name.toLowerCase()}`, permissionPolicy: POLICY },
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
  return { project, waykeeper };
}

/** A Steward of the project whose comment is held behind a send-permission question. */
async function heldSteward(c: Harness, projectId: Id | undefined, supervisorId: Id) {
  const task = (
    await c.commands.createTask({
      description: 'comment on PR 12',
      ...(projectId ? { projectId } : {}),
    })
  ).value;
  let cwd: string | undefined;
  if (!projectId) {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-send-permission-')));
    dirs.push(cwd);
  }
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:send',
      taskId: task.id,
      supervisorId,
      ...(cwd ? { cwd } : {}),
    })
  ).value;
  await until(() => c.heldOf(steward.id) !== undefined);
  return { steward, question: c.heldOf(steward.id)! };
}

async function projectHeld() {
  const script: JudgeScript = { seen: [], covers: false };
  const c = runtime(script, { auto: false });
  const harmonizerId = await harmonizerOf(c);
  const { project, waykeeper } = await autoProject(c, harmonizerId);
  const { steward, question } = await heldSteward(c, project.id, waykeeper.id);
  expect(question.context.sendPermission?.deciderId).toBe(waykeeper.id);
  const answer = (input: Record<string, unknown>, brainId = waykeeper.id, projectId = project.id) =>
    answerSendPermissionTool.handler(input, c.ctxOf(brainId, projectId));
  return { c, script, harmonizerId, project, waykeeper, steward, question, answer };
}

const decisionsOf = (c: Harness, agentId: Id) =>
  c.ofType('permission.decided').filter((e) => e.agentId === agentId);

/** The coming local midnight, as the Waykeeper would write it for "today". */
function midnight(): string {
  const m = new Date();
  m.setHours(24, 0, 0, 0);
  return localStamp(m);
}

describe('answer_send_permission: the server checks (P13-28)', () => {
  it('refuses an allow before Cosmin replied: nothing changes', async () => {
    const { c, waykeeper, steward, question, answer } = await projectHeld();
    // A chat line he wrote before the question opened is no reply to it.
    c.say(waykeeper.id, 'yes, post it', { at: '2026-01-01T00:00:00.000Z' });
    await expect(answer({ questionId: question.id, decision: 'allow' })).rejects.toMatchObject({
      code: 'invalid',
      message: expect.stringContaining('has not replied'),
    });
    expect(c.log.tables.questions.get(question.id)!.status).toBe('open');
    expect(c.answersTo(question.id)).toEqual([]);
    expect(decisionsOf(c, steward.id)).toEqual([]);
    expect(c.ofType('send_grant.added')).toEqual([]);
  });

  it("refuses a grant whose words are not in Cosmin's reply", async () => {
    const { c, waykeeper, question, answer } = await projectHeld();
    c.say(waykeeper.id, 'yes, go ahead', { replyTo: question });
    await expect(
      answer({
        questionId: question.id,
        decision: 'allow',
        grant: { words: 'post anything all week', summary: 'All posts this week' },
      }),
    ).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('exact words') });
    expect(c.log.tables.questions.get(question.id)!.status).toBe('open');
    expect(c.ofType('send_grant.added')).toEqual([]);
    expect(c.answersTo(question.id)).toEqual([]);
  });

  it('refuses a grant ending in the past or beyond 90 days, with nothing changed', async () => {
    const { c, waykeeper, question, answer } = await projectHeld();
    c.say(waykeeper.id, 'yes, only today for Instagram', { replyTo: question });
    for (const endsAt of ['2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z']) {
      await expect(
        answer({
          questionId: question.id,
          decision: 'allow',
          grant: { words: 'only today for Instagram', summary: 'Instagram, today', endsAt },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
    }
    expect(c.log.tables.questions.get(question.id)!.status).toBe('open');
    expect(c.ofType('send_grant.added')).toEqual([]);
    expect(c.answersTo(question.id)).toEqual([]);
  });
});

describe('answer_send_permission: allow and deny (P13-28)', () => {
  it('a reply with an end makes the grant and approves the call with it, once', async () => {
    const { c, waykeeper, project, steward, question, answer } = await projectHeld();
    c.say(waykeeper.id, 'yes, only today for Instagram', { replyTo: question, origin: 'remote' });
    const endsAt = midnight();
    const out = (await answer({
      questionId: question.id,
      decision: 'allow',
      grant: { words: 'only today for Instagram', summary: 'Instagram posts, today', endsAt },
    })) as { status: string; grant: { id: string; endsAt: string } };
    expect(out.status).toBe('allowed');
    const [added] = c.ofType('send_grant.added');
    expect(added!.grant).toMatchObject({
      projectId: project.id,
      words: 'only today for Instagram',
      summary: 'Instagram posts, today',
      endsAt: new Date(endsAt).toISOString(),
      createdBy: USER,
      origin: 'remote',
      questionId: question.id,
    });
    expect(out.grant.id).toBe(added!.grant.id);
    expect(c.log.tables.projects.get(project.id)!.sendGrants).toHaveLength(1);
    await until(() => c.ofType('agent.finished').some((e) => e.agentId === steward.id));
    expect(decisionsOf(c, steward.id)).toEqual([
      expect.objectContaining({
        questionId: question.id,
        decision: 'allow',
        decidedBy: { type: 'agent', id: waykeeper.id },
        allowedBy: 'grant',
        grantId: added!.grant.id,
        waykeeperApproval: true,
      }),
    ]);
    expect(c.log.tables.questions.get(question.id)!.status).toBe('cancelled');
    expect(c.answersTo(question.id)).toEqual([{ questionId: question.id, answer: 'allow' }]);
    // The card's late Allow once is refused: the call was answered.
    await expect(
      c.commands.answerQuestion({ questionId: question.id, answer: 'allow', by: USER }),
    ).rejects.toThrow();
    expect(c.answersTo(question.id)).toHaveLength(1);
  });

  it('a chat line to the Waykeeper while the question is open counts as the reply', async () => {
    const { c, waykeeper, steward, question, answer } = await projectHeld();
    c.say(waykeeper.id, 'sure, just this one');
    await answer({ questionId: question.id, decision: 'allow' });
    await until(() => c.ofType('agent.finished').some((e) => e.agentId === steward.id));
    expect(decisionsOf(c, steward.id)[0]).toMatchObject({ allowedBy: 'allow_once' });
    expect(decisionsOf(c, steward.id)[0]!.grantId).toBeUndefined();
    expect(c.ofType('send_grant.added')).toEqual([]);
    expect(c.answersTo(question.id)).toEqual([{ questionId: question.id, answer: 'allow' }]);
  });

  it('deny refuses the call and tells the Steward his words', async () => {
    const { c, waykeeper, steward, question, answer } = await projectHeld();
    c.say(waykeeper.id, 'no, not on Instagram', { replyTo: question });
    expect(await answer({ questionId: question.id, decision: 'deny' })).toEqual({
      status: 'denied',
    });
    expect(c.answersTo(question.id)).toEqual([
      { questionId: question.id, answer: 'deny: Cosmin did not allow this: no, not on Instagram' },
    ]);
    expect(decisionsOf(c, steward.id)).toEqual([]);
    expect(c.log.tables.questions.get(question.id)).toMatchObject({ status: 'cancelled' });
    expect(c.ofType('send_grant.added')).toEqual([]);
  });

  it('after a grant, another held send it covers is approved without a new question', async () => {
    const { c, script, waykeeper, project, steward, question, answer } = await projectHeld();
    const second = await heldSteward(c, project.id, waykeeper.id);
    c.say(waykeeper.id, 'yes, comment on the PRs this week', { replyTo: question });
    script.covers = true;
    await answer({
      questionId: question.id,
      decision: 'allow',
      grant: { words: 'comment on the PRs this week', summary: 'PR comments, this week' },
    });
    const grantId = c.ofType('send_grant.added')[0]!.grant.id;
    await until(() => c.ofType('agent.finished').some((e) => e.agentId === second.steward.id));
    expect(decisionsOf(c, second.steward.id)).toEqual([
      expect.objectContaining({ allowedBy: 'grant', grantId }),
    ]);
    expect(c.log.tables.questions.get(second.question.id)!.status).toBe('cancelled');
    expect(c.answersTo(second.question.id)).toEqual([
      { questionId: second.question.id, answer: 'allow' },
    ]);
    expect(decisionsOf(c, steward.id)).toHaveLength(1);
    expect(c.ofType('question.opened')).toHaveLength(2);
  });

  it('Auto turned off while the question was open: the allow still answers it, the grant is made', async () => {
    const { c, waykeeper, project, steward, question, answer } = await projectHeld();
    c.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER, false));
    c.say(waykeeper.id, 'yes, for this campaign', { replyTo: question });
    await answer({
      questionId: question.id,
      decision: 'allow',
      grant: { words: 'for this campaign', summary: 'Campaign posts' },
    });
    await until(() => c.ofType('agent.finished').some((e) => e.agentId === steward.id));
    expect(decisionsOf(c, steward.id)[0]).toMatchObject({ allowedBy: 'grant' });
    const grants = c.log.tables.projects.get(project.id)!.sendGrants!;
    expect(grants).toHaveLength(1);
    expect(grants[0]!.endsAt).toBeUndefined();
    expect(c.log.tables.projects.get(project.id)!.waykeeperAuto).not.toBe(true);
  });
});

describe('answer_send_permission: whose question it is (P13-28)', () => {
  it('a Waykeeper of another project, or the Harmonizer, cannot answer a project question', async () => {
    const { c, harmonizerId, waykeeper, question, answer } = await projectHeld();
    const other = await autoProject(c, harmonizerId, 'Shop');
    c.say(waykeeper.id, 'yes', { replyTo: question });
    await expect(
      answer({ questionId: question.id, decision: 'deny' }, other.waykeeper.id, other.project.id),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      answerSendPermissionTool.handler(
        { questionId: question.id, decision: 'deny' },
        c.ctxOf(harmonizerId),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(c.log.tables.questions.get(question.id)!.status).toBe('open');
  });

  it('the Harmonizer answers a standalone question and makes a standalone grant', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const c = runtime(script, { auto: true });
    const harmonizerId = await harmonizerOf(c);
    const { steward, question } = await heldSteward(c, undefined, harmonizerId);
    expect(question.context.sendPermission?.deciderId).toBe(harmonizerId);
    c.say(harmonizerId, 'ok, PR comments are fine', { replyTo: question });
    await answerSendPermissionTool.handler(
      {
        questionId: question.id,
        decision: 'allow',
        grant: { words: 'PR comments are fine', summary: 'PR comments' },
      },
      c.ctxOf(harmonizerId),
    );
    await until(() => c.ofType('agent.finished').some((e) => e.agentId === steward.id));
    expect(c.ofType('send_grant.added')[0]!.grant.projectId).toBeUndefined();
    expect(decisionsOf(c, steward.id)[0]).toMatchObject({
      allowedBy: 'grant',
      decidedBy: { type: 'agent', id: harmonizerId },
    });
  });
});

describe('both brains carry the tool (P13-28)', () => {
  it('is on the Waykeeper and Harmonizer tool lists', () => {
    expect(waykeeperDefinition().tools.map((t) => t.name)).toContain('answer_send_permission');
    expect(harmonizerBrain({ projectsRoot: '/p' }).tools.map((t) => t.name)).toContain(
      'answer_send_permission',
    );
  });
});

describe('the wake lines of a send permission question (P13-28)', () => {
  const BRAIN = 'a-wk-1';
  const question: Question = {
    id: 'q-send-1',
    kind: 'permission',
    originAgentId: 'a-steward-1',
    holder: USER,
    status: 'open',
    context: {
      text: 'Bash: gh pr comment 12',
      toolCall: { toolName: 'Bash', input: { command: COMMENT } },
      sendPermission: {
        summary: 'Comment on PR 12',
        parts: [{ text: COMMENT, categories: ['network'] }],
        grants: [],
        deciderId: BRAIN,
      },
    },
    version: 1,
    createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
  } as Question;
  const scope = (q: Question, brainId = BRAIN): WakeScope => ({
    brainId,
    role: 'waykeeper',
    projectId: 'p-1',
    supervises: (id) => id === 'a-steward-1',
    runsTask: () => true,
    runsProject: () => true,
    ownsProposal: () => true,
    question: (id) => (id === q.id ? q : undefined),
  });

  it('the question wakes its decider, and only its decider', () => {
    const opened = { type: 'question.opened', question } as Event;
    const line = wakeLine(opened, scope(question));
    expect(line).toContain('wants to send or spend');
    expect(line).toContain('"Comment on PR 12"');
    expect(line).toContain('answer_send_permission');
    expect(wakeLine(opened, scope(question, 'a-wk-other'))).toBeUndefined();
    const plain = {
      ...question,
      context: { ...question.context, sendPermission: undefined },
    } as Question;
    expect(wakeLine({ type: 'question.opened', question: plain } as Event, scope(plain))).toBe(
      undefined,
    );
  });

  it('a reply to it says the reply is decided through answer_send_permission, not only the buttons', () => {
    const reply = {
      type: 'message.sent',
      messageId: 'm-1',
      agentId: BRAIN,
      sender: USER,
      text: 'yes, only today',
      interrupt: false,
      replyTo: {
        kind: 'question',
        id: question.id,
        sender: { type: 'agent', id: 'a-steward-1' },
        text: 'x',
      },
    } as Event;
    const line = WAKE_RULES['message.sent']!.describe(
      reply as EventOfType<'message.sent'>,
      scope(question),
    );
    expect(line).toContain('answer_send_permission');
    expect(line).toMatch(/local time now \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d/);
    expect(line).not.toContain("only the user's buttons");
  });

  it('a reply to a send card without a decider still says only the buttons decide it', () => {
    const plain = {
      ...question,
      context: {
        ...question.context,
        sendPermission: { ...question.context.sendPermission!, deciderId: undefined },
      },
    } as Question;
    const reply = {
      type: 'message.sent',
      messageId: 'm-2',
      agentId: BRAIN,
      sender: USER,
      text: 'yes',
      interrupt: false,
      replyTo: { kind: 'question', id: plain.id, sender: USER, text: 'x' },
    } as EventOfType<'message.sent'>;
    const line = WAKE_RULES['message.sent']!.describe(reply, scope(plain));
    expect(line).toContain("only the user's buttons");
    expect(line).not.toContain('answer_send_permission');
  });
});

describe('the prompts on send permission questions (P13-28)', () => {
  for (const [name, prompt] of [
    ['Waykeeper', WAYKEEPER_SYSTEM_PROMPT],
    ['Harmonizer', HARMONIZER_SYSTEM_PROMPT],
  ] as const) {
    it(`the ${name} reads the reply, never invents an end, asks when unclear`, () => {
      for (const words of [
        "Read Cosmin's reply, then call answer_send_permission",
        'Never answer it before he replied',
        'grant.words must be his exact words',
        '"today" means the coming local midnight',
        '"this week" the end of Sunday',
        'a date the end of that day',
        'Never invent an end he did not say',
        'When his reply is unclear, ask him in chat what he means and do not answer yet',
      ]) {
        expect(prompt).toContain(words);
      }
    });
  }
});

describe('a reply to a send permission question wakes its decider from any chat (P13-28)', () => {
  const harnesses: BrainHarness[] = [];
  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.dispose().catch(() => {});
  });

  it("a reply in the Harmonizer's chat wakes the Waykeeper once; one in its own chat, once", async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = brainHarness({
      compose: { requestJudge: judgeOf(script) },
      adapter: { scenarios: SCRIPTS },
    });
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
    const task = (await h.commands.createTask({ description: 'comment', projectId: project.id }))
      .value;
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        prompt: 'scenario:send',
        taskId: task.id,
        supervisorId: wk.agentId,
      })
    ).value;
    await h.until(() =>
      h.log.tables.questions
        .all()
        .some((q) => q.originAgentId === steward.id && q.context.sendPermission !== undefined),
    );
    const question = h.log.tables.questions.all().find((q) => q.originAgentId === steward.id)!;
    expect(question.context.sendPermission?.deciderId).toBe(wk.agentId);
    let n = 0;
    const reply = (agentId: Id, text: string) =>
      h.log.runCommand((ctx) =>
        ctx.emit({
          type: 'message.sent',
          messageId: `m-reply-${++n}`,
          agentId,
          sender: USER,
          text,
          interrupt: false,
          origin: 'local',
          replyTo: {
            kind: 'question',
            id: question.id,
            sender: { type: 'agent', id: steward.id },
            text: question.context.text,
          },
        }),
      );
    reply(hq.agentId, 'typed in the Harmonizer chat: yes today');
    reply(wk.agentId, 'typed in the Waykeeper chat: yes today');
    await h.settle();
    const count = (prompts: string[], text: string) => prompts.join('\n').split(text).length - 1;
    const wkPrompts = wk.prompts();
    expect(count(wkPrompts, 'typed in the Harmonizer chat: yes today')).toBe(1);
    expect(count(wkPrompts, 'typed in the Waykeeper chat: yes today')).toBe(1);
    const lines = wkPrompts
      .join('\n')
      .split('\n')
      .filter((l) => l.includes('typed in the'));
    for (const line of lines) {
      expect(line).toContain('answer_send_permission');
      expect(line).toContain('local time now');
    }
    // The Harmonizer, who does not decide it, hears its own chat's reply as before.
    const hqLines = hq
      .prompts()
      .join('\n')
      .split('\n')
      .filter((l) => l.includes('typed in the'));
    expect(hqLines).toHaveLength(1);
    expect(hqLines[0]).toContain("only the user's buttons");
  });
});
