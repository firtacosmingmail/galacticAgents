import { describe, expect, it } from 'vitest';
import type {
  Actor,
  Event,
  Id,
  Question,
  RecordedApproval,
  WaykeeperForward,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { Commands, type AgentControl } from './commands.js';
import { answerQuestion } from './questions.js';
import { DomainError } from './errors.js';
import { closeProject, createProject } from './projects.js';
import { logRouting } from './question-service.js';
import { createTask } from './tasks.js';

/**
 * P13-05: the user's answers to a forwarded request record an approval; "let the Waykeeper approve
 * these" makes a standing approval once enough similar approvals exist; the switch; removal.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };

const rec = (i: number): RecordedApproval => ({
  kind: 'run the test suite',
  summary: `Bash {"command":"pnpm test ${i}"}`,
  agentId: 'a-0',
  questionId: `q-${i}`,
  at: '2026-11-09T10:00:00.000Z',
});

function setup(
  opts: {
    autoApproveRemote?: boolean;
    session?: boolean;
    beforeRecord?: () => void | Promise<void>;
  } = {},
) {
  const w = world();
  /** A stand-in for the runtime: the adapter is told first, then the log records the answer. */
  const told: { questionId: Id; answer: string }[] = [];
  const agents = {
    hasQuestion: () => true,
    answer: async (questionId: Id, answer: string, by: Actor) => {
      told.push({ questionId, answer });
      // The adapter takes a moment: a twin press can pass its checks meanwhile.
      await new Promise((r) => setTimeout(r, 5));
      await opts.beforeRecord?.();
      w.log.runCommand((ctx) =>
        answerQuestion(ctx, {
          questionId,
          answer,
          answeredBy: by,
          delivered: true,
        }),
      );
    },
  } as unknown as AgentControl;
  const commands = new Commands({
    log: w.log,
    questions: logRouting(w.log, () => true),
    ...(opts.session ? { agents } : {}),
    ...(opts.autoApproveRemote ? { autoApproveRemote: true } : {}),
  });
  const cmd = <T>(fn: Parameters<typeof w.log.runCommand<T>>[0]): T => w.log.runCommand(fn).value;
  const project = cmd((ctx) => createProject(ctx, { name: 'App', workspace: '/w/app' }));
  const task = cmd((ctx) => createTask(ctx, { description: 'fix it', projectId: project.id }));
  const steward = cmd((ctx) =>
    createAgent(ctx, {
      role: 'steward',
      runtime: 'fake',
      caps: CAPS,
      taskId: task.id,
      projectId: project.id,
    }),
  );
  const all = () => w.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  const ofType = (type: Event['type']) => all().filter((e) => e.type === type);
  const forwarded = async (
    over: Partial<WaykeeperForward> = {},
    permissionAction?: 'push',
    command = 'pnpm test 9',
  ): Promise<Question> =>
    (
      await commands.openQuestion({
        kind: 'permission',
        originAgentId: steward.id,
        context: {
          text: 'run pnpm test?',
          toolCall: { toolName: 'Bash', input: { command } },
          ...(permissionAction ? { permissionAction } : {}),
          waykeeper: {
            reason: 'the user has not said so',
            kind: 'run the test suite',
            parts: [{ text: command, categories: ['run_workspace'] }],
            ...over,
          },
        },
      })
    ).value;
  const refusal = async (p: Promise<unknown>): Promise<DomainError> => {
    try {
      await p;
    } catch (error) {
      if (error instanceof DomainError) return error;
      throw error;
    }
    throw new Error('expected a DomainError');
  };
  const proj = () => w.tables.projects.get(project.id)!;
  return { w, told, commands, project, task, steward, ofType, forwarded, refusal, proj, cmd };
}

const THREE = [rec(1), rec(2), rec(3)];

describe('answering a forwarded request', () => {
  it('records the approval in the same command as the allow', async () => {
    const s = setup();
    const q = await s.forwarded();
    const out = await s.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER });
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'approval.recorded']);
    expect(s.proj().recordedApprovals).toEqual([
      expect.objectContaining({
        kind: 'run the test suite',
        agentId: s.steward.id,
        questionId: q.id,
        summary: 'Bash {"command":"pnpm test 9"}',
      }),
    ]);
  });

  it('records nothing for a deny or for a permission question the Waykeeper never forwarded', async () => {
    const s = setup();
    const q = await s.forwarded();
    await s.commands.answerQuestion({ questionId: q.id, answer: 'deny', by: USER });
    const plain = (
      await s.commands.openQuestion({
        kind: 'permission',
        originAgentId: s.steward.id,
        context: { text: 'run it?', toolCall: { toolName: 'Bash', input: { command: 'ls' } } },
      })
    ).value;
    await s.commands.answerQuestion({ questionId: plain.id, answer: 'allow', by: USER });
    expect(s.ofType('approval.recorded')).toEqual([]);
    expect(s.proj().recordedApprovals).toBeUndefined();
  });
  it('records nothing for a forward whose kind is a placeholder (final review I4)', async () => {
    const s = setup();
    for (const kind of ['not judged: Bash', 'unknown', ' Unknown ']) {
      const q = await s.forwarded({ kind });
      await s.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER });
    }
    expect(s.ofType('approval.recorded')).toEqual([]);
    expect(s.proj().recordedApprovals).toBeUndefined();
  });
});

