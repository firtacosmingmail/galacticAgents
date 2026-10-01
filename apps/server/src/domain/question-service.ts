import type { Statement } from 'better-sqlite3';
import type {
  Actor,
  AgentEvent,
  AgentState,
  Event,
  EventEnvelope,
  Id,
  Question,
  QuestionContext,
  QuestionKind,
  QuestionOrigin,
  QuestionRecentEvent,
} from '@galactic/protocol';
import { must } from './errors.js';
import type { CommandContext, EventLog } from './event-log.js';
import {
  cancelQuestionsOf,
  livingAbove,
  openQuestion,
  reassignQuestion,
  type OpenQuestionRow,
} from './questions.js';

/**
 * The question service (P2-03; SPEC §2.6, decisions 6, 7, 12, 21; TECHNOLOGY §5.3). The server
 * owns questions; this module decides where they go:
 *
 *   - **open** (`agent.needs_input`): a permission question is held by the user (P2-04 puts the
 *     policy evaluation in front of it; it never reaches a brain). A clarification goes to the
 *     origin agent's first living supervisor up the `supervisorId` chain, else to the user — a
 *     project Steward's to its Waykeeper, an asteroid Steward's to the Harmonizer. The context
 *     gains `origin`: role, task, project, body and the agent's last `RECENT_EVENTS` events.
 *   - **escalate**: one living level up (`escalateQuestion` with `isLiving`).
 *   - **answer / cancel**: the event names every agent that ever held the question (`holders`),
 *     so each holder's mailbox learns it was resolved and stops waiting.
 *   - **orphans**: when an agent ends (finished, failed, stopped, interrupted) its own open
 *     questions are cancelled (P1-34) and each open question it *holds* moves to the next living
 *     supervisor above it, or the user, with `question.reassigned`.
 *
 * Everything here runs inside a command (one write rule) and reads the log only through the
 * `QuestionRouting` it is given.
 */

/** How many of the origin agent's events a question carries (corner case 11). */
export const RECENT_EVENTS = 10;
const SUMMARY_MAX = 200;

/** What routing needs to know beyond the domain tables. */
export interface QuestionRouting {
  /** Whether the agent has a session that can hold (and answer) a question now. */
  isLiving(agentId: Id): boolean;
  /** The agent's last `limit` logged events, oldest first. */
  recentEvents(agentId: Id, limit: number): EventEnvelope[];
  /** Every agent that held the question so far, oldest first, from the log. */
  holdersOf(questionId: Id): Id[];
}

const ENDED: ReadonlySet<AgentState> = new Set(['finished', 'failed', 'stopped', 'interrupted']);
const LIFECYCLE = ['agent.spawned', 'agent.finished', 'agent.failed', 'agent.stopped'];

/**
 * Liveness from a status projection (the runtime's `StatusStore`): an agent with a record that is
 * not ended. No record (never spawned, or ended and pruned) is not living.
 */
export function livingFromStatuses(statuses: {
  get(agentId: Id): { state: AgentState } | undefined;
}): (agentId: Id) => boolean {
  return (agentId) => {
    const state = statuses.get(agentId)?.state;
    return state !== undefined && !ENDED.has(state);
  };
}

/**
 * Routing over the log. Liveness defaults to the agent's last lifecycle event in the log (living
 * after `agent.spawned`, not after an end or an interruption); the composed runtime passes the
 * status store's view instead, which answers without a query.
 */
export function logRouting(log: EventLog, isLiving?: (agentId: Id) => boolean): QuestionRouting {
  let lastLifecycle: Statement | undefined;
  let recent: Statement | undefined;
  let questionEvents: Statement | undefined;
  return {
    isLiving:
      isLiving ??
      ((agentId) => {
        lastLifecycle ??= log.db.prepare(
          `SELECT type FROM events
            WHERE type IN (${[...LIFECYCLE, 'agent.interrupted'].map(() => '?').join(', ')})
              AND json_extract(payload, '$.agentId') = ?
            ORDER BY id DESC LIMIT 1`,
        );
        const row = lastLifecycle.get(...LIFECYCLE, 'agent.interrupted', agentId) as
          { type: string } | undefined;
        return row?.type === 'agent.spawned';
      }),
    recentEvents(agentId, limit) {
      recent ??= log.db.prepare(
        `SELECT id, at, payload FROM events
          WHERE json_extract(payload, '$.agentId') = ?
          ORDER BY id DESC LIMIT ?`,
      );
      const rows = recent.all(agentId, limit) as { id: number; at: string; payload: string }[];
      return rows
        .reverse()
        .map((r) => ({ seq: r.id, at: r.at, event: JSON.parse(r.payload) as Event }));
    },
    holdersOf(questionId) {
      questionEvents ??= log.db.prepare(
        `SELECT payload FROM events
          WHERE type IN ('question.opened', 'question.escalated', 'question.reassigned')
            AND (json_extract(payload, '$.questionId') = ?
                 OR json_extract(payload, '$.question.id') = ?)
          ORDER BY id`,
      );
      const rows = questionEvents.all(questionId, questionId) as { payload: string }[];
      const holders: Id[] = [];
      const add = (actor: Actor | undefined) => {
        if (actor?.type === 'agent' && actor.id && !holders.includes(actor.id)) {
          holders.push(actor.id);
        }
      };
      for (const { payload } of rows) {
        const event = JSON.parse(payload) as Event;
        if (event.type === 'question.opened') add(event.question.holder);
        else if (event.type === 'question.escalated' || event.type === 'question.reassigned') {
          add(event.from);
          add(event.to);
        }
      }
      return holders;
    },
  };
}

