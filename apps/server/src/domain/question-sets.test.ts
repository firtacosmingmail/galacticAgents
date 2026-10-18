import { describe, expect, it } from 'vitest';
import {
  DISMISSED_BY_USER,
  SKIPPED_ANSWER,
  applyEvent,
  emptyWorld,
  type Actor,
  type Agent,
  type Event,
  type Id,
  type OpenQuestionSetInput,
  type Question,
  type SetAnswer,
} from '@galactic/protocol';
import { world } from '../test/world.js';
import { createAgent } from './agents.js';
import { Commands, type AgentControl } from './commands.js';
import { DomainError } from './errors.js';
import { endAgentQuestions, logRouting } from './question-service.js';
import { answerQuestion } from './questions.js';

/**
 * Question sets (P8-19, SPEC decision 141): N ordinary question rows sharing `context.set`,
 * opened, answered, drafted and dismissed in one transaction each, over a real event log.
 */

const USER: Actor = { type: 'user' };
const CAPS = { maxWallClockMs: 1000, maxToolCalls: 10 };
const as = (agent: Agent): Actor => ({ type: 'agent', id: agent.id });

const QUESTIONS = [
  { text: 'Which formats?', options: ['csv', 'tsv', 'json'], multiSelect: true },
  { text: 'Header row?', options: ['yes', 'no'] },
  { text: 'Anything else?' },
];

