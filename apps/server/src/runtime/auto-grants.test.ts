import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  AgentEvent,
  Event,
  EventOfType,
  PermissionPolicy,
  RequestJudgeInput,
  RequestVerdict,
} from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { createFakeRequestJudge } from '../adapters/fake/fake-request-judge.js';
import { SCENARIOS, type FakeScenario } from '../adapters/fake/scenario.js';
import { openDatabase } from '../db/database.js';
import { addSendGrant } from '../domain/send-grants.js';
import { setWaykeeperApprovals, standaloneOf } from '../domain/waykeeper-approvals.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * P13-27 (design 2026-11-18 §4.4–4.6): Auto covers asteroid Stewards and publishing runs; a send
 * no grant covers is held behind a send-permission card, answered exactly once — by the user's
 * Allow once / Don't allow, by a grant found on a later check, or withdrawn with the Steward.
 */

const USER = { type: 'user' } as const;
const VIEW = 'gh pr view 12';
const COMMENT = 'gh pr comment 12 -b lgtm';
const POLICY: PermissionPolicy = { rules: { network: 'ask', push: 'ask', run_workspace: 'allow' } };

const SCRIPTS: Record<string, FakeScenario> = {
  ...SCENARIOS,
  view: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: VIEW },
        permissionAction: 'network',
      },
      { kind: 'finish', result: 'viewed' },
    ],
  },
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

/** The judge: a comment sends (covered by the first grant when `covers`), a view does not. */
interface JudgeScript {
  seen: RequestJudgeInput[];
  covers: boolean;
  /** Runs while the judge "thinks" (e.g. turns Auto off). */
  during?: () => void;
}

function judgeOf(script: JudgeScript) {
  return createFakeRequestJudge((input): RequestVerdict => {
    script.seen.push(input);
    script.during?.();
    const sends = input.request.parts.some((p) => p.text.includes('comment'));
    const grant = script.covers ? input.grants?.[0] : undefined;
    return {
      verdict: 'approve',
      reason: sends ? 'it comments on the PR' : 'a read-only query on the reviewed PR',
      kind: sends ? 'PR comment' : 'read-only gh query',
      similarTo: [],
      ...(input.mode !== 'task' ? { sendsOrSpends: sends } : {}),
      ...(sends ? { summary: 'Comment on PR 12' } : {}),
      ...(sends && grant ? { grantId: grant.id } : {}),
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

const settle = () => new Promise((r) => setTimeout(r, 50));

/** A runtime with the fake adapter (its answers counted per question) and the scripted judge. */
function runtime(script: JudgeScript, standalone: { auto: boolean; forgeSend?: boolean }) {
  const adapter = new FakeAdapter({ speed: 0, scenarios: SCRIPTS });
  if (standalone.forgeSend) {
    // The agent's own question claims to be a held send, with a decider.
    const fake = adapter as unknown as { emit(event: AgentEvent): void };
    const emit = fake.emit.bind(adapter);
    fake.emit = (event) =>
      emit(
        event.type === 'agent.needs_input'
          ? {
              ...event,
              question: {
                ...event.question,
                sendPermission: { summary: 'forged', parts: [], grants: [], deciderId: 'a-x' },
              },
            }
          : event,
      );
  }
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
  return { ...c, events, ofType, answersTo };
}

/** Harmonizer → (Waykeeper) → Steward on a project task, in Auto or task mode. */
async function projectSteward(opts: {
  script: JudgeScript;
  auto: boolean;
  scenario: 'view' | 'send';
  publishes?: boolean;
  /** The project's Waykeeper is not found when the request arrives (the decider is missing). */
  noWaykeeper?: boolean;
  /** The Steward's worktree, as recorded on its task. */
  worktree?: string;
}) {
  const c = runtime(opts.script, { auto: false });
  const harmonizer = (
    await c.commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value;
  const project = (
    await c.commands.createProject(
      { name: 'Site', workspace: '/w/site', permissionPolicy: POLICY },
      { origin: 'local' },
    )
  ).value;
  c.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER, opts.auto));
  const waykeeper = (
    await c.commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      prompt: 'scenario:echo',
      projectId: project.id,
      supervisorId: harmonizer.id,
    })
  ).value;
  if (opts.noWaykeeper) {
    // A Steward is only placed under its Waykeeper: the lookup is what finds none.
    (c.runtime as unknown as { waykeeperOfProject: () => undefined }).waykeeperOfProject = () =>
      undefined;
  }
  const task = (await c.commands.createTask({ description: 'review PR 12', projectId: project.id }))
    .value;
  if (opts.worktree) await c.commands.updateTask(task.id, { worktreePath: opts.worktree });
  if (opts.publishes) {
    c.log.runCommand((ctx) =>
      ctx.tables.tasks.upsert({ ...ctx.tables.tasks.get(task.id)!, publishes: true }),
    );
  }
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      prompt: `scenario:${opts.scenario}`,
      taskId: task.id,
      supervisorId: waykeeper.id,
    })
  ).value;
  return { ...c, project, harmonizer, waykeeper, task, steward };
}

