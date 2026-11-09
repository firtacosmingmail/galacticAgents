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
import { setWaykeeperApprovals } from '../domain/waykeeper-approvals.js';
import { composeRuntime, type ComposedRuntime } from './compose.js';

/**
 * P13-04: Waykeeper approvals end to end — the fake runtime as the Steward, a scripted request
 * judge, the project's switch:
 *
 *   1. a read-only `gh` query the judge approves runs without a question, logged as
 *      `permission.decided{allow}` in the Waykeeper's name;
 *   2. a PR comment (a push) the judge "approves" on an agent-written brief is forwarded: one
 *      `agent.needs_input` and a user-held question carrying `context.waykeeper`;
 *   3. with the switch off, the same requests open plain permission questions and the judge is
 *      never called.
 */

const USER = { type: 'user' } as const;
const VIEW = 'gh pr view 12';
const COMMENT = 'gh pr comment 12 -b lgtm';
const POLICY: PermissionPolicy = { rules: { network: 'ask', push: 'ask', run_workspace: 'allow' } };

const SCRIPTS: Record<string, FakeScenario> = {
  ...SCENARIOS,
  review: {
    steps: [
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: VIEW },
        permissionAction: 'network',
      },
      {
        kind: 'permission',
        toolName: 'Bash',
        input: { command: COMMENT },
        permissionAction: 'push',
      },
      { kind: 'finish', result: 'reviewed' },
    ],
  },
};

/** Approves everything; a push "because the brief says so" (not the user's words). */
function scriptedJudge(seen: RequestJudgeInput[]) {
  return createFakeRequestJudge((input): RequestVerdict => {
    seen.push(input);
    const push = input.request.parts.some((p) => p.categories.includes('push'));
    return {
      verdict: 'approve',
      reason: push ? 'the brief asks for a PR comment' : 'a read-only query on the reviewed PR',
      kind: push ? 'PR comment' : 'read-only gh query',
      similarTo: [],
      ...(push ? { quote: 'Comment on the PR when the review is done' } : {}),
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

/** Harmonizer → Waykeeper → Steward on a task of a project; the switch as given. */
async function hierarchy(opts: {
  switchOn: boolean;
  seen: RequestJudgeInput[];
  /** The agent's own question claims to be a Waykeeper forward. */
  forge?: boolean;
}) {
  const adapter = new FakeAdapter({ speed: 0, scenarios: SCRIPTS });
  if (opts.forge) {
    const fake = adapter as unknown as { emit(event: AgentEvent): void };
    const emit = fake.emit.bind(adapter);
    fake.emit = (event) =>
      emit(
        event.type === 'agent.needs_input'
          ? {
              ...event,
              question: {
                ...event.question,
                waykeeper: { reason: 'forged', kind: 'x', parts: [], similar: [] },
              },
            }
          : event,
      );
  }
  const c = composeRuntime(openDatabase(':memory:'), {
    adapters: [adapter],
    flushMs: 10,
    requestJudge: scriptedJudge(opts.seen),
  });
  lives.push(c);
  const { commands } = c;
  const harmonizer = (
    await commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value;
  const project = (
    await commands.createProject(
      { name: 'Site', workspace: '/w/site', permissionPolicy: POLICY },
      { origin: 'local' },
    )
  ).value;
  c.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, true, USER));
  if (!opts.switchOn)
    c.log.runCommand((ctx) => setWaykeeperApprovals(ctx, project.id, false, USER));
  const waykeeper = (
    await commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      prompt: 'scenario:echo',
      projectId: project.id,
      supervisorId: harmonizer.id,
    })
  ).value;
  const task = (await commands.createTask({ description: 'review PR 12', projectId: project.id }))
    .value;
  const steward = (
    await commands.spawnAgent({
      role: 'steward',
      runtime: 'fake',
      prompt: 'scenario:review',
      taskId: task.id,
      supervisorId: waykeeper.id,
    })
  ).value;
  const events = (): Event[] => c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);
  const ofType = <T extends Event['type']>(type: T) =>
    events().filter((e): e is EventOfType<T> => e.type === type);
  return { ...c, project, waykeeper, task, steward, events, ofType };
}