/** Harmonizer → Waykeeper → Steward, all living, and the command surface over the log. */
function setup(opts: { agents?: AgentControl } = {}) {
  const w = world();
  const living = new Set<Id>();
  const routing = logRouting(w.log, (id) => living.has(id));
  const commands = new Commands({
    log: w.log,
    questions: routing,
    ...(opts.agents ? { agents: opts.agents } : {}),
  });
  const agent = (role: 'harmonizer' | 'waykeeper' | 'steward', supervisorId?: Id) => {
    const a = w.run((ctx) =>
      createAgent(ctx, {
        role,
        runtime: 'fake',
        caps: CAPS,
        ...(supervisorId ? { supervisorId } : {}),
      }),
    ).value;
    living.add(a.id);
    return a;
  };
  const harmonizer = agent('harmonizer');
  const waykeeper = agent('waykeeper', harmonizer.id);
  const steward = agent('steward', waykeeper.id);
  const open = async (origin: Agent, extra: Partial<OpenQuestionSetInput> = {}) =>
    (
      await commands.openQuestionSet({
        originAgentId: origin.id,
        title: 'CSV import',
        questions: QUESTIONS,
        ...extra,
      })
    ).value;
  const row = (id: Id): Question => w.tables.questions.get(id)!;
  const seq = () => w.log.currentSeq();
  /** The envelopes logged after `since`. */
  const since = (from: number) => w.log.eventsSince(from, Number.MAX_SAFE_INTEGER);
  const allEvents = (): Event[] => since(0).map((e) => e.event);
  return {
    ...w,
    living,
    routing,
    commands,
    harmonizer,
    waykeeper,
    steward,
    open,
    row,
    seq,
    since,
    allEvents,
  };
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

/** Whether `envelopes` have consecutive seqs (one command appends its events together). */
function contiguous(envelopes: { seq: number }[]): boolean {
  return envelopes.every((e, i) => i === 0 || e.seq === envelopes[i - 1]!.seq + 1);
}

const answers = (rows: Question[], list: SetAnswer[], version?: number) =>
  rows.map((q, i) => ({
    questionId: q.id,
    answer: list[i]!,
    ...(version !== undefined ? { version } : { version: q.version }),
  }));

describe('openQuestionSet', () => {
  it("opens a Waykeeper's set held by the Harmonizer", async () => {
    const s = setup();
    const before = s.seq();
    const rows = await s.open(s.waykeeper);
    expect(rows).toHaveLength(3);
    const setId = rows[0]!.context.set!.id;
    expect(setId).toMatch(/^qs-/);
    rows.forEach((q, i) => {
      expect(q.id).toMatch(/^q-/);
      expect(q).toMatchObject({
        kind: 'clarification',
        originAgentId: s.waykeeper.id,
        holder: as(s.harmonizer),
        status: 'open',
        version: 0,
        context: {
          text: QUESTIONS[i]!.text,
          set: { id: setId, index: i, total: 3, title: 'CSV import' },
        },
        meta: { source: 'command' },
      });
      expect(q.context.origin).toMatchObject({ role: 'waykeeper' });
      expect(s.row(q.id)).toEqual(q);
    });
    expect(rows[0]!.context).toMatchObject({ options: ['csv', 'tsv', 'json'], multiSelect: true });
    const logged = s.since(before);
    expect(logged.map((e) => e.event.type)).toEqual([
      'question.opened',
      'question.opened',
      'question.opened',
    ]);
    expect(contiguous(logged)).toBe(true);
  });

  it('opens a set for the user directly with toUser', async () => {
    const s = setup();
    const rows = await s.open(s.steward, { toUser: true });
    for (const q of rows) {
      expect(q.holder).toEqual(USER);
      expect(q.meta).toEqual({ source: 'command', toUser: true });
    }
  });

  it('refuses 1 or 11 questions, 9 options, a permission kind', async () => {
    const s = setup();
    const before = s.seq();
    const base = { originAgentId: s.waykeeper.id, title: 'CSV import' };
    const one = await refusal(s.commands.openQuestionSet({ ...base, questions: [QUESTIONS[0]!] }));
    expect(one.code).toBe('invalid');
    const eleven = Array.from({ length: 11 }, (_, i) => ({ text: `Q${i}?` }));
    expect((await refusal(s.commands.openQuestionSet({ ...base, questions: eleven }))).code).toBe(
      'invalid',
    );
    const nine = Array.from({ length: 9 }, (_, i) => `o${i}`);
    const tooMany = [{ text: 'Pick?', options: nine }, QUESTIONS[1]!];
    expect((await refusal(s.commands.openQuestionSet({ ...base, questions: tooMany }))).code).toBe(
      'invalid',
    );
    const permission = { ...base, questions: QUESTIONS, kind: 'permission' };
    expect(
      (await refusal(s.commands.openQuestionSet(permission as OpenQuestionSetInput))).code,
    ).toBe('invalid');
    const permissionRow = [{ ...QUESTIONS[0]!, kind: 'permission' }, QUESTIONS[1]!];
    expect(
      (await refusal(s.commands.openQuestionSet({ ...base, questions: permissionRow }))).code,
    ).toBe('invalid');
    expect(
      (await refusal(s.commands.openQuestionSet({ ...base, title: ' ', questions: QUESTIONS })))
        .code,
    ).toBe('invalid');
    expect(s.seq()).toBe(before);
  });
});

describe('answerQuestionSet — the user', () => {
  it("the user's send answers every row in one transaction", async () => {
    const s = setup();
    const rows = await s.open(s.steward, { toUser: true });
    const before = s.seq();
    const { value, events } = await s.commands.answerQuestionSet({
      setId: rows[0]!.context.set!.id,
      by: USER,
      answerId: 'send-1',
      answers: answers(rows, [
        { choices: ['csv', 'json', 'csv'] },
        { choices: ['yes'], text: 'always' },
        { choices: [], text: 'ignored', skipped: true },
      ]),
    });
    expect(events).toHaveLength(3);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'question.answered',
        questionId: rows[0]!.id,
        answer: 'csv, json',
        answeredBy: USER,
        answerId: 'send-1:0',
        detail: { choices: ['csv', 'json'] },
      }),
      expect.objectContaining({
        questionId: rows[1]!.id,
        answer: 'yes — always',
        answerId: 'send-1:1',
        detail: { choices: ['yes'], text: 'always' },
      }),
      expect.objectContaining({
        questionId: rows[2]!.id,
        answer: SKIPPED_ANSWER,
        answerId: 'send-1:2',
        detail: { choices: [], skipped: true },
      }),
    ]);
    const logged = s.since(before);
    expect(logged).toHaveLength(3);
    expect(contiguous(logged)).toBe(true);
    expect(value.map((q) => q.status)).toEqual(['answered', 'answered', 'answered']);
    expect(s.row(rows[2]!.id).answer).toBe(SKIPPED_ANSWER);
    expect(s.row(rows[0]!.id).meta).toMatchObject({
      answerId: 'send-1:0',
      answerDetail: { choices: ['csv', 'json'] },
    });
  });

  it('refuses a partial user send', async () => {
    const s = setup();
    const rows = await s.open(s.steward, { toUser: true });
    const before = s.seq();
    const error = await refusal(
      s.commands.answerQuestionSet({
        setId: rows[0]!.context.set!.id,
        by: USER,
        answers: answers(rows.slice(0, 2), [{ choices: ['csv'] }, { choices: ['no'] }]),
      }),
    );
    expect(error.code).toBe('invalid');
    expect(error.message).toContain(rows[2]!.id);
    expect(s.seq()).toBe(before);
    expect(s.row(rows[0]!.id).status).toBe('open');
  });

  it('refuses an answer that does not fit its question, or is empty', async () => {
    const s = setup();
    const rows = await s.open(s.steward, { toUser: true });
    const setId = rows[0]!.context.set!.id;
    const before = s.seq();
    const empty = await refusal(
      s.commands.answerQuestionSet({
        setId,
        by: USER,
        answers: answers(rows, [
          { choices: ['csv'] },
          { choices: ['no'] },
          { choices: [], text: '  ' },
        ]),
      }),
    );
    expect(empty.code).toBe('invalid');
    const twoForOne = await refusal(
      s.commands.answerQuestionSet({
        setId,
        by: USER,
        answers: answers(rows, [
          { choices: ['csv'] },
          { choices: ['yes', 'no'] },
          { choices: [], text: 'x' },
        ]),
      }),
    );
    expect(twoForOne.code).toBe('invalid');
    expect(s.seq()).toBe(before);
  });

  it('stale row refuses the whole send', async () => {
    const s = setup();
    // The Waykeeper's set is held by the Harmonizer; Cosmin looks at it at version 0.
    const rows = await s.open(s.waykeeper);
    const setId = rows[0]!.context.set!.id;
    // Meanwhile the Harmonizer answers row 2 and passes the others up.
    await s.commands.answerQuestionSet({
      setId,
      by: as(s.harmonizer),
      answers: [{ questionId: rows[1]!.id, answer: { choices: ['no'] } }],
    });
    const before = s.seq();
    const error = await refusal(
      s.commands.answerQuestionSet({
        setId,
        by: USER,
        answers: answers(
          rows,
          [{ choices: ['csv'] }, { choices: ['yes'] }, { choices: [], text: 'x' }],
          0,
        ),
      }),
    );
    expect(error.code).toBe('stale');
    expect(error.message).toMatch(/already answered by agent/);
    expect(s.seq()).toBe(before);
    expect(s.row(rows[0]!.id).status).toBe('open');
    expect(s.row(rows[2]!.id).status).toBe('open');
  });

  it('retry with the same answerId is duplicate', async () => {
    const s = setup();
    const rows = await s.open(s.steward, { toUser: true });
    const input = {
      setId: rows[0]!.context.set!.id,
      by: USER,
      answerId: 'send-7',
      answers: answers(rows, [
        { choices: ['tsv'] },
        { choices: ['no'] },
        { choices: [], skipped: true },
      ]),
    };
    const first = await s.commands.answerQuestionSet(input);
    expect(first.events).toHaveLength(3);
    const before = s.seq();
    const again = await s.commands.answerQuestionSet(input);
    expect(again.events).toEqual([]);
    expect(again.value.map((q) => q.status)).toEqual(['answered', 'answered', 'answered']);
    expect(s.seq()).toBe(before);
    // A different key is a second answer: refused as already answered.
    expect(
      (await refusal(s.commands.answerQuestionSet({ ...input, answerId: 'send-8' }))).code,
    ).toBe('stale');
  });

  it('a row a live session waits on goes through the adapter with its detail', async () => {
    const calls: { questionId: Id; answer: string; detail?: SetAnswer }[] = [];
    let live = new Set<Id>();
    const ref: { s?: ReturnType<typeof setup> } = {};
    const agents: AgentControl = {
      spawn: () => Promise.reject(new Error('unused')),
      stop: () => Promise.resolve(),
      pause: () => Promise.resolve(),
      resumeAgent: () => Promise.resolve(),
      hasQuestion: (id) => live.has(id),
      answer: (questionId, answer, by, answerId, _repliedIn, detail) => {
        calls.push({ questionId, answer, ...(detail ? { detail } : {}) });
        live.delete(questionId);
        ref.s!.log.runCommand((ctx) =>
          answerQuestion(ctx, {
            questionId,
            answer,
            answeredBy: by,
            delivered: true,
            ...(answerId !== undefined ? { answerId } : {}),
            ...(detail ? { detail } : {}),
          }),
        );
        return Promise.resolve();
      },
    };
    const s = setup({ agents });
    ref.s = s;
    const rows = await s.open(s.steward, { toUser: true });
    live = new Set([rows[1]!.id]);
    const { events } = await s.commands.answerQuestionSet({
      setId: rows[0]!.context.set!.id,
      by: USER,
      answerId: 'send-2',
      answers: answers(rows, [
        { choices: ['csv'] },
        { choices: ['yes'] },
        { choices: [], text: 'go' },
      ]),
    });
    expect(calls).toEqual([
      { questionId: rows[1]!.id, answer: 'yes', detail: { choices: ['yes'] } },
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'question.answered',
      'question.answered',
      'question.answered',
    ]);
    expect(s.row(rows[1]!.id).meta).toMatchObject({
      answerId: 'send-2:1',
      answerDetail: { choices: ['yes'] },
    });
  });
});

