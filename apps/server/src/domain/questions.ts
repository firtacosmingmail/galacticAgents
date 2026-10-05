import type { Actor, Id, Question, QuestionContext, QuestionKind } from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';

/**
 * Question commands (P1-23, P2-01; SPEC §2.6, TECHNOLOGY §5.3). The server owns questions: an
 * `agent.needs_input` opens a `Question` row in the same transaction, and an answer closes it.
 * Every change of holder or status bumps `version`, so an answer given against an older view is
 * refused with "already answered by …" instead of overwriting the first one. Where a question is
 * routed when it opens and when its holder dies is the question service's job
 * (`question-service.ts`, P2-03); these commands are the moves it makes.
 */

export interface OpenQuestionRow {
  id: Id;
  kind: QuestionKind;
  originAgentId: Id;
  context: QuestionContext;
  holder?: Actor;
  meta?: Record<string, unknown>;
}

/**
 * `meta.source` of a question a brain opened through the command surface (a tool such as
 * `ask_user`): nobody's session is blocked on it, so the asker hears the answer through its
 * mailbox. A question an adapter raised (`agent.needs_input`) is answered through the adapter.
 */
export const COMMAND_SOURCE = 'command';

const USER: Actor = { type: 'user' };

/**
 * `meta.usedFor` of a confirmation question whose answer already allowed a control (P5-07,
 * decision 83): "stop task t-1". Written by `consumeConfirmation` in the control's transaction.
 */
export const USED_FOR = 'usedFor';

/** What a confirmation's answer was used for, if it was. */
export function usedFor(question: Pick<Question, 'meta'> | undefined): string | undefined {
  const used = question?.meta?.[USED_FOR];
  return typeof used === 'string' ? used : undefined;
}

/**
 * Uses up the answer to a confirmation question (P5-07): one answer, one control. Runs inside the
 * control's command, so two calls with the same answer cannot both pass (commands run one at a
 * time) and a control the domain refuses rolls the mark back with it. Recorded on the question's
 * row (`meta.usedFor`), not on the work it controlled, so the work's history shows no extra edit.
 */
export function consumeConfirmation(ctx: CommandContext, questionId: Id, use: string): void {
  const question = must(ctx.tables.questions.get(questionId), 'question', questionId);
  const used = usedFor(question);
  if (used !== undefined) {
    throw new DomainError(
      'invalid',
      `the user's answer to ${questionId} was already used (${used}): ask_confirmation again`,
    );
  }
  ctx.tables.questions.upsert({ ...question, meta: { ...question.meta, [USED_FOR]: use } });
}

/** "the user", "agent a-1", "the system": how an actor reads in a refusal. */
export function describeActor(actor: Actor): string {
  if (actor.type === 'agent') return `agent ${actor.id ?? '?'}`;
  return actor.type === 'user' ? 'the user' : 'the system';
}

const sameActor = (a: Actor, b: Actor): boolean => a.type === b.type && a.id === b.id;

/** Refuses a question that is no longer open, saying who answered it first. */
function checkOpen(current: Question): void {
  if (current.status === 'answered') {
    throw new DomainError(
      'stale',
      `question ${current.id} was already answered by ${describeActor(current.answeredBy ?? USER)}`,
    );
  }
  if (current.status !== 'open') {
    throw new DomainError('invalid_transition', `question ${current.id} is ${current.status}`);
  }
}

function mustOpen(ctx: CommandContext, questionId: Id): Question {
  const current = must(ctx.tables.questions.get(questionId), 'question', questionId);
  checkOpen(current);
  return current;
}

/** A permission question is the policy's or the user's, never an agent's (decision 7, 12). */
function checkHolder(ctx: CommandContext, question: Question, holder: Actor): void {
  if (holder.type === 'agent') {
    if (question.kind === 'permission') {
      throw new DomainError('invalid', `permission question ${question.id} is held by the user`);
    }
    must(ctx.tables.agents.get(holder.id ?? ''), 'agent', holder.id ?? '(no id)');
  }
}

/**
 * Inserts the row and emits `question.opened`. Re-asking an open id (a resumed session) is a
 * no-op; re-asking a closed one opens it again with a higher version.
 */
