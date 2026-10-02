import type {
  Actor,
  AgentRole,
  ControlTarget,
  Event,
  EventOfType,
  EventType,
  Id,
  Question,
} from '@galactic/protocol';
import { COMMAND_SOURCE } from '../domain/questions.js';

/**
 * Which events wake a brain (P2-06; TECHNOLOGY §5.2). One data-driven table: an event type that
 * has no rule never enters a mailbox; a rule decides whether the event concerns this brain and
 * renders the line its next turn prompt shows. Later tasks extend the table (a Waykeeper's plan
 * card, a promotion) by adding a rule, never by special-casing the runner.
 *
 * Never in the table: `agent.output` and `agent.tool_call` (transcript traffic), the brain's own
 * `agent.*` lifecycle, and permission questions (decision 7: the policy or the user resolves them,
 * never an LLM, so they do not enter any brain's mailbox).
 */

/** What a wake rule may ask about the brain's place in the hierarchy (read from the tables). */
export interface WakeScope {
  brainId: Id;
  role: AgentRole;
  /** The project the brain runs (a Waykeeper). */
  projectId?: Id;
  /** `agentId` is directly supervised by the brain. */
  supervises(agentId: Id | undefined): boolean;
  /** `agentId` is anywhere below the brain in the `supervisorId` chain (direct reports too). */
  below?(agentId: Id | undefined): boolean;
  /** The brain runs the task: a task of its project, or the task of an agent it supervises. */
  runsTask(taskId: Id): boolean;
  /** The brain runs the project: its own, or one a supervised Waykeeper runs. */
  runsProject(projectId: Id): boolean;
  /** The brain decides on the proposal (the Harmonizer proposes; P2-10 adds plan cards). */
  ownsProposal(proposalId: Id): boolean;
  question(questionId: Id): Question | undefined;
  /**
   * The control action concerns the brain as a supervisor (P2-14's `concernedSupervisors`): a
   * task's Waykeeper, an asteroid task's Harmonizer, a sub-project's parent Waykeeper.
   */
  concerned?(event: Event): boolean;
}

export interface WakeRule<T extends EventType> {
  wakes(event: EventOfType<T>, scope: WakeScope): boolean;
  /** One line of "since your last turn". */
  describe(event: EventOfType<T>, scope: WakeScope): string;
}

export type WakeRules = { [T in EventType]?: WakeRule<T> };

const isBrain = (actor: Actor | undefined, scope: WakeScope) =>
  actor?.type === 'agent' && actor.id === scope.brainId;

const who = (actor: Actor, scope: WakeScope): string =>
  actor.type === 'agent' ? (actor.id === scope.brainId ? 'you' : `agent ${actor.id}`) : actor.type;

/**
 * A question concerns the brain when it holds it or one of its agents asked it — except a question
 * opened for the user alone (`meta.toUser`, decision 30): no supervisor between may answer it, so
 * none is woken by it.
 */
function concerns(q: Question | undefined, scope: WakeScope): q is Question {
  if (!q || q.kind !== 'clarification') return false;
  if (isBrain(q.holder, scope)) return true;
  return q.meta?.['toUser'] !== true && scope.supervises(q.originAgentId);
}

/**
 * The brain held a clarification at some point (`holders` on its answer or cancellation), or
 * asked the question itself (the Harmonizer's `ask_user`, a Waykeeper's own question) — the asker
 * waits for the answer like any holder.
 */
function heldBefore(holders: readonly Id[] | undefined, scope: WakeScope, q: Question | undefined) {
  if (q !== undefined && q.kind !== 'clarification') return false; // decision 7: never a brain's
  // Its own question only when it asked through a tool: one its session is blocked on is answered
  // through the adapter, and a mailbox line would deliver it twice.
  if (q?.originAgentId === scope.brainId) return q.meta?.['source'] === COMMAND_SOURCE;
  return (holders ?? []).includes(scope.brainId);
}

function targets(target: ControlTarget, scope: WakeScope): boolean {
  switch (target.kind) {
    case 'agent':
      return target.id === scope.brainId || scope.supervises(target.id);
    case 'task':
      return scope.runsTask(target.id);
    case 'project':
      return scope.runsProject(target.id);
  }
}

const control = <T extends EventType & `control.${string}`>(verb: string): WakeRule<T> => ({
  wakes: (e, s) =>
    targets((e as { target: ControlTarget }).target, s) || (s.concerned?.(e as Event) ?? false),
  describe: (e, s) => {
    const { target, by } = e as unknown as { target: ControlTarget; by: Actor };
    const what =
      target.kind === 'agent' && target.id === s.brainId ? 'you' : `${target.kind} ${target.id}`;
    return `${who(by, s)} ${verb} ${what}`;
  },
});

type EndedType = 'agent.finished' | 'agent.failed' | 'agent.stalled';
const ended = <T extends EndedType>(text: (e: EventOfType<T>) => string): WakeRule<T> => ({
  wakes: (e, s) => s.supervises((e as EventOfType<EndedType>).agentId),
  describe: (e) => `agent ${(e as EventOfType<EndedType>).agentId} ${text(e)}`,
});

type DecisionType = `proposal.${'approved' | 'edited' | 'rejected' | 'parked'}`;
const proposal = <T extends DecisionType>(text: (e: EventOfType<T>) => string): WakeRule<T> => ({
  wakes: (e, s) => s.ownsProposal((e as EventOfType<DecisionType>).proposalId),
  describe: (e) => `proposal ${(e as EventOfType<DecisionType>).proposalId} ${text(e)}`,
});

const quote = (text: string) => JSON.stringify(text);

