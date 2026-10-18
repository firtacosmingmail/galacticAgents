import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, Agent, Event, Question } from '@galactic/protocol';
import { FakeAdapter } from '../adapters/fake/fake-adapter.js';
import { openDatabase } from '../db/database.js';
import { composeRuntime, type ComposedRuntime } from '../runtime/compose.js';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { Commands } from './commands.js';
import { DomainError } from './errors.js';
import { logRouting, openFromNeedsInput, RECENT_EVENTS } from './question-service.js';

/**
 * The question service (P2-03) over a real runtime with the fake adapter: clarifications go up
 * the `supervisorId` chain to the first living supervisor, permission questions stay with the
 * user, the first answer wins and names every holder, and a dying holder's questions move up.
 */

const USER: Actor = { type: 'user' };
const as = (agent: Agent): Actor => ({ type: 'agent', id: agent.id });
const lives: ComposedRuntime[] = [];
afterEach(async () => {
  for (const c of lives.splice(0)) await c.dispose().catch(() => {});
});

function boot() {
  const composed = composeRuntime(openDatabase(':memory:'), {
    adapters: [new FakeAdapter({ speed: 0 })],
    flushMs: 10,
  });
  lives.push(composed);
  // The body catalogue is seeded by migration 0005.
  return composed;
}

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Every event of the log, in order. */
const allEvents = (c: ComposedRuntime): Event[] =>
  c.log.eventsSince(0, Number.MAX_SAFE_INTEGER).map((e) => e.event);

/** Harmonizer → Waykeeper of a project; `steward()` spawns a Steward on a task of it. */
async function hierarchy() {
  const c = boot();
  const { commands } = c;
  const harmonizer = (
    await commands.spawnAgent({
      role: 'harmonizer',
      runtime: 'fake',
      prompt: 'scenario:echo',
      cwd: '/hq',
    })
  ).value;
  const project = (await commands.createProject({ name: 'CSV', workspace: '/w/csv' })).value;
  const waykeeper = (
    await commands.spawnAgent({
      role: 'waykeeper',
      runtime: 'fake',
      prompt: 'scenario:echo',
      projectId: project.id,
      supervisorId: harmonizer.id,
    })
  ).value;
  const task = (await commands.createTask({ description: 'parse', projectId: project.id })).value;
  const steward = async (prompt = 'scenario:asks') =>
    (
      await commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        prompt,
        taskId: task.id,
        supervisorId: waykeeper.id,
      })
    ).value;
  return { ...c, harmonizer, waykeeper, project, task, steward };
}

async function questionOf(c: ComposedRuntime, agent: Agent): Promise<Question> {
  await until(() => c.log.tables.questions.all().some((q) => q.originAgentId === agent.id));
  return c.log.tables.questions.all().find((q) => q.originAgentId === agent.id)!;
}

async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error('expected a refusal');
}

describe('question service — opening', () => {
  it("routes a project Steward's clarification to its Waykeeper, with the origin context", async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);
    expect(q).toMatchObject({ kind: 'clarification', holder: as(h.waykeeper), version: 0 });
    const origin = q.context.origin!;
    expect(origin).toMatchObject({
      role: 'steward',
      taskId: h.task.id,
      projectId: h.project.id,
      bodyId: h.project.bodyId,
    });
    // What led to the question: the Steward's own logged events, oldest first, at most N.
    expect(origin.recent.length).toBeGreaterThan(0);
    expect(origin.recent.length).toBeLessThanOrEqual(RECENT_EVENTS);
    expect(origin.recent.map((e) => e.type)).toContain('agent.spawned');
    const seqs = origin.recent.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    // The opened event carries exactly the row (the web reducer folds it as is).
    const opened = allEvents(h).find((e) => e.type === 'question.opened');
    expect(opened).toMatchObject({ question: q });
  });

  it('skips a dead supervisor: the next living one up holds the question', async () => {
    const h = await hierarchy();
    await h.commands.stopAgent(h.waykeeper.id, USER);
    const steward = await h.steward();
    expect((await questionOf(h, steward)).holder).toEqual(as(h.harmonizer));
  });

  it('gives the question to the user when nobody up the chain is alive', async () => {
    const h = await hierarchy();
    await h.commands.stopAgent(h.waykeeper.id, USER);
    await h.commands.stopAgent(h.harmonizer.id, USER);
    const steward = await h.steward();
    expect((await questionOf(h, steward)).holder).toEqual(USER);
  });

  it('keeps permission questions with the user, whoever supervises the agent', async () => {
    const h = await hierarchy();
    const steward = await h.steward('scenario:echo');
    const { value } = await h.commands.openQuestion({
      kind: 'permission',
      originAgentId: steward.id,
      context: { text: 'Run rm -rf build?', toolCall: { toolName: 'Bash' } },
    });
    expect(value.holder).toEqual(USER);
    // No brain may take it over, not even by a re-assignment.
    await refusal(h.commands.reassignQuestion(value.id, as(h.waykeeper), 'try'));
    await refusal(
      h.commands.answerQuestion({ questionId: value.id, answer: 'allow', by: as(h.waykeeper) }),
    );
  });
});