export function openQuestion(ctx: CommandContext, input: OpenQuestionRow): Question {
  const existing = ctx.tables.questions.get(input.id);
  if (existing && existing.status === 'open') return existing;
  must(ctx.tables.agents.get(input.originAgentId), 'agent', input.originAgentId);
  const question: Question = {
    id: input.id,
    kind: input.kind,
    originAgentId: input.originAgentId,
    holder: input.holder ?? USER,
    status: 'open',
    context: input.context,
    // A re-asked id keeps counting: a view of the old question can never pass the version check.
    version: existing ? existing.version + 1 : 0,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(input.meta ? { meta: input.meta } : {}),
  };
  checkHolder(ctx, question, question.holder);
  ctx.tables.questions.upsert(question);
  ctx.emit({ type: 'question.opened', question });
  return question;
}

export interface AnswerInput {
  questionId: Id;
  answer: string;
  answeredBy: Actor;
  /** The version the answerer saw; absent = "whatever it is now" (the runtime's own path). */
  version?: number;
  /** Every agent that held the question (P2-03), carried on the event for their mailboxes. */
  holders?: Id[];
  /**
   * The answer already reached the agent through its adapter, after the full check: record it as
   * long as the question is open, even if its holder moved meanwhile — the agent has seen it.
   */
  delivered?: boolean;
  /** The answerer's idempotency key (P7-05), kept on the row as `meta.answerId`. */
  answerId?: string;
}

/** `meta.answerId`: the idempotency key of the answer that closed the question (P7-05). */
export const ANSWER_ID = 'answerId';

/** The idempotency key the question was answered under, if any. */
export function answerIdOf(question: Pick<Question, 'meta'> | undefined): string | undefined {
  const id = question?.meta?.[ANSWER_ID];
  return typeof id === 'string' ? id : undefined;
}

/**
 * Whether `answerId` already answered `question` (P7-05): a retry of an answer that was recorded
 * while its acknowledgement was lost. The caller reports success and changes nothing.
 */
export function isRecordedAnswer(question: Question, answerId: string | undefined): boolean {
  return (
    answerId !== undefined && question.status === 'answered' && answerIdOf(question) === answerId
  );
}

/**
 * Marks the row answered and emits `question.answered` with the bumped version. First answer
 * wins: a second one is refused with who answered first, and so is one given against an older
 * version (the holder changed meanwhile). An agent may answer only a clarification it holds.
 */
export function answerQuestion(ctx: CommandContext, input: AnswerInput): Question {
  const current = must(ctx.tables.questions.get(input.questionId), 'question', input.questionId);
  // A retry of an answer already recorded under its key: nothing to do (P7-05).
  if (isRecordedAnswer(current, input.answerId)) return current;
  checkAnswer(current, input);
  const question: Question = {
    ...current,
    status: 'answered',
    answer: input.answer,
    answeredBy: input.answeredBy,
    version: current.version + 1,
    updatedAt: ctx.now,
    ...(input.answerId ? { meta: { ...current.meta, [ANSWER_ID]: input.answerId } } : {}),
  };
  ctx.tables.questions.upsert(question);
  ctx.emit({
    type: 'question.answered',
    questionId: question.id,
    answer: input.answer,
    answeredBy: input.answeredBy,
    version: question.version,
    ...(input.holders?.length ? { holders: input.holders } : {}),
    ...(input.answerId ? { answerId: input.answerId } : {}),
  });
  return question;
}

/**
 * Whether `input` may answer `current` now; throws the refusal otherwise. Shared with the command
 * surface, which checks before handing the answer to the agent's adapter.
 */
export function checkAnswer(current: Question, input: AnswerInput): void {
  checkOpen(current);
  if (input.delivered) return;
  if (input.version !== undefined && input.version !== current.version) {
    throw new DomainError(
      'stale',
      `question ${current.id} changed since version ${input.version} (now held by ${describeActor(current.holder)})`,
    );
  }
  if (input.answeredBy.type === 'agent') {
    if (current.kind === 'permission') {
      throw new DomainError(
        'invalid',
        `permission question ${current.id} is answered by the policy or the user only`,
      );
    }
    if (!sameActor(current.holder, input.answeredBy)) {
      throw new DomainError(
        'conflict',
        `question ${current.id} is held by ${describeActor(current.holder)}, not ${describeActor(input.answeredBy)}`,
      );
    }
  }
}

/**
 * Hands a clarification one level up (SPEC §2.6): from the holding agent to its supervisor, or to
 * the user when it has none. With `isLiving` (the question service, P2-03) the first living
 * supervisor up the chain takes it, else the user. Only the holder (or the system) escalates; the
 * user already holds the top of the chain.
 */