/** Who holds a new question of `kind` asked by `originAgentId`. */
export function holderFor(
  ctx: CommandContext,
  originAgentId: Id,
  kind: QuestionKind,
  routing: Pick<QuestionRouting, 'isLiving'>,
): Actor {
  // Decision 7: permission questions are the policy's or the user's, never a brain's. P2-04
  // evaluates the project policy before a question is opened at all.
  if (kind === 'permission') return { type: 'user' };
  return livingAbove(ctx, originAgentId, routing.isLiving);
}

/** The context a card needs (corner case 11): where the question comes from and what led to it. */
export function originOf(
  ctx: CommandContext,
  originAgentId: Id,
  routing: Pick<QuestionRouting, 'recentEvents'>,
): QuestionOrigin {
  const agent = must(ctx.tables.agents.get(originAgentId), 'agent', originAgentId);
  const task = agent.taskId ? ctx.tables.tasks.get(agent.taskId) : undefined;
  const projectId = agent.projectId ?? task?.projectId;
  const bodyId = task?.bodyId ?? agent.bodyId;
  return {
    role: agent.role,
    ...(agent.taskId ? { taskId: agent.taskId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(bodyId ? { bodyId } : {}),
    recent: routing.recentEvents(originAgentId, RECENT_EVENTS).map(recentEvent),
  };
}

function recentEvent({ seq, at, event }: EventEnvelope): QuestionRecentEvent {
  const summary = summarize(event);
  return { seq, at, type: event.type, ...(summary ? { summary } : {}) };
}

function summarize(event: Event): string | undefined {
  const text = (() => {
    switch (event.type) {
      case 'agent.tool_call':
        return event.toolName;
      case 'agent.progress':
        return event.summary;
      case 'agent.needs_input':
        return event.question.text;
      case 'message.sent':
        return event.text;
      case 'agent.finished':
        return event.result;
      case 'agent.failed':
        return event.error;
      default:
        return undefined;
    }
  })();
  if (!text) return undefined;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1)}…` : text;
}

/** Opens a question routed to its holder, with the origin context filled in. */
export function openRouted(
  ctx: CommandContext,
  input: Omit<OpenQuestionRow, 'holder'>,
  routing: QuestionRouting,
): Question {
  const context: QuestionContext = {
    ...input.context,
    origin: originOf(ctx, input.originAgentId, routing),
  };
  return openQuestion(ctx, {
    ...input,
    context,
    holder: holderFor(ctx, input.originAgentId, input.kind, routing),
  });
}

/** `agent.needs_input` → its question, in the same command as the event. */
export function openFromNeedsInput(
  ctx: CommandContext,
  event: Extract<AgentEvent, { type: 'agent.needs_input' }>,
  routing: QuestionRouting,
): Question {
  return openRouted(
    ctx,
    {
      id: event.questionId,
      kind: event.kind,
      originAgentId: event.agentId,
      context: event.question,
    },
    routing,
  );
}

/**
 * Moves every open question `agentId` holds to the next living supervisor above it, or the user
 * (corner case 12). `agentId` counts as dead whatever the routing says: this runs in the command
 * that logs its end, before any projection has seen it.
 */
export function rerouteHeldBy(
  ctx: CommandContext,
  agentId: Id,
  routing: Pick<QuestionRouting, 'isLiving'>,
  reason: string,
): Question[] {
  const isLiving = (id: Id) => id !== agentId && routing.isLiving(id);
  return ctx.tables.questions
    .all()
    .filter((q) => q.status === 'open' && q.holder.type === 'agent' && q.holder.id === agentId)
    .map((q) => {
      let to = livingAbove(ctx, agentId, isLiving);
      // A re-parented chain must never hand a question to the agent that asked it.
      if (to.type === 'agent' && to.id === q.originAgentId) to = { type: 'user' };
      return reassignQuestion(ctx, q.id, to, reason);
    });
}

/**
 * An agent ended or was interrupted (`how`: "stopped", "interrupted", …): its own open questions
 * are cancelled (P1-34, decision 21), naming their holders, and the ones it held are re-routed.
 */
export function endAgentQuestions(
  ctx: CommandContext,
  agentId: Id,
  how: string,
  routing: QuestionRouting,
  opts: { keepHeld?: boolean } = {},
): void {
  cancelQuestionsOf(ctx, agentId, `agent ${how}`, (q) => holdersNow(ctx, q, routing));
  // A session reset replaces the session, not the agent: the questions it holds stay with it.
  if (!opts.keepHeld) rerouteHeldBy(ctx, agentId, routing, `holder ${agentId} ${how}`);
}

/**
 * The holders of a question as of this command: the log's history plus the current row's holder
 * (a move made earlier in the same command is not in the log yet).
 */
export function holdersNow(ctx: CommandContext, questionId: Id, routing: QuestionRouting): Id[] {
  const holders = routing.holdersOf(questionId);
  const current = ctx.tables.questions.get(questionId)?.holder;
  if (current?.type === 'agent' && current.id && !holders.includes(current.id)) {
    holders.push(current.id);
  }
  return holders;
}