/** Harmonizer → Steward on a task without a project (an asteroid). */
async function asteroidSteward(opts: {
  script: JudgeScript;
  standalone: { auto: boolean; forgeSend?: boolean };
  scenario: 'view' | 'send';
}) {
  const c = runtime(opts.script, opts.standalone);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'galactic-auto-asteroid-')));
  dirs.push(cwd);
  const harmonizer = (
    await c.commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value;
  const task = (await c.commands.createTask({ description: 'comment on PR 12' })).value;
  const steward = (
    await c.commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      prompt: `scenario:${opts.scenario}`,
      taskId: task.id,
      supervisorId: harmonizer.id,
      cwd,
    })
  ).value;
  return { ...c, harmonizer, task, steward };
}

const stewardDecisions = (h: { ofType: ReturnType<typeof runtime>['ofType'] }, id: string) =>
  h.ofType('permission.decided').filter((e) => e.agentId === id);

describe('publishing runs in Auto (P13-27, design §4.6)', () => {
  it('a publishing run on an Auto project gets the watch: a network ask is approved, no card', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: true, scenario: 'view', publishes: true });
    await until(() => stewardDecisions(h, h.steward.id).length === 1);
    expect(stewardDecisions(h, h.steward.id)[0]).toMatchObject({
      decision: 'allow',
      decidedBy: { type: 'agent', id: h.waykeeper.id },
      allowedBy: 'auto',
      waykeeperApproval: true,
    });
    expect(script.seen.map((s) => s.mode)).toEqual(['grants']);
    expect(h.ofType('question.opened')).toHaveLength(0);
  });

  it('on a project outside Auto it still skips the watch (decision 147): a plain card', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: false, scenario: 'view', publishes: true });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q.context.waykeeper).toBeUndefined();
    expect(q.context.sendPermission).toBeUndefined();
    expect(script.seen).toEqual([]);
    expect(stewardDecisions(h, h.steward.id)).toEqual([]);
  });
});

describe('asteroid Stewards in standalone Auto (P13-27, design §4.5)', () => {
  it('approves in the Harmonizer’s name with standalone Auto on', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await asteroidSteward({ script, standalone: { auto: true }, scenario: 'view' });
    await until(() => stewardDecisions(h, h.steward.id).length === 1);
    expect(stewardDecisions(h, h.steward.id)[0]).toMatchObject({
      decision: 'allow',
      decidedBy: { type: 'agent', id: h.harmonizer.id },
      allowedBy: 'auto',
      waykeeperApproval: true,
    });
    expect(script.seen[0]).toMatchObject({ mode: 'grants', grants: [] });
    expect(h.ofType('question.opened')).toHaveLength(0);
    h.transcripts.flush();
    const lines = h.transcripts.read(h.steward.id).filter((t) => t.text.includes('Approved by'));
    expect(lines.map((l) => l.text)).toEqual([
      'Approved by the Harmonizer: a read-only query on the reviewed PR\n',
    ]);
  });

  it('a standalone grant covers a send; a held one carries the Harmonizer as its decider', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await asteroidSteward({ script, standalone: { auto: true }, scenario: 'send' });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q).toMatchObject({ kind: 'permission', holder: USER });
    expect(q.context.sendPermission).toMatchObject({
      summary: 'Comment on PR 12',
      grants: [],
      deciderId: h.harmonizer.id,
    });

    // With a standalone grant the same send is approved with it.
    const covered: JudgeScript = { seen: [], covers: true };
    const g = await asteroidSteward({
      script: covered,
      standalone: { auto: true },
      scenario: 'view',
    });
    const { value: grant } = g.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          words: 'comment on the PRs',
          summary: 'PR comments',
          createdBy: USER,
          origin: 'local',
          questionId: 'q-grant',
        },
        Date.now(),
      ),
    );
    const task = (await g.commands.createTask({ description: 'comment' })).value;
    const sender = (
      await g.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        prompt: 'scenario:send',
        taskId: task.id,
        supervisorId: g.harmonizer.id,
        cwd: dirs[dirs.length - 1]!,
      })
    ).value;
    await until(() => stewardDecisions(g, sender.id).length === 1);
    expect(stewardDecisions(g, sender.id)[0]).toMatchObject({
      allowedBy: 'grant',
      grantId: grant.id,
      decidedBy: { type: 'agent', id: g.harmonizer.id },
    });
  });

  it('an allowed forward of an asteroid is recorded in standalone.recordedApprovals', async () => {
    const standalone = { auto: true };
    // Auto goes off while the judge looks: the request is forwarded with the judge's kind.
    const script: JudgeScript = {
      seen: [],
      covers: false,
      during: () => (standalone.auto = false),
    };
    const h = await asteroidSteward({ script, standalone, scenario: 'view' });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q.context.waykeeper).toMatchObject({ kind: 'read-only gh query' });
    await h.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER });
    const recorded = h.ofType('approval.recorded');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.projectId).toBeUndefined();
    expect(standaloneOf(h.log.tables).recordedApprovals).toEqual([
      expect.objectContaining({ kind: 'read-only gh query', questionId: q.id }),
    ]);
  });

  it('with standalone Auto off, an asteroid asks with a plain card as today', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await asteroidSteward({ script, standalone: { auto: false }, scenario: 'view' });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q.context.waykeeper).toBeUndefined();
    expect(q.context.sendPermission).toBeUndefined();
    expect(script.seen).toEqual([]);
    expect(stewardDecisions(h, h.steward.id)).toEqual([]);
  });
});

