import { randomUUID } from 'node:crypto';
import {
  LAUNCH_ACTIONS,
  launchCommand,
  taskLabel,
  unsupportedFlags,
  type Actor,
  type Id,
  type LaunchContext,
  type Question,
  type RequestLaunchInput,
} from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { originOf, type QuestionRouting } from './question-service.js';
import { COMMAND_SOURCE, describeActor, openQuestion } from './questions.js';

/**
 * Launch approvals (P12-07; design 2026-11-05-steward-launch-flags). A project's Waykeeper that
 * wants a Steward started with CLI flags (`claude --chrome`) asks with `requestLaunch`: a `launch`
 * question held by the user alone, answered with one of `LAUNCH_ACTIONS`. The approval is then
 * taken once (`takeLaunchApproval`) to spawn exactly that Steward — for that task, by that
 * Waykeeper, with that command, cwd and instructions.
 */

const USER = { type: 'user' } as const;
const APPROVE: string = LAUNCH_ACTIONS[0];

/** Whether a launch approval was already taken (`meta.launchUsed`). */
export const launchUsed = (question: Pick<Question, 'meta'>): boolean =>
  question.meta?.['launchUsed'] === true;

/**
 * Opens the `launch` question. Refused: flags the runtime cannot carry, an origin that is not the
 * Waykeeper of the task's project, a task that already has a launch question waiting.
 */
export function requestLaunch(
  ctx: CommandContext,
  input: RequestLaunchInput,
  routing: Pick<QuestionRouting, 'recentEvents'> | undefined,
): Question {
  const agent = must(ctx.tables.agents.get(input.originAgentId), 'agent', input.originAgentId);
  const task = must(ctx.tables.tasks.get(input.taskId), 'task', input.taskId);
  if (agent.role !== 'waykeeper' || !task.projectId || agent.projectId !== task.projectId) {
    throw new DomainError(
      'invalid',
      `only the Waykeeper of task ${task.id}'s project asks to start a Steward with flags`,
    );
  }
  const unsupported = unsupportedFlags(input.request.flags, input.runtime);
  if (unsupported.length > 0) {
    throw new DomainError(
      'invalid',
      `${unsupported.join(', ')} not supported on ${input.runtime}: start the Steward without flags`,
    );
  }
  const waiting = ctx.tables.questions
    .all()
    .find(
      (q) => q.kind === 'launch' && q.status === 'open' && q.context.launch?.taskId === task.id,
    );
  if (waiting) {
    throw new DomainError(
      'conflict',
      `a launch request for task ${task.id} is already waiting (${waiting.id}): wait for the user's answer`,
    );
  }
  const command = launchCommand(input.request.flags);
  const launch: LaunchContext = {
    ...input.request,
    taskId: task.id,
    command,
    cwd: input.cwd,
    instructions: input.instructions,
  };
  return openQuestion(ctx, {
    id: `q-${randomUUID()}`,
    kind: 'launch',
    originAgentId: agent.id,
    holder: USER,
    context: {
      text: `Start a Steward for ${taskLabel(task)} with ${command}?`,
      options: [...LAUNCH_ACTIONS],
      launch,
      origin: originOf(ctx, agent.id, routing ?? { recentEvents: () => [] }),
    },
    // Nobody's session waits on it: the Waykeeper hears the answer through its mailbox.
    meta: { source: COMMAND_SOURCE, toUser: true },
  });
}

/**
 * The approved launch, once: the question is answered `Approve and start`, is for `taskId`, the
 * caller is the Waykeeper that asked and nobody took it before. Marks it used in the same
 * transaction, so a second spawn on the same approval is refused.
 */
export function takeLaunchApproval(
  ctx: CommandContext,
  input: { questionId: Id; taskId: Id; by: Actor },
): LaunchContext {
  const q = must(ctx.tables.questions.get(input.questionId), 'question', input.questionId);
  const launch = q.kind === 'launch' ? q.context.launch : undefined;
  if (!launch) {
    throw new DomainError(
      'invalid_transition',
      `${q.id} is not a launch approval: ask the user first`,
    );
  }
  if (q.status !== 'answered') {
    throw new DomainError(
      'invalid_transition',
      `launch approval ${q.id} is not answered yet: wait for the user`,
    );
  }
  if (q.answer !== APPROVE) {
    throw new DomainError(
      'invalid_transition',
      `the user answered "${q.answer ?? ''}" to ${q.id}: start the Steward without flags or not at all`,
    );
  }
  if (launch.taskId !== input.taskId) {
    throw new DomainError(
      'invalid_transition',
      `launch approval ${q.id} is for task ${launch.taskId}, not ${input.taskId}`,
    );
  }
  if (input.by.type !== 'agent' || input.by.id !== q.originAgentId) {
    throw new DomainError(
      'invalid_transition',
      `launch approval ${q.id} belongs to agent ${q.originAgentId}, not ${describeActor(input.by)}`,
    );
  }
  if (launchUsed(q)) {
    throw new DomainError(
      'invalid_transition',
      `launch approval ${q.id} is already used: ask the user again to start another Steward with flags`,
    );
  }
  ctx.tables.questions.upsert({ ...q, meta: { ...q.meta, launchUsed: true } });
  return launch;
}