export const WAKE_RULES: WakeRules = {
  'message.sent': {
    // A user's chat line to the brain, or a report from an agent below it (a direct report, or a
    // sub-project's Waykeeper asking the Harmonizer for closure). The brain's own turn messages
    // are sent by the system and never wake it.
    wakes: (e, s) =>
      e.agentId === s.brainId &&
      (e.sender.type === 'user' ||
        (e.sender.type === 'agent' &&
          (s.supervises(e.sender.id) || (s.below?.(e.sender.id) ?? false)))),
    describe: (e, s) =>
      e.sender.type === 'user'
        ? `the user said: ${quote(e.text)}`
        : `${who(e.sender, s)} reported: ${quote(e.text)}`,
  },
  'question.opened': {
    wakes: (e, s) => concerns(e.question, s),
    describe: (e, s) =>
      `${who({ type: 'agent', id: e.question.originAgentId }, s)} asked ${e.question.id} ` +
      `(held by ${who(e.question.holder, s)}): ${quote(e.question.context.text)}`,
  },
  // Every agent that ever held the question learns it was resolved (SPEC decision 26), so no
  // level keeps waiting; permission questions never had an agent holder.
  'question.answered': {
    wakes: (e, s) =>
      heldBefore(e.holders, s, s.question(e.questionId)) || concerns(s.question(e.questionId), s),
    describe: (e, s) => `${who(e.answeredBy, s)} answered ${e.questionId}: ${quote(e.answer)}`,
  },
  'question.cancelled': {
    wakes: (e, s) =>
      heldBefore(e.holders, s, s.question(e.questionId)) || concerns(s.question(e.questionId), s),
    describe: (e) => `${e.questionId} was withdrawn (${e.reason})`,
  },
  'question.escalated': {
    wakes: (e, s) =>
      isBrain(e.from, s) || isBrain(e.to, s) || concerns(s.question(e.questionId), s),
    describe: (e, s) => `${e.questionId} was escalated from ${who(e.from, s)} to ${who(e.to, s)}`,
  },
  'question.reassigned': {
    wakes: (e, s) =>
      isBrain(e.from, s) || isBrain(e.to, s) || concerns(s.question(e.questionId), s),
    describe: (e, s) =>
      `${e.questionId} moved from ${who(e.from, s)} to ${who(e.to, s)} (${e.reason})`,
  },
  // Work added to a Waykeeper's project by someone else (the Harmonizer carrying out a card): its
  // own create_task / plan tasks are its own side effects and never get here; a plan's proposed
  // tasks wait for the card's decision instead.
  'task.created': {
    wakes: (e, s) =>
      s.role === 'waykeeper' &&
      e.task.projectId !== undefined &&
      e.task.projectId === s.projectId &&
      e.task.state !== 'proposed',
    describe: (e) =>
      `task ${e.task.id} was added to your project (${e.task.state}, ${e.task.priority}): ${quote(e.task.description)}`,
  },
  'proposal.approved': proposal(() => 'was approved'),
  'proposal.edited': proposal((e) => `was edited: ${JSON.stringify(e.changes)}`),
  'proposal.rejected': proposal((e) => `was rejected${e.reason ? `: ${e.reason}` : ''}`),
  'proposal.parked': proposal((e) => `was parked: ${e.reason}`),
  // The server carried out a promotion card (P2-12): its owner reports it, and the Waykeeper that
  // runs the work's project now learns what it took over.
  'promotion.carried_out': {
    wakes: (e, s) =>
      s.ownsProposal(e.proposalId) ||
      (s.role === 'waykeeper' &&
        e.outcome.projectId !== undefined &&
        e.outcome.projectId === s.projectId),
    describe: (e) => {
      const o = e.outcome;
      if (!o.ok) {
        return `promotion ${e.proposalId} of ${o.target.kind} ${o.target.id} could not be carried out: ${o.error ?? 'unknown error'}`;
      }
      const stewards = o.stewardIds?.length
        ? `; its Stewards (${o.stewardIds.join(', ')}) were handed over and resumed`
        : '';
      return (
        `promotion ${e.proposalId} was carried out: ${o.target.kind} ${o.target.id} moved from ` +
        `${o.fromBodyId ?? '?'} to ${o.toBodyId ?? '?'}` +
        (o.projectId ? ` (project ${o.projectId}` : '') +
        (o.waykeeperId ? `, Waykeeper ${o.waykeeperId})` : o.projectId ? ')' : '') +
        stewards
      );
    },
  },
  'agent.finished': ended((e) => `finished${e.result ? `: ${quote(e.result)}` : ''}`),
  'agent.failed': ended((e) => `failed (${e.reason}): ${quote(e.error)}`),
  'agent.stalled': ended((e) => `has been silent for ${Math.round(e.silentForMs / 1000)} s`),
  'control.stop': control('stopped'),
  'control.cancel': control('cancelled'),
  'control.pause': control('paused'),
  'control.resume': control('resumed'),
  'control.edit': control('edited'),
  'control.close': control('closed'),
  'control.archive': control('archived'),
  'control.pin': control('pinned or unpinned'),
  'control.reopen': control('reopened'),
};

/**
 * The line `event` adds to the brain's next turn, or `undefined` when it does not wake the brain.
 * `rules` defaults to `WAKE_RULES`; a brain definition may pass an extended table.
 */
export function wakeLine(
  event: Event,
  scope: WakeScope,
  rules: WakeRules = WAKE_RULES,
): string | undefined {
  const rule = rules[event.type] as WakeRule<EventType> | undefined;
  if (!rule) return undefined;
  const e = event as EventOfType<EventType>;
  return rule.wakes(e, scope) ? rule.describe(e, scope) : undefined;
}
