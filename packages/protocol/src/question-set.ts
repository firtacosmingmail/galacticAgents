import { z } from 'zod';
import type { Question } from './domain.js';
import { Id } from './primitives.js';
import type { WorldState } from './world.js';

/**
 * Question sets (P8-19, SPEC decision 141): several related clarifications asked at once. A set
 * is N ordinary question rows sharing `context.set`; the user answers them on one card.
 */

export const QUESTION_SET_LIMITS = {
  minQuestions: 2,
  maxQuestions: 10,
  maxOptions: 8,
  maxTitle: 120,
} as const;

/** What brains and adapters read for a question the user skipped. */
export const SKIPPED_ANSWER = '(skipped by the user)';

/** Where a row sits in its set; carried on `QuestionContext.set`. */
export const QuestionSetRef = z.object({
  id: Id,
  index: z.number().int().nonnegative(),
  total: z
    .number()
    .int()
    .min(QUESTION_SET_LIMITS.minQuestions)
    .max(QUESTION_SET_LIMITS.maxQuestions),
  title: z.string().min(1).max(QUESTION_SET_LIMITS.maxTitle),
});
export type QuestionSetRef = z.infer<typeof QuestionSetRef>;

/** One question's structured answer (or draft): chosen options, free text, or a skip. */
export const SetAnswer = z.object({
  choices: z.array(z.string()).default([]),
  text: z.string().optional(),
  skipped: z.boolean().optional(),
});
export type SetAnswer = z.infer<typeof SetAnswer>;

/** One question of a set as an agent asks it. */
export const SetQuestionInput = z.object({
  text: z.string().min(1),
  options: z.array(z.string().min(1)).max(QUESTION_SET_LIMITS.maxOptions).optional(),
  multiSelect: z.boolean().optional(),
});
export type SetQuestionInput = z.infer<typeof SetQuestionInput>;

/** The answer string brains and adapters read for a structured answer. */
export function renderSetAnswer(a: SetAnswer): string {
  if (a.skipped) return SKIPPED_ANSWER;
  const choices = a.choices.join(', ');
  const text = a.text?.trim() ?? '';
  if (choices && text) return `${choices} — ${text}`;
  return choices || text;
}

/** An error text when `a` does not fit the question, else `undefined`. */
export function checkSetAnswer(q: Pick<Question, 'context'>, a: SetAnswer): string | undefined {
  if (a.skipped) return undefined;
  const text = a.text?.trim() ?? '';
  if (a.choices.length === 0 && text === '') return 'an answer needs a choice, text, or a skip';
  const options = q.context.options ?? [];
  for (const choice of a.choices) {
    if (!options.includes(choice)) return `"${choice}" is not one of the options`;
  }
  if (a.choices.length > 1 && !q.context.multiSelect) {
    return 'this question takes one choice only';
  }
  return undefined;
}

export function setOf(q: Pick<Question, 'context'>): QuestionSetRef | undefined {
  return q.context.set;
}

/** Every row of a set, in the order the asker wrote them. */
export function questionSetRows(world: Pick<WorldState, 'questions'>, setId: Id): Question[] {
  return Object.values(world.questions)
    .filter((q) => q.context.set?.id === setId)
    .sort((a, b) => (a.context.set?.index ?? 0) - (b.context.set?.index ?? 0));
}

function metaAnswer(q: Question, key: 'draft' | 'answerDetail'): SetAnswer | undefined {
  const parsed = SetAnswer.safeParse(q.meta?.[key]);
  return parsed.success ? parsed.data : undefined;
}

/** The user's unsent draft on a row (`meta.draft`). */
export function draftOf(q: Question): SetAnswer | undefined {
  return metaAnswer(q, 'draft');
}

/** The structured answer recorded with the row's answer (`meta.answerDetail`). */
export function answerDetailOf(q: Question): SetAnswer | undefined {
  return metaAnswer(q, 'answerDetail');
}