describe('question service — escalation chains', () => {
  it('project Steward: Steward → Waykeeper → Harmonizer → user, the answer reaching the Steward', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);

    const toHarmonizer = await h.commands.escalateQuestion(q.id, as(h.waykeeper));
    expect(toHarmonizer.value).toMatchObject({ holder: as(h.harmonizer), version: 1 });
    expect(toHarmonizer.events).toEqual([
      {
        type: 'question.escalated',
        questionId: q.id,
        from: as(h.waykeeper),
        to: as(h.harmonizer),
        version: 1,
      },
    ]);
    // Only the holder escalates.
    await refusal(h.commands.escalateQuestion(q.id, as(h.waykeeper)));

    const toUser = await h.commands.escalateQuestion(q.id, as(h.harmonizer));
    expect(toUser.value).toMatchObject({ holder: USER, version: 2 });
    await refusal(h.commands.escalateQuestion(q.id, USER)); // already at the top

    const answered = await h.commands.answerQuestion({
      questionId: q.id,
      answer: 'semicolons',
      by: USER,
      version: 2,
    });
    expect(answered.value).toMatchObject({ status: 'answered', answeredBy: USER, version: 3 });
    // Every holder, past and present, is named on the event: their mailboxes stop waiting.
    expect(answered.events).toEqual([
      {
        type: 'question.answered',
        questionId: q.id,
        answer: 'semicolons',
        answeredBy: USER,
        version: 3,
        holders: [h.waykeeper.id, h.harmonizer.id],
      },
    ]);
    // Delivered through the adapter: the fake Steward carries on and finishes.
    await until(() => h.statuses.get(steward.id)?.state === 'finished');
  });

  it('escalation skips a supervisor that died meanwhile', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);
    // The Harmonizer dies while the Waykeeper holds the question: escalating goes to the user.
    await h.commands.stopAgent(h.harmonizer.id, USER);
    const { value } = await h.commands.escalateQuestion(q.id, as(h.waykeeper));
    expect(value.holder).toEqual(USER);
  });

  it('asteroid Steward: the Harmonizer supervises and holds it, then the user', async () => {
    const h = await hierarchy();
    const task = (await h.commands.createTask({ description: 'rename a file' })).value;
    const steward = (
      await h.commands.spawnAgent({
        role: 'steward',
        runtime: 'fake',
        prompt: 'scenario:asks',
        taskId: task.id,
        supervisorId: h.harmonizer.id,
        cwd: '/scratch',
      })
    ).value;
    const q = await questionOf(h, steward);
    expect(q.holder).toEqual(as(h.harmonizer));
    expect(q.context.origin).toMatchObject({
      role: 'steward',
      taskId: task.id,
      bodyId: task.bodyId,
    });
    expect(q.context.origin?.projectId).toBeUndefined();

    const { value } = await h.commands.escalateQuestion(q.id, as(h.harmonizer));
    expect(value.holder).toEqual(USER);
    const answered = await h.commands.answerQuestion({ questionId: q.id, answer: 'ok', by: USER });
    expect(answered.events[0]).toMatchObject({ holders: [h.harmonizer.id] });
    await until(() => h.statuses.get(steward.id)?.state === 'finished');
  });
});

