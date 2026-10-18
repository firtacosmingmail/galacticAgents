import { QUESTION_SET_LIMITS } from '@galactic/protocol';

/**
 * A runtime's multi-question ask becomes one question set (P8-20, SPEC decision 141): every
 * question opens at once as an `agent.needs_input` sharing `question.set`, and the agent is held
 * until each is resolved. Shared by the adapters.
 */

/** The set's title when the runtime gives none (an `AskUserQuestion` call, an untitled form). */
export const AGENT_SET_TITLE = 'Questions from the Steward';

/**
 * Whether questions with these option counts fit one set (2–10 questions, at most 8 options
 * each). One question is asked alone; an ask that does not fit is asked one question at a time.
 */
export function fitsQuestionSet(optionCounts: readonly number[]): boolean {
  const { minQuestions, maxQuestions, maxOptions } = QUESTION_SET_LIMITS;
  return (
    optionCounts.length >= minQuestions &&
    optionCounts.length <= maxQuestions &&
    optionCounts.every((n) => n <= maxOptions)
  );
}

/** A runtime-given title fitted to the set's limit, or `AGENT_SET_TITLE`. */
export function setTitle(title: unknown): string {
  const t = typeof title === 'string' ? title.trim() : '';
  return t ? t.slice(0, QUESTION_SET_LIMITS.maxTitle) : AGENT_SET_TITLE;
}