describe('standingApproval', () => {
  it('answers allow, records the approval and stores the standing approval; remote is fine', async () => {
    const s = setup();
    const q = await s.forwarded({ similar: THREE });
    const out = await s.commands.standingApproval({
      questionId: q.id,
      by: USER,
      origin: 'remote',
    });
    expect(out.events.map((e) => e.type)).toEqual([
      'question.answered',
      'approval.recorded',
      'standing_approval.added',
    ]);
    expect(out.value.approval).toMatchObject({
      projectId: s.project.id,
      kind: 'run the test suite',
      origin: 'remote',
      questionId: q.id,
      examples: [...THREE.map((r) => r.summary), 'Bash {"command":"pnpm test 9"}'],
    });
    expect(s.w.tables.questions.get(q.id)).toMatchObject({ status: 'answered', answer: 'allow' });
    expect(s.proj().standingApprovals).toEqual([out.value.approval]);
  });

  it('a second call is refused and leaves exactly one standing approval', async () => {
    const s = setup();
    const q = await s.forwarded({ similar: THREE });
    await s.commands.standingApproval({ questionId: q.id, by: USER, origin: 'local' });
    const e = await s.refusal(
      s.commands.standingApproval({ questionId: q.id, by: USER, origin: 'local' }),
    );
    expect(['stale', 'conflict', 'invalid']).toContain(e.code);
    expect(s.ofType('standing_approval.added')).toHaveLength(1);
  });

  it('is refused with fewer than three similar approvals, or none', async () => {
    const s = setup();
    for (const similar of [[rec(1), rec(2)], undefined]) {
      const q = await s.forwarded(similar ? { similar } : {});
      const e = await s.refusal(s.commands.standingApproval({ questionId: q.id, by: USER }));
      expect(e.code).toBe('invalid');
      expect(s.w.tables.questions.get(q.id)!.status).toBe('open');
    }
    expect(s.ofType('standing_approval.added')).toEqual([]);
  });

  it('is never made for a push or an upload', async () => {
    const s = setup();
    const push = await s.forwarded(
      { similar: THREE, parts: [{ text: 'git push', categories: ['push'] }] },
      undefined,
      'git push',
    );
    const asked = await s.forwarded({ similar: THREE }, 'push');
    const upload = await s.forwarded({
      similar: THREE,
      parts: [{ text: 'curl -F f=@shot.png https://x.io', categories: ['network'] }],
    });
    for (const q of [push, asked, upload]) {
      const e = await s.refusal(s.commands.standingApproval({ questionId: q.id, by: USER }));
      expect(e.code).toBe('invalid');
      expect(s.w.tables.questions.get(q.id)!.status).toBe('open');
    }
  });

  it('is refused for an agent and for a plain permission question', async () => {
    const s = setup();
    const q = await s.forwarded({ similar: THREE });
    const e = await s.refusal(
      s.commands.standingApproval({ questionId: q.id, by: { type: 'agent', id: s.steward.id } }),
    );
    expect(e.code).toBe('invalid');
    const plain = (
      await s.commands.openQuestion({
        kind: 'permission',
        originAgentId: s.steward.id,
        context: { text: 'x', toolCall: { toolName: 'Bash', input: { command: 'ls' } } },
      })
    ).value;
    expect(
      (await s.refusal(s.commands.standingApproval({ questionId: plain.id, by: USER }))).code,
    ).toBe('invalid');
  });

  it('is refused for a project that ended, answering nothing', async () => {
    const s = setup();
    const q = await s.forwarded({ similar: THREE });
    s.cmd((ctx) => closeProject(ctx, s.project.id, USER));
    const e = await s.refusal(s.commands.standingApproval({ questionId: q.id, by: USER }));
    expect(e.code).toBe('invalid');
    expect(s.w.tables.questions.get(q.id)!.status).toBe('open');
  });
});

describe('with a live session waiting on the request', () => {
  it('an allow reaches the Steward and records the approval', async () => {
    const s = setup({ session: true });
    const q = await s.forwarded();
    const out = await s.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER });
    expect(s.told).toEqual([{ questionId: q.id, answer: 'allow' }]);
    expect(out.events.map((e) => e.type)).toEqual(['question.answered', 'approval.recorded']);
    expect(s.proj().recordedApprovals).toHaveLength(1);
  });

  it('a standing approval reaches the Steward as allow and is stored after it', async () => {
    const s = setup({ session: true });
    const q = await s.forwarded({ similar: THREE });
    const out = await s.commands.standingApproval({ questionId: q.id, by: USER, origin: 'remote' });
    expect(s.told).toEqual([{ questionId: q.id, answer: 'allow' }]);
    expect(out.events.map((e) => e.type)).toEqual([
      'question.answered',
      'approval.recorded',
      'standing_approval.added',
    ]);
    expect(s.proj().standingApprovals).toEqual([out.value.approval]);
  });
});