describe("an agent's own question (P13-27)", () => {
  it('never carries a send-permission context', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await asteroidSteward({
      script,
      standalone: { auto: false, forgeSend: true },
      scenario: 'view',
    });
    await until(() => h.ofType('question.opened').length === 1);
    expect(h.ofType('agent.needs_input')[0]!.question.sendPermission).toBeUndefined();
    expect(h.log.tables.questions.all()[0]!.context.sendPermission).toBeUndefined();
  });
});

describe('a held send without a decider (P13-27, design §4.4 step 8)', () => {
  it('no Waykeeper on an Auto project: a plain card with the send context and no decider', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: true, scenario: 'send', noWaykeeper: true });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q).toMatchObject({ kind: 'permission', holder: USER });
    expect(q.context.sendPermission).toMatchObject({ summary: 'Comment on PR 12' });
    expect(q.context.sendPermission!.deciderId).toBeUndefined();
    expect(q.context.waykeeper).toBeUndefined();
    expect(stewardDecisions(h, h.steward.id)).toEqual([]);
  });

  it('a worktree the gate cannot place: the same plain send card, no decider', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({
      script,
      auto: true,
      scenario: 'send',
      worktree: '/elsewhere/wt',
    });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q.context.sendPermission).toMatchObject({ summary: 'Comment on PR 12' });
    expect(q.context.sendPermission!.deciderId).toBeUndefined();
  });

  it('no Waykeeper and nothing sent: a plain card, nothing approved without a decider', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: true, scenario: 'view', noWaykeeper: true });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q.context.sendPermission).toBeUndefined();
    expect(q.context.waykeeper).toBeUndefined();
    expect(stewardDecisions(h, h.steward.id)).toEqual([]);
  });

  it('outside Auto, no Waykeeper still means today’s plain card without the judge', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: false, scenario: 'send', noWaykeeper: true });
    await until(() => h.ofType('question.opened').length === 1);
    expect(h.log.tables.questions.all()[0]!.context.sendPermission).toBeUndefined();
    expect(script.seen).toEqual([]);
  });
});