describe('answerQuestionSet — supervisors', () => {
  it('the Harmonizer answers row 1 and passes 2–3 up', async () => {
    const s = setup();
    const rows = await s.open(s.waykeeper);
    const before = s.seq();
    const { events } = await s.commands.answerQuestionSet({
      setId: rows[0]!.context.set!.id,
      by: as(s.harmonizer),
      answers: [{ questionId: rows[0]!.id, answer: { choices: ['json'] } }],
    });
    expect(events.map((e) => e.type)).toEqual([
      'question.answered',
      'question.escalated',
      'question.escalated',
    ]);
    expect(contiguous(s.since(before))).toBe(true);
    expect(s.row(rows[0]!.id)).toMatchObject({
      status: 'answered',
      answer: 'json',
      answeredBy: as(s.harmonizer),
    });
    expect(s.row(rows[1]!.id)).toMatchObject({ status: 'open', holder: USER, version: 1 });
    expect(s.row(rows[2]!.id)).toMatchObject({ status: 'open', holder: USER, version: 1 });
  });

  it('Waykeeper then Harmonizer on a Steward set', async () => {
    const s = setup();
    const rows = await s.open(s.steward);
    const setId = rows[0]!.context.set!.id;
    expect(rows.every((q) => q.holder.id === s.waykeeper.id)).toBe(true);
    await s.commands.answerQuestionSet({
      setId,
      by: as(s.waykeeper),
      answers: [{ questionId: rows[0]!.id, answer: { choices: ['csv'] } }],
    });
    expect(s.row(rows[1]!.id).holder).toEqual(as(s.harmonizer));
    expect(s.row(rows[2]!.id).holder).toEqual(as(s.harmonizer));
    // The Waykeeper holds nothing any more.
    const gone = await refusal(
      s.commands.answerQuestionSet({
        setId,
        by: as(s.waykeeper),
        answers: [{ questionId: rows[1]!.id, answer: { choices: ['yes'] } }],
      }),
    );
    expect(gone.code).toBe('conflict');
    await s.commands.answerQuestionSet({
      setId,
      by: as(s.harmonizer),
      answers: [{ questionId: rows[1]!.id, answer: { choices: ['yes'] } }],
    });
    expect(s.row(rows[0]!.id)).toMatchObject({ status: 'answered', answeredBy: as(s.waykeeper) });
    expect(s.row(rows[1]!.id)).toMatchObject({ status: 'answered', answeredBy: as(s.harmonizer) });
    expect(s.row(rows[2]!.id)).toMatchObject({ status: 'open', holder: USER });
    // The user now holds row 2 only: a send of that row alone is complete.
    const { events } = await s.commands.answerQuestionSet({
      setId,
      by: USER,
      answers: [{ questionId: rows[2]!.id, answer: { choices: [], text: 'ship it' } }],
    });
    expect(events).toEqual([
      expect.objectContaining({ answer: 'ship it', questionId: rows[2]!.id }),
    ]);
  });

  it('answers: [] passes everything up', async () => {
    const s = setup();
    const rows = await s.open(s.waykeeper);
    const { events } = await s.commands.answerQuestionSet({
      setId: rows[0]!.context.set!.id,
      by: as(s.harmonizer),
      answers: [],
    });
    expect(events.map((e) => e.type)).toEqual([
      'question.escalated',
      'question.escalated',
      'question.escalated',
    ]);
    expect(rows.map((q) => s.row(q.id).holder)).toEqual([USER, USER, USER]);
  });
});