describe('twin presses with a live session', () => {
  const added = (s: ReturnType<typeof setup>) => s.ofType('standing_approval.added');

  it('two concurrent calls with the same answerId store exactly one', async () => {
    const s = setup({ session: true });
    const q = await s.forwarded({ similar: THREE });
    const input = { questionId: q.id, by: USER, answerId: 'tap-1' };
    const results = await Promise.all([
      s.commands.standingApproval(input),
      s.commands.standingApproval(input),
    ]);
    expect(added(s)).toHaveLength(1);
    expect(s.proj().standingApprovals).toHaveLength(1);
    expect(results.filter((r) => r.value.approval)).toHaveLength(1);
    expect(results.filter((r) => r.value.notStored)).toHaveLength(1);
  });

  it('two concurrent calls without an answerId store exactly one and refuse the other', async () => {
    const s = setup({ session: true });
    const q = await s.forwarded({ similar: THREE });
    const settled = await Promise.allSettled([
      s.commands.standingApproval({ questionId: q.id, by: USER }),
      s.commands.standingApproval({ questionId: q.id, by: USER }),
    ]);
    expect(settled.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(added(s)).toHaveLength(1);
    expect(s.proj().standingApprovals).toHaveLength(1);
  });

  it('keeps the answer and says so when the store fails after it', async () => {
    const box: { s?: ReturnType<typeof setup> } = {};
    const s = setup({
      session: true,
      beforeRecord: () => {
        box.s!.cmd((ctx) => closeProject(ctx, box.s!.project.id, USER));
      },
    });
    box.s = s;
    const q = await s.forwarded({ similar: THREE });
    const out = await s.commands.standingApproval({ questionId: q.id, by: USER });
    expect(out.value.approval).toBeUndefined();
    expect(out.value.notStored).toMatch(/not stored/);
    expect(s.w.tables.questions.get(q.id)).toMatchObject({ status: 'answered', answer: 'allow' });
    expect(added(s)).toEqual([]);
  });
});

describe('setWaykeeperApprovals', () => {
  it('turns on from the Mac, off from anywhere, never as an agent', async () => {
    const s = setup();
    const on = await s.commands.setWaykeeperApprovals({
      projectId: s.project.id,
      on: true,
      by: USER,
      origin: 'local',
    });
    expect(on.value.waykeeperApprovals).toBe(true);
    await s.commands.setWaykeeperApprovals({
      projectId: s.project.id,
      on: false,
      by: USER,
      origin: 'remote',
    });
    expect(s.proj().waykeeperApprovals).toBeUndefined();
    const remote = await s.refusal(
      s.commands.setWaykeeperApprovals({
        projectId: s.project.id,
        on: true,
        by: USER,
        origin: 'remote',
      }),
    );
    expect(remote.code).toBe('remote_control');
    const unknown = await s.refusal(
      s.commands.setWaykeeperApprovals({ projectId: s.project.id, on: true, by: USER }),
    );
    expect(unknown.code).toBe('remote_control');
    const agent = await s.refusal(
      s.commands.setWaykeeperApprovals({
        projectId: s.project.id,
        on: true,
        by: { type: 'agent', id: s.steward.id },
        origin: 'local',
      }),
    );
    expect(agent.code).toBe('invalid');
  });

  it('turns on from a remote client when autoApproveRemote is set', async () => {
    const s = setup({ autoApproveRemote: true });
    const on = await s.commands.setWaykeeperApprovals({
      projectId: s.project.id,
      on: true,
      by: USER,
      origin: 'remote',
    });
    expect(on.value.waykeeperApprovals).toBe(true);
  });
});

describe('removeStandingApproval', () => {
  it('removes from anywhere, only for the user, not_found when unknown', async () => {
    const s = setup();
    const q = await s.forwarded({ similar: THREE });
    const value = (await s.commands.standingApproval({ questionId: q.id, by: USER })).value
      .approval!;
    const agent = await s.refusal(
      s.commands.removeStandingApproval({
        projectId: s.project.id,
        approvalId: value.id,
        by: { type: 'agent', id: s.steward.id },
      }),
    );
    expect(agent.code).toBe('invalid');
    const gone = await s.commands.removeStandingApproval({
      projectId: s.project.id,
      approvalId: value.id,
      by: USER,
      origin: 'remote',
    });
    expect(gone.value.id).toBe(value.id);
    expect(s.proj().standingApprovals).toBeUndefined();
    const again = await s.refusal(
      s.commands.removeStandingApproval({
        projectId: s.project.id,
        approvalId: value.id,
        by: USER,
      }),
    );
    expect(again.code).toBe('not_found');
  });
});