describe('question service — answers', () => {
  it('double answer: the supervisor is first, the user is told who answered', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);

    const first = await h.commands.answerQuestion({
      questionId: q.id,
      answer: 'commas',
      by: as(h.waykeeper),
      version: 0,
    });
    expect(first.value).toMatchObject({ answeredBy: as(h.waykeeper), answer: 'commas' });

    // The user's card was opened on version 0, and a plain second answer: both refused.
    for (const version of [0, undefined]) {
      const error = await refusal(
        h.commands.answerQuestion({
          questionId: q.id,
          answer: 'tabs',
          by: USER,
          ...(version !== undefined ? { version } : {}),
        }),
      );
      expect(error.code).toBe('stale');
      expect(error.message).toContain(`already answered by agent ${h.waykeeper.id}`);
    }
    expect(h.log.tables.questions.get(q.id)).toMatchObject({ answer: 'commas', version: 1 });
    expect(allEvents(h).filter((e) => e.type === 'question.answered')).toHaveLength(1);
    await until(() => h.statuses.get(steward.id)?.state === 'finished');
  });

  it('refuses an answer from an agent that does not hold the question', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);
    const error = await refusal(
      h.commands.answerQuestion({ questionId: q.id, answer: 'x', by: as(h.harmonizer) }),
    );
    expect(error.code).toBe('conflict');
  });

  it('names the holders when a question is cancelled because its agent ended', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);
    await h.commands.stopAgent(steward.id, USER);
    expect(h.log.tables.questions.get(q.id)?.status).toBe('cancelled');
    expect(allEvents(h).find((e) => e.type === 'question.cancelled')).toMatchObject({
      questionId: q.id,
      reason: 'agent stopped',
      holders: [h.waykeeper.id],
    });
  });
});

describe('question service — orphaned holders', () => {
  it('moves a dead holder’s questions to the next living supervisor, then to the user', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);

    await h.commands.stopAgent(h.waykeeper.id, USER);
    expect(h.log.tables.questions.get(q.id)).toMatchObject({
      status: 'open',
      holder: as(h.harmonizer),
      version: 1,
    });
    expect(allEvents(h).filter((e) => e.type === 'question.reassigned')).toEqual([
      {
        type: 'question.reassigned',
        questionId: q.id,
        from: as(h.waykeeper),
        to: as(h.harmonizer),
        reason: `holder ${h.waykeeper.id} stopped`,
        version: 1,
      },
    ]);

    await h.commands.stopAgent(h.harmonizer.id, USER);
    expect(h.log.tables.questions.get(q.id)).toMatchObject({ holder: USER, version: 2 });

    // The question is still the Steward's: the user's answer reaches it and names both holders.
    const answered = await h.commands.answerQuestion({
      questionId: q.id,
      answer: 'pipes',
      by: USER,
      version: 2,
    });
    expect(answered.events[0]).toMatchObject({ holders: [h.waykeeper.id, h.harmonizer.id] });
    await until(() => h.statuses.get(steward.id)?.state === 'finished');
  });

  it('a shutdown interrupts the Steward before its holder: its question never climbs (P2-16)', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);
    await h.runtime.shutdown();
    const kinds = allEvents(h)
      .filter((e) =>
        e.type === 'question.opened'
          ? e.question.id === q.id
          : e.type.startsWith('question.') && 'questionId' in e && e.questionId === q.id,
      )
      .map((e) => e.type);
    // Agents are interrupted deepest first (P2-16): the Steward's question is cancelled (and
    // re-asked after the resume, decision 21) before its Waykeeper is interrupted, so it never
    // climbs to the user on the way down — and is never left with a dead holder.
    expect(kinds).toEqual(['question.opened', 'question.cancelled']);
    expect(allEvents(h).some((e) => e.type === 'question.reassigned')).toBe(false);
    expect(h.log.tables.questions.get(q.id)?.status).toBe('cancelled');
  });
});