describe('draftQuestion', () => {
  it('draft saves, does not bump version, clears on answer', async () => {
    const s = setup();
    const rows = await s.open(s.steward, { toUser: true });
    const q0 = rows[0]!;
    const { events } = await s.commands.draftQuestion({
      questionId: q0.id,
      draft: { choices: ['csv'] },
      by: USER,
    });
    expect(events).toEqual([
      { type: 'question.drafted', questionId: q0.id, draft: { choices: ['csv'] }, by: USER },
    ]);
    expect(s.row(q0.id)).toMatchObject({ version: 0, updatedAt: q0.updatedAt });
    expect(s.row(q0.id).meta).toMatchObject({ draft: { choices: ['csv'] }, source: 'command' });
    // Last save wins; null clears.
    await s.commands.draftQuestion({ questionId: q0.id, draft: { choices: ['tsv'] }, by: USER });
    expect(s.row(q0.id).meta?.['draft']).toEqual({ choices: ['tsv'] });
    await s.commands.draftQuestion({ questionId: q0.id, draft: null, by: USER });
    expect(s.row(q0.id).meta).toEqual({ source: 'command', toUser: true });
    await s.commands.draftQuestion({ questionId: q0.id, draft: { choices: ['json'] }, by: USER });
    await s.commands.answerQuestionSet({
      setId: q0.context.set!.id,
      by: USER,
      answers: answers(rows, [
        { choices: ['json'] },
        { choices: ['no'] },
        { choices: [], skipped: true },
      ]),
    });
    expect(s.row(q0.id).meta).toEqual({
      source: 'command',
      toUser: true,
      answerDetail: { choices: ['json'] },
    });
  });

  it('an agent may not draft', async () => {
    const s = setup();
    const rows = await s.open(s.waykeeper);
    expect(
      (
        await refusal(
          s.commands.draftQuestion({
            questionId: rows[0]!.id,
            draft: { choices: ['csv'] },
            by: as(s.harmonizer),
          }),
        )
      ).code,
    ).toBe('invalid');
    // Nor the user on a row a supervisor holds.
    expect(
      (
        await refusal(
          s.commands.draftQuestion({ questionId: rows[0]!.id, draft: { choices: [] }, by: USER }),
        )
      ).code,
    ).toBe('conflict');
  });
});

