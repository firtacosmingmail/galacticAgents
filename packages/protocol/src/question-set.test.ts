import { describe, expect, it } from 'vitest';
import type { Question } from './domain.js';
import { question as baseQuestion } from './fixtures/domain.js';
import { events } from './fixtures/events.js';
import { Event } from './events.js';
import {
  QuestionSetRef,
  SKIPPED_ANSWER,
  SetQuestionInput,
  answerDetailOf,
  checkSetAnswer,
  draftOf,
  questionSetRows,
  renderSetAnswer,
  setOf,
} from './question-set.js';
import { applyEvent, emptyWorld } from './world.js';

const row = (id: string, setId: string | undefined, index: number, extra = {}): Question => ({
  ...baseQuestion,
  id,
  context: {
    text: `question ${id}`,
    options: ['A', 'B'],
    ...(setId ? { set: { id: setId, index, total: 3, title: 'Auth setup' } } : {}),
    ...extra,
  },
});

const at = '2026-10-18T10:00:00.000Z';
const worldOf = (...rows: Question[]) => ({
  ...emptyWorld(),
  questions: Object.fromEntries(rows.map((q) => [q.id, q])),
});
const user = { type: 'user' } as const;

describe('renderSetAnswer', () => {
  it('renders choices, choices plus text, text only and a skip', () => {
    expect(renderSetAnswer({ choices: ['Auth.js'] })).toBe('Auth.js');
    expect(renderSetAnswer({ choices: ['A', 'B'], text: 'only panel' })).toBe('A, B — only panel');
    expect(renderSetAnswer({ choices: [], text: 'x' })).toBe('x');
    expect(renderSetAnswer({ choices: [], skipped: true })).toBe(SKIPPED_ANSWER);
    expect(SKIPPED_ANSWER).toBe('(skipped by the user)');
  });
});

describe('checkSetAnswer', () => {
  const single = row('q', 's', 0);
  const multi = row('q', 's', 0, { multiSelect: true });

  it('accepts a listed choice, free text and a skip', () => {
    expect(checkSetAnswer(single, { choices: ['A'] })).toBeUndefined();
    expect(checkSetAnswer(single, { choices: [], text: 'other' })).toBeUndefined();
    expect(checkSetAnswer(single, { choices: [], skipped: true })).toBeUndefined();
    expect(checkSetAnswer(multi, { choices: ['A', 'B'] })).toBeUndefined();
  });

  it('refuses a choice outside the options', () => {
    expect(checkSetAnswer(single, { choices: ['Z'] })).toMatch(/not one of the options/);
  });

  it('refuses two choices without multiSelect', () => {
    expect(checkSetAnswer(single, { choices: ['A', 'B'] })).toMatch(/one choice/);
  });

  it('refuses an empty answer that is not a skip', () => {
    expect(checkSetAnswer(single, { choices: [] })).toBeDefined();
    expect(checkSetAnswer(single, { choices: [], text: '  ' })).toBeDefined();
  });
});

describe('schemas', () => {
  it('QuestionSetRef refuses a total above the limit and below two', () => {
    const ok = { id: 's', index: 0, total: 10, title: 't' };
    expect(QuestionSetRef.safeParse(ok).success).toBe(true);
    expect(QuestionSetRef.safeParse({ ...ok, total: 11 }).success).toBe(false);
    expect(QuestionSetRef.safeParse({ ...ok, total: 1 }).success).toBe(false);
  });

  it('SetQuestionInput allows at most eight options', () => {
    const options = Array.from({ length: 9 }, (_, i) => `o${i}`);
    expect(SetQuestionInput.safeParse({ text: 'q', options }).success).toBe(false);
    expect(SetQuestionInput.safeParse({ text: 'q', options: options.slice(0, 8) }).success).toBe(
      true,
    );
  });

  it('question.drafted parses with a draft or null', () => {
    expect(Event.parse(events['question.drafted'])).toEqual(events['question.drafted']);
    expect(
      Event.safeParse({ type: 'question.drafted', questionId: 'q', draft: null, by: user }).success,
    ).toBe(true);
  });
});