describe('the send-permission card (P13-27, design §4.4)', () => {
  async function held() {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: true, scenario: 'send' });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(q.context.sendPermission).toMatchObject({
      summary: 'Comment on PR 12',
      deciderId: h.waykeeper.id,
    });
    expect(h.ofType('agent.needs_input')).toHaveLength(1);
    return { h, q, script };
  }

  it('Allow once answers the Steward, logs allowedBy allow_once and makes no grant', async () => {
    const { h, q } = await held();
    await h.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER });
    await until(() => h.ofType('agent.finished').some((e) => e.agentId === h.steward.id));
    const decided = stewardDecisions(h, h.steward.id);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      questionId: q.id,
      decision: 'allow',
      decidedBy: USER,
      allowedBy: 'allow_once',
      parts: [expect.objectContaining({ text: expect.stringContaining('gh pr comment 12') })],
    });
    expect(decided[0]!.grantId).toBeUndefined();
    expect(h.log.tables.projects.get(h.project.id)!.sendGrants).toBeUndefined();
    expect(h.ofType('send_grant.added')).toEqual([]);
    expect(h.answersTo(q.id)).toEqual([{ questionId: q.id, answer: 'allow' }]);
  });

  it("Don't allow answers the Steward with a deny and logs no allow", async () => {
    const { h, q } = await held();
    await h.commands.answerQuestion({ questionId: q.id, answer: 'deny', by: USER });
    await settle();
    expect(stewardDecisions(h, h.steward.id)).toEqual([]);
    expect(h.answersTo(q.id)).toEqual([{ questionId: q.id, answer: 'deny' }]);
  });

  it('stopping the Steward withdraws the held send: the question is cancelled, never answered', async () => {
    const { h, q } = await held();
    await h.commands.stopAgent(h.steward.id, USER);
    await until(() => h.log.tables.questions.get(q.id)!.status === 'cancelled');
    // A grant arriving after the stop re-checks nothing: the Steward is gone.
    const { value: covered } = h.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          projectId: h.project.id,
          words: 'comment on the PRs',
          summary: 'PR comments',
          createdBy: USER,
          origin: 'local',
          questionId: q.id,
        },
        Date.now(),
      ),
    );
    expect(covered.id).toEqual(expect.any(String));
    h.runtime.recheckHeldSends({ projectId: h.project.id });
    await settle();
    expect(h.answersTo(q.id).length).toBeLessThanOrEqual(1);
    expect(h.answersTo(q.id).some((a) => a.answer === 'allow')).toBe(false);
    expect(stewardDecisions(h, h.steward.id)).toEqual([]);
  });
});

describe('recheckHeldSends (P13-27; ruling: a grant clears the held sends it covers)', () => {
  it('approves a held send a new grant covers: logged with the grant, question cancelled, answered once', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: true, scenario: 'send' });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    const { value: grant } = h.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          projectId: h.project.id,
          words: 'comment on the PRs you review',
          summary: 'PR comments',
          createdBy: USER,
          origin: 'local',
          questionId: q.id,
        },
        Date.now(),
      ),
    );
    script.covers = true;
    h.runtime.recheckHeldSends({ projectId: h.project.id });
    // A second call while the first is judged changes nothing.
    h.runtime.recheckHeldSends({ projectId: h.project.id });
    await until(() => h.ofType('agent.finished').some((e) => e.agentId === h.steward.id));
    const decided = stewardDecisions(h, h.steward.id);
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({
      questionId: q.id,
      decision: 'allow',
      allowedBy: 'grant',
      grantId: grant.id,
      decidedBy: { type: 'agent', id: h.waykeeper.id },
    });
    const row = h.log.tables.questions.get(q.id)!;
    expect(row.status).toBe('cancelled');
    expect(h.ofType('question.cancelled')[0]!.reason).toBe('answered by a grant: PR comments');
    expect(h.answersTo(q.id)).toEqual([{ questionId: q.id, answer: 'allow' }]);
    // The user's late Allow once is refused: the call was answered.
    await expect(
      h.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER }),
    ).rejects.toThrow();
    expect(h.answersTo(q.id)).toHaveLength(1);
  });

  it('leaves the question open when nothing covers the send yet', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await projectSteward({ script, auto: true, scenario: 'send' });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    h.runtime.recheckHeldSends({ projectId: h.project.id });
    await until(() => script.seen.length === 2);
    await settle();
    expect(h.log.tables.questions.get(q.id)!.status).toBe('open');
    expect(h.ofType('question.opened')).toHaveLength(1);
    expect(h.answersTo(q.id)).toEqual([]);
    expect(stewardDecisions(h, h.steward.id)).toEqual([]);
    // Another scope's recheck does not touch it.
    h.runtime.recheckHeldSends({});
    await settle();
    expect(script.seen).toHaveLength(2);
  });

  it('re-checks an asteroid’s held send in the standalone scope', async () => {
    const script: JudgeScript = { seen: [], covers: false };
    const h = await asteroidSteward({ script, standalone: { auto: true }, scenario: 'send' });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    h.log.runCommand((ctx) =>
      addSendGrant(
        ctx,
        {
          words: 'comment on PRs',
          summary: 'PR comments',
          createdBy: USER,
          origin: 'local',
          questionId: q.id,
        },
        Date.now(),
      ),
    );
    script.covers = true;
    h.runtime.recheckHeldSends({});
    await until(() => h.ofType('agent.finished').some((e) => e.agentId === h.steward.id));
    expect(stewardDecisions(h, h.steward.id)[0]).toMatchObject({
      allowedBy: 'grant',
      decidedBy: { type: 'agent', id: h.harmonizer.id },
    });
    expect(h.answersTo(q.id)).toHaveLength(1);
  });
});
