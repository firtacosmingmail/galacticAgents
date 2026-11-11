import {
  LAUNCH_FLAGS,
  excerpt,
  formatUsd,
  isJobOwned,
  isJobTask,
  launchOf,
  proposalJobOf,
  proposalLongTermOf,
  proposalPanelOf,
  setOf,
  SUPERSEDED_BY_MESSAGE,
} from '@galactic/protocol';
import type {
  Actor,
  Agent,
  AgentRole,
  BudgetTarget,
  ControlTarget,
  Event,
  EventOfType,
  EventType,
  Id,
  Proposal,
  Question,
  ReplyQuote,
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
 * never an LLM, so they do not enter any brain's mailbox). Likewise `spend` and `publish`
 * approvals (decisions 145, 147: the user's alone) and job-owned questions — findings, failure notices, job spends (P10-05):
 * they belong to a job, not to the agents above its run. The one exception is a finding's
 * "Implement it", which reaches the project's Waykeeper as a system message (`fromFinding`).
 */

/** What a wake rule may ask about the brain's place in the hierarchy (read from the tables). */
export interface WakeScope {
  brainId: Id;
  role: AgentRole;
  /** The project the brain runs (a Waykeeper). */
  projectId?: Id;
  /** `agentId` is directly supervised by the brain. */
  supervises(agentId: Id | undefined): boolean;
  /** `agentId` is the brain's own supervisor (P10-06: the Harmonizer relaying to a Waykeeper). */
  supervisedBy?(agentId: Id | undefined): boolean;
  /** `agentId` is anywhere below the brain in the `supervisorId` chain (direct reports too). */
  below?(agentId: Id | undefined): boolean;
  /** An agent's row, to tell what it was launched with (P12-08). */
  agent?(agentId: Id): Pick<Agent, 'meta'> | undefined;
  /** The brain runs the task: a task of its project, or the task of an agent it supervises. */
  runsTask(taskId: Id): boolean;
  /** The brain runs the project: its own, or one a supervised Waykeeper runs. */
  runsProject(projectId: Id): boolean;
  /** The brain decides on the proposal (the Harmonizer proposes; P2-10 adds plan cards). */
  ownsProposal(proposalId: Id): boolean;
  /** A proposal, to say what its approval did (P10-06: job and long-term cards). */
  proposal?(proposalId: Id): Proposal | undefined;
  question(questionId: Id): Question | undefined;
  /**
   * The control action concerns the brain as a supervisor (P2-14's `concernedSupervisors`): a
   * task's Waykeeper, an asteroid task's Harmonizer, a sub-project's parent Waykeeper.
   */
  concerned?(event: Event): boolean;
  /**
   * The work is active but nobody runs it (P8-01 review): a project in progress without a running
   * Waykeeper, a standalone task without a running Steward — as after a spawn refused for its
   * budget.
   */
  unattended?(target: BudgetTarget): boolean;
  /**
   * The agent is a job run's Steward (P10-04): its end, its stall and the scheduler's stop of it
   * wake no one — the scheduler records the run, and a finished run never wakes the Waykeeper.
   */
  jobRun?(agentId: Id | undefined): boolean;
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
  // Never a permission, a spend or a publish (decisions 7, 145, 147), never a job-owned question.
  if (!q || q.kind !== 'clarification' || isJobOwned(q)) return false;
  if (isBrain(q.holder, scope)) return true;
  return q.meta?.['toUser'] !== true && scope.supervises(q.originAgentId);
}

/**
 * The brain held a clarification at some point (`holders` on its answer or cancellation), or
 * asked the question itself (the Harmonizer's `ask_user`, a Waykeeper's own question) — the asker
 * waits for the answer like any holder.
 */
function heldBefore(holders: readonly Id[] | undefined, scope: WakeScope, q: Question | undefined) {
  // The user's answer to its own launch card (P12-08): the Waykeeper that asked starts the Steward.
  if (q?.kind === 'launch' && q.originAgentId === scope.brainId) return true;
  // Decisions 7, 145, 147: a permission, spend or publish is never a brain's; nor a job-owned one.
  if (q !== undefined && (q.kind !== 'clarification' || isJobOwned(q))) return false;
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
  wakes: (e, s) => {
    const { target, by } = e as unknown as { target: ControlTarget; by: Actor };
    // The scheduler stopping a job run's Steward is no supervisor's news (P10-04).
    if (by.type === 'system' && target.kind === 'agent' && (s.jobRun?.(target.id) ?? false)) {
      return false;
    }
    return targets(target, s) || (s.concerned?.(e as Event) ?? false);
  },
  describe: (e, s) => {
    const { target, by } = e as unknown as { target: ControlTarget; by: Actor };
    const what =
      target.kind === 'agent' && target.id === s.brainId ? 'you' : `${target.kind} ${target.id}`;
    return `${who(by, s)} ${verb} ${what}`;
  },
});

/**
 * An edit that only sets a task's title (P8-24, decision 150): the user's label for the side bar,
 * which no agent works from. A project's name still wakes its Waykeeper: it names the project to
 * the user.
 */
const titleOnly = (changes: Record<string, unknown>) =>
  Object.keys(changes).length > 0 && Object.keys(changes).every((k) => k === 'title');

type EndedType = 'agent.finished' | 'agent.failed' | 'agent.stalled';
const ended = <T extends EndedType>(text: (e: EventOfType<T>) => string): WakeRule<T> => ({
  wakes: (e, s) => {
    const { agentId } = e as EventOfType<EndedType>;
    return s.supervises(agentId) && !(s.jobRun?.(agentId) ?? false);
  },
  describe: (e) => `agent ${(e as EventOfType<EndedType>).agentId} ${text(e)}`,
});

type DecisionType = `proposal.${'approved' | 'edited' | 'rejected' | 'parked' | 'unparked'}`;
const proposal = <T extends DecisionType>(
  text: (e: EventOfType<T>, s: WakeScope) => string,
): WakeRule<T> => ({
  wakes: (e, s) => s.ownsProposal((e as EventOfType<DecisionType>).proposalId),
  describe: (e, s) => `proposal ${(e as EventOfType<DecisionType>).proposalId} ${text(e, s)}`,
});

/**
 * What an approval already did, for the cards whose approval is the whole of it (P10-06): a job
 * card's job was created, changed or stopped; a panel card's panel (P15-05) was added, changed or removed; a conversion card made its project long-term. There
 * is nothing left to create or spawn.
 */
function approvedNote(p: Proposal | undefined): string {
  const job = proposalJobOf(p);
  if (job) {
    const what =
      job.action === 'create'
        ? `the recurring job ${quote(job.draft?.name ?? '')} was created`
        : `job ${job.jobId} was ${job.action === 'stop' ? 'stopped' : 'changed'}`;
    return `: ${what} with the approval`;
  }
  const panel = proposalPanelOf(p);
  if (panel) {
    const title = panel.draft?.title ?? panel.before?.title ?? '';
    const what =
      panel.action === 'create'
        ? `the panel ${quote(title)} was added`
        : `the panel ${quote(title)} was ${panel.action === 'remove' ? 'removed' : 'changed'}`;
    const job = panel.job && 'propose' in panel.job ? ' (and its job, as the card showed)' : '';
    return `: ${what}${job} with the approval`;
  }
  const longTerm = proposalLongTermOf(p);
  if (longTerm?.projectId) {
    return `: project ${longTerm.projectId} is now long-term (moved to a planet with moons if it had to); nothing to create or spawn`;
  }
  return '';
}

const quote = (text: string) => JSON.stringify(text);

/** "question 2 of 3 in set qs-1" for a row of a question set (P8-19). */
function inSet(q: Pick<Question, 'context'>): string {
  const set = setOf(q)!;
  return `question ${set.index + 1} of ${set.total} in set ${set.id}`;
}

/** How much of a quoted line a reply's turn-prompt line repeats (P8-17). */
export const QUOTE_IN_PROMPT = 1_000;

/** What a reply quotes, from the brain's side: "your reply", "agent w-1's question q-3"… */
function replied(r: ReplyQuote, s: WakeScope): string {
  const own = r.sender.type === 'agent' && r.sender.id === s.brainId;
  const whose =
    r.sender.type === 'agent'
      ? own
        ? 'your'
        : `agent ${r.sender.id}'s`
      : `the ${r.sender.type}'s`;
  switch (r.kind) {
    case 'message':
      if (r.sender.type === 'user') return 'their own earlier message';
      return r.sender.type === 'system' ? 'a system notice' : `${whose} message`;
    case 'reply':
      return `${whose} reply`;
    case 'question':
      return `${whose} ${s.question(r.id)?.kind === 'permission' ? 'permission request' : 'question'} ${r.id}`;
    case 'proposal':
      return `${whose} proposal ${r.id}`;
  }
}

/**
 * A budget notice concerns the brain that runs the work (P8-01): the Waykeeper of the project (or
 * of the task's project), or the Harmonizer for an asteroid task it supervises. The Harmonizer is
 * not woken for its Waykeepers' projects: the user already sees the notice in its chat.
 */
const runsBudget = (target: BudgetTarget, s: WakeScope): boolean =>
  target.kind === 'task'
    ? s.runsTask(target.id)
    : s.role === 'waykeeper' && s.runsProject(target.id);

/**
 * A budget raised or removed for work nobody runs (P8-01 review): the Harmonizer is woken so it
 * can start its Waykeeper (or an asteroid's Steward) again — a spawn the old budget refused.
 */
const loosened = (e: EventOfType<'budget.set'>): boolean =>
  e.previousUsd !== undefined && (e.usd === undefined || e.usd > e.previousUsd);
const restartable = (e: EventOfType<'budget.set'>, s: WakeScope): boolean =>
  s.role === 'harmonizer' && loosened(e) && (s.unattended?.(e.target) ?? false);

export const WAKE_RULES: WakeRules = {
  'message.sent': {
    // A user's chat line to the brain, or a report from an agent below it (a direct report, or a
    // sub-project's Waykeeper asking the Harmonizer for closure). The brain's own turn messages
    // are sent by the system and never wake it.
    // A finding's "Implement it" (P10-05) is the one system message that wakes a brain: the
    // project's Waykeeper learns what the user wants planned. The brain's supervisor may pass a
    // request on to it (P10-06: the Harmonizer's `relay_to_waykeeper`).
    wakes: (e, s) =>
      e.agentId === s.brainId &&
      (e.sender.type === 'user' ||
        (e.sender.type === 'system' &&
          (e.fromFinding !== undefined || e.fromPanel !== undefined) &&
          !e.turn) ||
        (e.sender.type === 'agent' &&
          (s.supervises(e.sender.id) ||
            (s.below?.(e.sender.id) ?? false) ||
            (s.supervisedBy?.(e.sender.id) ?? false)))),
    describe: (e, s) => {
      if (e.sender.type === 'system' && e.fromPanel !== undefined) {
        return `the system said: ${quote(e.text)}`;
      }
      if (e.sender.type === 'system') {
        return `the system said (the user answered finding ${e.fromFinding ?? '?'}): ${quote(e.text)}`;
      }
      if (e.sender.type === 'agent' && s.supervisedBy?.(e.sender.id)) {
        return `your supervisor ${who(e.sender, s)} passed on: ${quote(e.text)}`;
      }
      if (e.sender.type !== 'user') return `${who(e.sender, s)} reported: ${quote(e.text)}`;
      const r = e.replyTo;
      if (!r) return `the user said: ${quote(e.text)}`;
      // A reply (P8-17, decision 139): the quoted line rides along, so the brain has its context.
      const quoted = `${replied(r, s)}: ${quote(excerpt(r.text, QUOTE_IN_PROMPT))}`;
      if (r.answered) return `the user answered ${r.id} (${quoted}) by replying: ${quote(e.text)}`;
      const permission =
        r.kind === 'question' && s.question(r.id)?.kind === 'permission'
          ? " — this does not decide the request: only the user's buttons on its card do"
          : '';
      return `the user said (replying to ${quoted}${permission}): ${quote(e.text)}`;
    },
  },
  'question.opened': {
    wakes: (e, s) => concerns(e.question, s),
    // A question-set row (P8-19) says where it sits, so N lines with one set id read as one set.
    describe: (e, s) => {
      const set = setOf(e.question);
      const place = set ? `${inSet(e.question)} ${quote(set.title)}, ` : '';
      return (
        `${who({ type: 'agent', id: e.question.originAgentId }, s)} asked ${e.question.id} ` +
        `(${place}held by ${who(e.question.holder, s)}): ${quote(e.question.context.text)}`
      );
    },
  },
  // Every agent that ever held the question learns it was resolved (SPEC decision 26), so no
  // level keeps waiting; permission questions never had an agent holder.
  'question.answered': {
    // Not the brain in whose chat the user replied to answer it (P8-17): the reply's own
    // `message.sent` tells it, once, with the question quoted.
    wakes: (e, s) =>
      e.repliedIn !== s.brainId &&
      (heldBefore(e.holders, s, s.question(e.questionId)) || concerns(s.question(e.questionId), s)),
    describe: (e, s) => {
      const q = s.question(e.questionId);
      const place = q && setOf(q) ? ` (${inSet(q)})` : '';
      return `${who(e.answeredBy, s)} answered ${e.questionId}${place}: ${quote(e.answer)}`;
    },
  },
  'question.cancelled': {
    wakes: (e, s) =>
      heldBefore(e.holders, s, s.question(e.questionId)) || concerns(s.question(e.questionId), s),
    describe: (e, s) => {
      if (!e.by) return `${e.questionId} was withdrawn (${e.reason})`;
      // A dismissal (P9-14, decision 135): the asker must not wait for an answer.
      const q = s.question(e.questionId);
      const what = q ? ` (${quote(q.context.text)})` : '';
      const mine = q?.originAgentId === s.brainId;
      if (e.reason === SUPERSEDED_BY_MESSAGE) {
        return mine
          ? `${e.questionId}${what} was withdrawn: superseded by the user's message — read ` +
              'their message instead of waiting for an answer'
          : `${e.questionId}${what} was withdrawn: the user wrote to its agent directly — it ` +
              'needs no answer from you any more';
      }
      return (
        `the user dismissed ${e.questionId}${what} without answering — ` +
        (mine
          ? 'do not wait for an answer: carry on with what you know, or ask again if it still matters'
          : 'it needs no answer from you any more')
      );
    },
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
      // A recurring job's hidden task (P10-03) is Mission Control's: it comes with its job card.
      !isJobTask(e.task) &&
      e.task.projectId !== undefined &&
      e.task.projectId === s.projectId &&
      e.task.state !== 'proposed',
    describe: (e) =>
      `task ${e.task.id} was added to your project (${e.task.state}, ${e.task.priority}): ${quote(e.task.description)}`,
  },
  'proposal.approved': proposal(
    (e, s) => `was approved${approvedNote(s.proposal?.(e.proposalId))}`,
  ),
  'proposal.edited': proposal((e) => `was edited: ${JSON.stringify(e.changes)}`),
  'proposal.rejected': proposal((e) => `was rejected${e.reason ? `: ${e.reason}` : ''}`),
  'proposal.parked': proposal((e) => `was parked: ${e.reason}`),
  // P2-09: a body freed and the server un-parked the card; the user decides it again.
  'proposal.unparked': proposal(
    (e) =>
      `is pending again (${e.reason}): it now proposes ${e.proposedBody.bodyId ?? 'a body'} — tell the user they can approve it`,
  ),
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
  'agent.finished': {
    ...ended<'agent.finished'>((e) => `finished${e.result ? `: ${quote(e.result)}` : ''}`),
    describe: (e, s) => {
      const base = `agent ${e.agentId} finished${e.result ? `: ${quote(e.result)}` : ''}`;
      const row = s.agent?.(e.agentId);
      const launch = row ? launchOf(row) : undefined;
      if (!launch) return base;
      const flags = launch.flags.map((f) => LAUNCH_FLAGS[f].cli).join(' ');
      return `${base} (it ran with ${flags}; verify: ${launch.check}, then report the result to the user)`;
    },
  },
  'agent.failed': ended((e) =>
    e.reason === 'limit'
      ? `stopped at its usage limit (${quote(e.error)}): its task is paused and the user is asked to switch model or wait; do not spawn another Steward for it`
      : `failed (${e.reason}): ${quote(e.error)}`,
  ),
  'agent.stalled': ended((e) => `has been silent for ${Math.round(e.silentForMs / 1000)} s`),
  'budget.set': {
    wakes: (e, s) => runsBudget(e.target, s) || restartable(e, s),
    describe: (e, s) =>
      `the budget of ${e.target.kind} ${e.target.id} ` +
      (e.usd !== undefined
        ? `is now ${formatUsd(e.usd)}${e.previousUsd !== undefined ? ` (was ${formatUsd(e.previousUsd)})` : ''}` +
          ' — spawns refused for the budget may be tried again'
        : 'was removed — spawns refused for the budget may be tried again') +
      (restartable(e, s)
        ? e.target.kind === 'project'
          ? `; project ${e.target.id} has no running Waykeeper: if the budget now allows it, ` +
            'spawn_waykeeper for it'
          : `; task ${e.target.id} has no running Steward: if the budget now allows it, ` +
            'spawn_steward for it'
        : ''),
  },
  'budget.warning': {
    wakes: (e, s) => runsBudget(e.target, s),
    describe: (e) =>
      `budget warning: ${e.target.kind} ${e.target.id} has spent ${formatUsd(e.spentUsd)} of ` +
      `its ${formatUsd(e.budgetUsd)} budget (warning at ${e.warnAtPercent}%); at the budget, new ` +
      'Stewards for it are refused',
  },
  'budget.exceeded': {
    wakes: (e, s) => runsBudget(e.target, s),
    describe: (e) =>
      `budget exceeded: ${e.target.kind} ${e.target.id} has spent ${formatUsd(e.spentUsd)} of ` +
      `its ${formatUsd(e.budgetUsd)} budget — new Stewards for it are refused (running ones go ` +
      'on); do not retry a refused spawn until the user raises or removes the budget',
  },
  'control.stop': control('stopped'),
  'control.cancel': control('cancelled'),
  'control.pause': control('paused'),
  'control.resume': control('resumed'),
  'control.edit': {
    ...control<'control.edit'>('edited'),
    wakes: (e, s) => !titleOnly(e.changes) && control<'control.edit'>('edited').wakes(e, s),
  },
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