describe('question service — over the log alone (no runtime)', () => {
  /** Rows plus `agent.spawned` folded through `recordAgentEvent`, the path without a session. */
  async function logOnly() {
    const w = world();
    const commands = new Commands({ log: w.log });
    const caps = { maxWallClockMs: 1000, maxToolCalls: 10 };
    const agent = async (role: Agent['role'], supervisorId?: string) => {
      const a = w.run((ctx) =>
        createAgent(ctx, {
          role,
          runtime: 'fake',
          caps,
          ...(supervisorId ? { supervisorId } : {}),
        }),
      ).value;
      await commands.recordAgentEvent({
        type: 'agent.spawned',
        agentId: a.id,
        role,
        runtime: 'fake',
        bodyId: a.bodyId,
      });
      return a;
    };
    const harmonizer = await agent('harmonizer');
    const waykeeper = await agent('waykeeper', harmonizer.id);
    const steward = await agent('steward', waykeeper.id);
    return { ...w, commands, harmonizer, waykeeper, steward };
  }

  it('routes by lifecycle events in the log and re-routes when the holder stops', async () => {
    const { commands, tables, harmonizer, waykeeper, steward } = await logOnly();
    await commands.recordAgentEvent({
      type: 'agent.needs_input',
      agentId: steward.id,
      questionId: 'q-1',
      kind: 'clarification',
      question: { text: 'Which separator?' },
    });
    expect(tables.questions.get('q-1')?.holder).toEqual(as(waykeeper));
    expect(tables.questions.get('q-1')?.context.origin?.recent.map((e) => e.type)).toEqual([
      'agent.spawned',
    ]);

    await commands.recordAgentEvent({ type: 'agent.stopped', agentId: waykeeper.id, by: USER });
    expect(tables.questions.get('q-1')?.holder).toEqual(as(harmonizer));

    await commands.recordAgentEvent({
      type: 'agent.failed',
      agentId: harmonizer.id,
      error: 'boom',
      reason: 'crash',
    });
    expect(tables.questions.get('q-1')?.holder).toEqual(USER);

    // The origin ends: its question is cancelled, naming both former holders.
    const { events } = await commands.recordAgentEvent({
      type: 'agent.finished',
      agentId: steward.id,
      result: 'gave up',
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'question.cancelled',
        questionId: 'q-1',
        holders: [waykeeper.id, harmonizer.id],
      }),
    );
  });

  it('rows of an adapter-opened question set keep together: a later row joins its siblings (P8-20)', async () => {
    const { commands, tables, waykeeper, steward } = await logOnly();
    const set = (index: number) => ({
      id: 'qs-1',
      index,
      total: 2,
      title: 'Questions from the Steward',
    });
    await commands.recordAgentEvent({
      type: 'agent.needs_input',
      agentId: steward.id,
      questionId: 'q-1',
      kind: 'clarification',
      question: { text: 'Which separator?', set: set(0) },
    });
    expect(tables.questions.get('q-1')).toMatchObject({
      holder: as(waykeeper),
      context: { set: set(0) },
    });
    // The first row moved on before the second arrived: the second follows it.
    await commands.reassignQuestion('q-1', USER, 'moved for the test');
    await commands.recordAgentEvent({
      type: 'agent.needs_input',
      agentId: steward.id,
      questionId: 'q-2',
      kind: 'clarification',
      question: { text: 'Which encoding?', set: set(1) },
    });
    expect(tables.questions.get('q-2')).toMatchObject({ holder: USER, context: { set: set(1) } });
  });

  it('a set ref outside the limits opens a plain question, never a broken set (P8-20)', async () => {
    const { run, log, tables, waykeeper, steward } = await logOnly();
    const routing = logRouting(log);
    const open = (questionId: string, kind: 'clarification' | 'permission', question: object) =>
      run((ctx) =>
        openFromNeedsInput(
          ctx,
          {
            type: 'agent.needs_input',
            agentId: steward.id,
            questionId,
            kind,
            question: { text: 'Q?', ...question },
          } as Parameters<typeof openFromNeedsInput>[1],
          routing,
        ),
      );
    const title = 'Questions from the Steward';
    open('q-total', 'clarification', { set: { id: 'qs-a', index: 0, total: 1, title } });
    open('q-index', 'clarification', { set: { id: 'qs-b', index: 2, total: 2, title } });
    open('q-title', 'clarification', {
      set: { id: 'qs-c', index: 0, total: 2, title: 'x'.repeat(121) },
    });
    open('q-options', 'clarification', {
      options: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
      set: { id: 'qs-d', index: 0, total: 2, title },
    });
    open('q-perm', 'permission', { set: { id: 'qs-e', index: 0, total: 2, title } });
    for (const id of ['q-total', 'q-index', 'q-title', 'q-options', 'q-perm']) {
      expect(tables.questions.get(id)?.status).toBe('open');
      expect(tables.questions.get(id)?.context.set).toBeUndefined();
    }
    expect(tables.questions.get('q-total')?.holder).toEqual(as(waykeeper));
  });
});