describe('dismissQuestionSet', () => {
  it('dismiss set cancels every open row', async () => {
    const s = setup();
    const rows = await s.open(s.waykeeper);
    const setId = rows[0]!.context.set!.id;
    await s.commands.answerQuestionSet({
      setId,
      by: as(s.harmonizer),
      answers: [{ questionId: rows[0]!.id, answer: { choices: ['csv'] } }],
    });
    await s.commands.draftQuestion({
      questionId: rows[1]!.id,
      draft: { choices: ['no'] },
      by: USER,
    });
    const before = s.seq();
    const { events } = await s.commands.dismissQuestionSet({ setId, by: USER, origin: 'local' });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'question.cancelled',
        questionId: rows[1]!.id,
        reason: DISMISSED_BY_USER,
        by: USER,
        origin: 'local',
      }),
      expect.objectContaining({ type: 'question.cancelled', questionId: rows[2]!.id }),
    ]);
    expect(contiguous(s.since(before))).toBe(true);
    expect(s.row(rows[0]!.id).status).toBe('answered');
    expect(s.row(rows[1]!.id).status).toBe('cancelled');
    expect(s.row(rows[1]!.id).meta?.['draft']).toBeUndefined();
    expect(s.row(rows[2]!.id).status).toBe('cancelled');
    expect((await refusal(s.commands.dismissQuestionSet({ setId, by: USER }))).code).toBe('stale');
  });
});