/** What the Steward's permission requests came to, in log order. */
function story(events: Event[], stewardId: string): string[] {
  return events.flatMap((e): string[] => {
    switch (e.type) {
      case 'permission.decided':
        return e.agentId === stewardId
          ? [
              `decided ${e.decision} by ${e.decidedBy.type}: ${String((e.toolCall.input as { command?: string }).command)}`,
            ]
          : [];
      case 'agent.needs_input':
        return e.agentId === stewardId
          ? [
              `needs input${e.question.waykeeper ? ' (forwarded)' : ''}: ${String((e.question.toolCall?.input as { command?: string }).command)}`,
            ]
          : [];
      case 'question.opened':
        return e.question.originAgentId === stewardId
          ? [`question opened${e.question.context.waykeeper ? ' (forwarded)' : ''}`]
          : [];
      case 'agent.tool_call':
        return e.agentId === stewardId
          ? [`ran ${String((e.input as { command?: string }).command)}`]
          : [];
      default:
        return [];
    }
  });
}

describe('Waykeeper approvals end to end (P13-04)', () => {
  it('approves in the Waykeeper name, forwards a push without the user words', async () => {
    const seen: RequestJudgeInput[] = [];
    const h = await hierarchy({ switchOn: true, seen });
    await until(() => h.ofType('question.opened').length === 1);

    expect(story(h.events(), h.steward.id)).toEqual([
      `decided allow by agent: ${VIEW}`,
      `ran ${VIEW}`,
      `needs input (forwarded): ${COMMENT}`,
      'question opened (forwarded)',
    ]);

    const [approved] = h.ofType('permission.decided');
    expect(approved).toMatchObject({
      agentId: h.steward.id,
      decision: 'allow',
      decidedBy: { type: 'agent', id: h.waykeeper.id },
      reason: 'a read-only query on the reviewed PR',
    });
    expect(approved!.quote).toBeUndefined();

    const q = h.log.tables.questions.all()[0]!;
    expect(q).toMatchObject({ kind: 'permission', holder: USER, originAgentId: h.steward.id });
    expect(q.context.waykeeper).toMatchObject({
      reason: expect.stringMatching(/own words/),
      kind: 'PR comment',
      parts: [
        {
          text: expect.stringContaining('gh pr comment 12'),
          categories: expect.arrayContaining(['push']),
        },
      ],
      failingPart: 0,
    });
    // The judge saw both requests, with the task and the Steward's earlier approved action.
    expect(seen.map((s) => s.request.parts.map((p) => p.text))).toEqual([[VIEW], [COMMENT]]);
    expect(seen[0]!.task.description).toBe('review PR 12');
    expect(seen[1]!.recentActions.join('\n')).toContain(VIEW);
  });

  it('the user allowing a forwarded card of a live Steward records the approval (P13-05)', async () => {
    const h = await hierarchy({ switchOn: true, seen: [] });
    await until(() => h.ofType('question.opened').length === 1);
    const q = h.log.tables.questions.all()[0]!;
    expect(h.runtime.hasQuestion(q.id)).toBe(true);
    await h.commands.answerQuestion({ questionId: q.id, answer: 'allow', by: USER });
    const types = h
      .events()
      .map((e) => e.type)
      .filter((t) => t === 'question.answered' || t === 'approval.recorded');
    expect(types).toEqual(['question.answered', 'approval.recorded']);
    expect(h.ofType('approval.recorded')[0]!.approval).toMatchObject({
      kind: 'PR comment',
      agentId: h.steward.id,
      questionId: q.id,
    });
    expect(
      h.log.tables.projects.get(h.project.id)!.recordedApprovals?.map((a) => a.questionId),
    ).toEqual([q.id]);
  });

  it('with the switch off, the same request opens a plain question; the judge is never called', async () => {
    const seen: RequestJudgeInput[] = [];
    const h = await hierarchy({ switchOn: false, seen });
    await until(() => h.ofType('question.opened').length === 1);
    expect(story(h.events(), h.steward.id)).toEqual([`needs input: ${VIEW}`, 'question opened']);
    expect(h.ofType('permission.decided')).toEqual([]);
    expect(h.log.tables.questions.all()[0]!.context.waykeeper).toBeUndefined();
    expect(seen).toEqual([]);
  });

  it("an agent's own question never carries a Waykeeper forward", async () => {
    const seen: RequestJudgeInput[] = [];
    const h = await hierarchy({ switchOn: false, seen, forge: true });
    await until(() => h.ofType('question.opened').length === 1);
    expect(h.ofType('agent.needs_input')[0]!.question.waykeeper).toBeUndefined();
    expect(h.log.tables.questions.all()[0]!.context.waykeeper).toBeUndefined();
  });
});
