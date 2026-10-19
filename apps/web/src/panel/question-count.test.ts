import { describe, expect, it } from 'vitest';
import type { Question } from '@galactic/protocol';
import { domain as fx } from '@galactic/protocol/fixtures';
import { openQuestionsLabel, questionItems } from './question-count.js';

/** P8-22: a question set counts once wherever open questions are counted. */
const q = (id: string, set?: { index: number; holder?: Question['holder']; setId?: string }) => ({
  ...fx.question,
  id,
  holder: set?.holder ?? { type: 'user' as const },
  context: {
    text: id,
    ...(set ? { set: { id: set.setId ?? 'qs-1', index: set.index, total: 3, title: 'Plan' } } : {}),
  },
});

describe('questionItems', () => {
  it('counts a three-question set once and a single question once', () => {
    const items = questionItems([
      q('a'),
      q('s0', { index: 0 }),
      q('s1', { index: 1 }),
      q('s2', { index: 2 }),
    ]);
    expect(items).toEqual({ singles: 1, sets: [3] });
  });

  it('counts a set split between the user and a supervisor once per side, as the inbox does', () => {
    const items = questionItems([
      q('s0', { index: 0, holder: { type: 'agent', id: 'a-h' } }),
      q('s1', { index: 1 }),
      q('s2', { index: 2 }),
    ]);
    expect(items).toEqual({ singles: 0, sets: [1, 2] });
  });
});

describe('openQuestionsLabel', () => {
  it('reads like the old badge for single questions', () => {
    expect(openQuestionsLabel({ singles: 1, sets: [] })).toBe('1 open question');
    expect(openQuestionsLabel({ singles: 3, sets: [] })).toBe('3 open questions');
  });
  it('names a set with its number of questions', () => {
    expect(openQuestionsLabel({ singles: 0, sets: [3] })).toBe('1 question set · 3 questions');
    expect(openQuestionsLabel({ singles: 0, sets: [3, 2] })).toBe('2 question sets');
    expect(openQuestionsLabel({ singles: 1, sets: [3] })).toBe('1 open question + 1 question set');
    expect(openQuestionsLabel({ singles: 0, sets: [] })).toBe('');
  });
});