export function escalateQuestion(
  ctx: CommandContext,
  questionId: Id,
  by: Actor,
  isLiving?: (agentId: Id) => boolean,
): Question {
  const current = mustOpen(ctx, questionId);
  const from = current.holder;
  if (from.type !== 'agent') {
    throw new DomainError('invalid_transition', `question ${questionId} is already with the user`);
  }
  if (by.type === 'agent' && !sameActor(by, from)) {
    throw new DomainError(
      'conflict',
      `question ${questionId} is held by ${describeActor(from)}, not ${describeActor(by)}`,
    );
  }
  const holder = must(ctx.tables.agents.get(from.id ?? ''), 'agent', from.id ?? '(no id)');
  const to: Actor = isLiving
    ? livingAbove(ctx, holder.id, isLiving)
    : holder.supervisorId
      ? { type: 'agent', id: holder.supervisorId }
      : USER;
  const question = moveTo(ctx, current, to);
  ctx.emit({ type: 'question.escalated', questionId, from, to, version: question.version });
  return question;
}

/** Changes the holder without an escalation: the holder died (orphan), or a hand-over. */
export function reassignQuestion(
  ctx: CommandContext,
  questionId: Id,
  to: Actor,
  reason: string,
): Question {
  const current = mustOpen(ctx, questionId);
  if (sameActor(current.holder, to)) {
    throw new DomainError(
      'invalid',
      `question ${questionId} is already held by ${describeActor(to)}`,
    );
  }
  checkHolder(ctx, current, to);
  const from = current.holder;
  const question = moveTo(ctx, current, to);
  ctx.emit({
    type: 'question.reassigned',
    questionId,
    from,
    to,
    reason,
    version: question.version,
  });
  return question;
}

/**
 * The first living supervisor above `agentId` (its supervisor, then that one's, …), or the user
 * when none is alive (SPEC §2.6; corner case 12). A broken chain (a missing row) ends at the user.
 */
export function livingAbove(
  ctx: CommandContext,
  agentId: Id,
  isLiving: (agentId: Id) => boolean,
): Actor {
  const seen = new Set<Id>([agentId]);
  let id = ctx.tables.agents.get(agentId)?.supervisorId;
  while (id && !seen.has(id)) {
    seen.add(id);
    if (isLiving(id)) return { type: 'agent', id };
    id = ctx.tables.agents.get(id)?.supervisorId;
  }
  return USER;
}

function moveTo(ctx: CommandContext, current: Question, to: Actor): Question {
  return ctx.tables.questions.upsert({
    ...current,
    holder: to,
    version: current.version + 1,
    updatedAt: ctx.now,
  });
}

/**
 * Closes an open question that can no longer be answered (P1-34) and emits `question.cancelled`.
 * A question that is not open is left as it is.
 */
export function cancelQuestion(
  ctx: CommandContext,
  questionId: Id,
  reason: string,
  holders?: Id[],
): Question | undefined {
  const current = ctx.tables.questions.get(questionId);
  if (!current || current.status !== 'open') return undefined;
  const question: Question = {
    ...current,
    status: 'cancelled',
    version: current.version + 1,
    updatedAt: ctx.now,
  };
  ctx.tables.questions.upsert(question);
  ctx.emit({
    type: 'question.cancelled',
    questionId,
    agentId: current.originAgentId,
    reason,
    version: question.version,
    ...(holders?.length ? { holders } : {}),
  });
  return question;
}

/** Cancels every open question of an agent (it ended or was interrupted). */
export function cancelQuestionsOf(
  ctx: CommandContext,
  agentId: Id,
  reason: string,
  holdersOf?: (questionId: Id) => Id[],
  keep?: (q: Question) => boolean,
): Id[] {
  return openQuestionsOf(ctx, agentId)
    .filter((q) => !keep?.(q))
    .map((q) => cancelQuestion(ctx, q.id, reason, holdersOf?.(q.id))?.id)
    .filter((id): id is Id => id !== undefined);
}

/** Questions still open for an agent (a resume re-delivers their answers, P1-14). */
export function openQuestionsOf(ctx: CommandContext, agentId: Id): Question[] {
  return ctx.tables.questions
    .all()
    .filter((q) => q.originAgentId === agentId && q.status === 'open');
}
