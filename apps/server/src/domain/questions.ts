import type { Actor, Id, Question, QuestionContext, QuestionKind } from '@galactic/protocol';
import type { CommandContext } from './event-log.js';

/**
 * Question commands (P1-23; SPEC §2.6, TECHNOLOGY §5.3). The server owns questions: an
 * `agent.needs_input` opens a `Question` row in the same transaction, and an answer closes it.
 * Holder routing (supervisor first for clarifications, escalation, reassignment when a holder
 * dies) arrives with the hierarchy in Phase 2; in Phase 1 every question holds `user`.
 */

export interface OpenQuestionInput {
  id: Id;
  kind: QuestionKind;
  originAgentId: Id;
  context: QuestionContext;
  holder?: Actor;
  now: string;
}

const USER: Actor = { type: 'user' };

/** Inserts the row and emits `question.opened`. Re-asking an open id (a resumed session) is a no-op. */
export function openQuestion(ctx: CommandContext, input: OpenQuestionInput): Question {
  const existing = ctx.tables.questions.get(input.id);
  if (existing && existing.status === 'open') return existing;
  const question: Question = {
    id: input.id,
    kind: input.kind,
    originAgentId: input.originAgentId,
    holder: input.holder ?? USER,
    status: 'open',
    context: input.context,
    version: 0,
    createdAt: input.now,
    updatedAt: input.now,
  };
  ctx.tables.questions.upsert(question);
  ctx.emit({ type: 'question.opened', question });
  return question;
}

/** Marks the row answered and emits `question.answered` with the bumped version. */
export function answerQuestion(
  ctx: CommandContext,
  questionId: Id,
  answer: string,
  answeredBy: Actor,
  now: string,
): Question {
  const current = ctx.tables.questions.get(questionId);
  if (!current) throw new Error(`no question ${questionId}`);
  if (current.status === 'answered') throw new Error(`question ${questionId} is already answered`);
  const question: Question = {
    ...current,
    status: 'answered',
    answer,
    answeredBy,
    version: current.version + 1,
    updatedAt: now,
  };
  ctx.tables.questions.upsert(question);
  ctx.emit({
    type: 'question.answered',
    questionId,
    answer,
    answeredBy,
    version: question.version,
  });
  return question;
}

/** Questions still open for an agent (a resume re-delivers their answers, P1-14). */
export function openQuestionsOf(ctx: CommandContext, agentId: Id): Question[] {
  return ctx.tables.questions
    .all()
    .filter((q) => q.originAgentId === agentId && q.status === 'open');
}