describe('set helpers', () => {
  it('setOf reads context.set', () => {
    expect(setOf(row('a', 's1', 2))?.index).toBe(2);
    expect(setOf(row('a', undefined, 0))).toBeUndefined();
  });

  it('questionSetRows sorts by index and ignores other sets', () => {
    const world = worldOf(
      row('c', 's1', 2),
      row('x', 's2', 0),
      row('a', 's1', 0),
      row('b', 's1', 1),
    );
    expect(questionSetRows(world, 's1').map((q) => q.id)).toEqual(['a', 'b', 'c']);
  });

  it('draftOf and answerDetailOf parse meta and tolerate junk', () => {
    const q = { ...row('a', 's', 0), meta: { draft: { choices: ['A'] }, answerDetail: 7 } };
    expect(draftOf(q)).toEqual({ choices: ['A'] });
    expect(answerDetailOf(q)).toBeUndefined();
    expect(draftOf(row('b', 's', 1))).toBeUndefined();
  });
});

describe('world reducer', () => {
  const start = worldOf(row('q1', 's', 0));
  const drafted = (draft: { choices: string[]; text?: string } | null, seq = 1) =>
    ({ seq, at, event: { type: 'question.drafted', questionId: 'q1', draft, by: user } }) as const;

  it('question.drafted sets meta.draft without a version bump; null removes it', () => {
    const w1 = applyEvent(start, drafted({ choices: ['A'] }));
    expect(w1.questions.q1?.meta).toEqual({ draft: { choices: ['A'] } });
    expect(w1.questions.q1?.version).toBe(start.questions.q1?.version);
    const w2 = applyEvent(w1, drafted(null, 2));
    expect(w2.questions.q1?.meta).toBeUndefined();
    expect(w2.questions.q1?.version).toBe(start.questions.q1?.version);
  });

  it('last draft wins and other meta survives a clear', () => {
    const withMeta = worldOf({ ...row('q1', 's', 0), meta: { answerId: 'k' } });
    const w1 = applyEvent(
      applyEvent(withMeta, drafted({ choices: ['A'] })),
      drafted({ choices: ['B'] }, 2),
    );
    expect(draftOf(w1.questions.q1!)).toEqual({ choices: ['B'] });
    expect(applyEvent(w1, drafted(null, 3)).questions.q1?.meta).toEqual({ answerId: 'k' });
  });

  it('question.answered with detail sets meta.answerDetail and removes the draft', () => {
    const w1 = applyEvent(start, drafted({ choices: ['A'] }));
    const w2 = applyEvent(w1, {
      seq: 2,
      at,
      event: {
        type: 'question.answered',
        questionId: 'q1',
        answer: 'B',
        answeredBy: user,
        version: 1,
        detail: { choices: ['B'] },
      },
    });
    const q = w2.questions.q1!;
    expect(q.status).toBe('answered');
    expect(q.meta).toEqual({ answerDetail: { choices: ['B'] } });
    expect(answerDetailOf(q)).toEqual({ choices: ['B'] });
  });

  it('question.cancelled removes the draft and keeps the dismissal meta', () => {
    const w1 = applyEvent(start, drafted({ choices: ['A'] }));
    const w2 = applyEvent(w1, {
      seq: 2,
      at,
      event: {
        type: 'question.cancelled',
        questionId: 'q1',
        agentId: 'a-steward-1',
        reason: 'dismissed by the user',
        version: 1,
        by: user,
      },
    });
    expect(w2.questions.q1?.status).toBe('cancelled');
    expect(w2.questions.q1?.meta).toEqual({
      cancelledBy: user,
      cancelReason: 'dismissed by the user',
    });
  });
});