describe('single-question paths', () => {
  it('single-question paths refuse a set row', async () => {
    const s = setup();
    const rows = await s.open(s.waykeeper);
    const setId = rows[0]!.context.set!.id;
    const message = `part of set ${setId}: answer or dismiss the set`;
    const answer = await refusal(
      s.commands.answerQuestion({ questionId: rows[0]!.id, answer: 'csv', by: as(s.harmonizer) }),
    );
    expect(answer).toMatchObject({ code: 'invalid', message });
    const escalate = await refusal(s.commands.escalateQuestion(rows[0]!.id, as(s.harmonizer)));
    expect(escalate).toMatchObject({ code: 'invalid', message });
    const dismiss = await refusal(
      s.commands.dismissQuestion({ questionId: rows[0]!.id, by: USER }),
    );
    expect(dismiss).toMatchObject({ code: 'invalid', message });
  });
});

describe('orphans and the projection', () => {
  it('orphaned set keeps its rows together', async () => {
    const s = setup();
    const rows = await s.open(s.steward);
    const setId = rows[0]!.context.set!.id;
    s.living.delete(s.waykeeper.id);
    s.run((ctx) => endAgentQuestions(ctx, s.waykeeper.id, 'failed', s.routing));
    const moved = rows.map((q) => s.row(q.id));
    expect(moved.map((q) => q.holder)).toEqual([
      as(s.harmonizer),
      as(s.harmonizer),
      as(s.harmonizer),
    ]);
    expect(moved.map((q) => q.context.set)).toEqual(rows.map((q) => q.context.set));
    // The new holder answers the set as one.
    const { events } = await s.commands.answerQuestionSet({
      setId,
      by: as(s.harmonizer),
      answers: [{ questionId: rows[0]!.id, answer: { choices: ['csv'] } }],
    });
    expect(events.map((e) => e.type)).toEqual([
      'question.answered',
      'question.escalated',
      'question.escalated',
    ]);
  });

  it('the row projection folds like the world reducer (drafts, details, dismissals)', async () => {
    const s = setup();
    const a = await s.open(s.steward, { toUser: true });
    await s.commands.draftQuestion({ questionId: a[0]!.id, draft: { choices: ['csv'] }, by: USER });
    await s.commands.draftQuestion({ questionId: a[1]!.id, draft: { choices: ['no'] }, by: USER });
    await s.commands.draftQuestion({ questionId: a[1]!.id, draft: null, by: USER });
    await s.commands.answerQuestionSet({
      setId: a[0]!.context.set!.id,
      by: USER,
      answerId: 'k',
      answers: answers(a, [
        { choices: ['csv'] },
        { choices: ['no'] },
        { choices: [], skipped: true },
      ]),
    });
    const b = await s.open(s.steward, { toUser: true });
    await s.commands.draftQuestion({ questionId: b[0]!.id, draft: { choices: ['tsv'] }, by: USER });
    await s.commands.dismissQuestionSet({ setId: b[0]!.context.set!.id, by: USER });
    const folded = s
      .since(0)
      .reduce((state, envelope) => applyEvent(state, envelope), emptyWorld());
    const byId = Object.fromEntries(s.tables.questions.all().map((q) => [q.id, q]));
    expect(folded.questions).toEqual(byId);
  });
});