describe('question service — wave-2 review fixes', () => {
  it('a brain session reset keeps the questions it holds (same agent, new session)', async () => {
    const h = await hierarchy();
    const steward = await h.steward();
    const q = await questionOf(h, steward);
    expect(q.holder).toEqual(as(h.waykeeper));
    const renewed = await h.runtime.renewSession(h.waykeeper.id, 'scenario:echo');
    expect(renewed.ok).toBe(true);
    expect(h.log.tables.questions.get(q.id)).toMatchObject({
      status: 'open',
      holder: as(h.waykeeper),
    });
    expect(allEvents(h).some((e) => e.type === 'question.reassigned')).toBe(false);
    expect(h.log.tables.tasks.get(h.task.id)?.state).not.toBe('blocked_on_user');
  });
});

describe("question service — a Steward's question set (P8-20)", () => {
  it("opens every row of a project Steward's multi-question ask with its Waykeeper; its answers reach the Steward", async () => {
    const h = await hierarchy();
    const steward = await h.steward('scenario:asks-set');
    await until(
      () => h.log.tables.questions.all().filter((q) => q.originAgentId === steward.id).length === 3,
    );
    const rows = h.log.tables.questions
      .all()
      .filter((q) => q.originAgentId === steward.id)
      .sort((a, b) => a.context.set!.index - b.context.set!.index);
    const setId = rows[0]!.context.set!.id;
    for (const [i, row] of rows.entries()) {
      expect(row).toMatchObject({
        status: 'open',
        kind: 'clarification',
        holder: as(h.waykeeper),
        context: { set: { id: setId, index: i, total: 3, title: 'Questions from the Steward' } },
      });
    }
    expect(rows[1]!.context.multiSelect).toBe(true);
    // The Waykeeper settles the format; the rest go up to the Harmonizer, as asked.
    await h.commands.answerQuestionSet({
      setId,
      by: as(h.waykeeper),
      answers: [{ questionId: rows[0]!.id, answer: { choices: ['EU'] } }],
    });
    expect(h.log.tables.questions.get(rows[1]!.id)?.holder).toEqual(as(h.harmonizer));
    expect(h.runtime.liveAgents().some((a) => a.id === steward.id)).toBe(true);
    await h.commands.answerQuestionSet({
      setId,
      by: as(h.harmonizer),
      answers: [
        { questionId: rows[1]!.id, answer: { choices: ['date', 'note'] } },
        { questionId: rows[2]!.id, answer: { choices: [], skipped: true } },
      ],
    });
    await until(() => h.statuses.get(steward.id)?.state === 'finished');
    h.transcripts.flush();
    const said = h.transcripts
      .read(steward.id)
      .map((c) => c.text)
      .join('\n');
    expect(said).toContain(
      'answers: Which date format should the export use? EU; Which columns? date, note; Anything else I should know? (skipped by the user)',
    );
  });
});
