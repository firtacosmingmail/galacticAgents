import type { WorkState } from '@galactic/protocol';

/**
 * Task and project state derivation (P2-15; SPEC §4.4). A pure function of the facts the log
 * holds about an item — its agents' lifecycles, its user-held open questions, its tasks (for a
 * project) and whether its current state was set explicitly — evaluated as an ordered rule table:
 * the first rule that matches decides, and `keep` means "derivation has no opinion, the row
 * stays as it is". `WorkStateDeriver` (runtime) feeds it and writes the result as a
 * `task.state_changed` / `project.state_changed` without `by`.
 */

/**
 * What derivation needs to know about one agent: its lifecycle reduced to the phases that matter
 * for work states. `running` covers starting, working, stalled and waiting for input (whether the
 * wait blocks on the user is the question's holder, not the agent's state).
 */
export type AgentPhase =
  | 'running'
  | 'idle'
  | 'paused'
  | 'finished'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export const ENDED_PHASES: ReadonlySet<AgentPhase> = new Set<AgentPhase>([
  'finished',
  'failed',
  'stopped',
  'interrupted',
]);

export interface AgentFact {
  phase: AgentPhase;
  /** `seq` of the event that ended it (ended phases only): the latest ended agent speaks last. */
  endedSeq?: number;
}

export interface WorkFacts {
  current: WorkState;
  /**
   * The current state was set explicitly (an event with `by`: a panel action, a supervisor's
   * close, a reopen) and none of the item's agents has been (re)started since. An explicit state
   * holds against derivation until then.
   */
  held: boolean;
  /** Open questions held by the user (`holder.type === 'user'`) asked by the item's agents. */
  userQuestions: number;
  /** A task: its own agents (Stewards). A project: its project-level agents (the Waykeeper). */
  agents: readonly AgentFact[];
  /** A project only: the states of its tasks. */
  tasks?: readonly WorkState[];
}

export type Derived = WorkState | 'keep';

export interface Rule {
  name: string;
  when: (f: WorkFacts) => boolean;
  then: Derived | ((f: WorkFacts) => Derived);
}

/** States derivation never leaves: the user's or a supervisor's decision, changed only explicitly. */
export const STICKY: ReadonlySet<WorkState> = new Set<WorkState>([
  'proposed',
  'completed',
  'archived',
  'moved',
]);

const any = (f: WorkFacts, phase: AgentPhase) => f.agents.some((a) => a.phase === phase);
const anyTask = (f: WorkFacts, ...states: WorkState[]) =>
  (f.tasks ?? []).some((t) => states.includes(t));

/** The most recently ended agent decides once nothing is live (a retry after a failure, …). */
function latestEnded(f: WorkFacts): Derived {
  let latest: AgentFact | undefined;
  for (const a of f.agents) {
    if (!ENDED_PHASES.has(a.phase)) continue;
    if (!latest || (a.endedSeq ?? 0) >= (latest.endedSeq ?? 0)) latest = a;
  }
  switch (latest?.phase) {
    case 'finished':
      return 'awaiting_closure';
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    default:
      // Stopped (by the user or a supervisor) or no agent at all: the stop's own command, or the
      // P2-14 cascade, says what the work is now.
      return 'keep';
  }
}

const sticky: Rule = { name: 'sticky state', when: (f) => STICKY.has(f.current), then: 'keep' };
const blocked: Rule = {
  name: 'user-held question',
  // An explicit failure (a cancel) is not reopened by a question left behind.
  when: (f) => f.userQuestions > 0 && !(f.held && f.current === 'failed'),
  then: 'blocked_on_user',
};
const held: Rule = { name: 'explicit state', when: (f) => f.held, then: 'keep' };

/** Task rules, in precedence order. */
export const TASK_RULES: readonly Rule[] = [
  sticky,
  blocked,
  held,
  { name: 'running agent', when: (f) => any(f, 'running'), then: 'in_progress' },
  { name: 'paused agent', when: (f) => any(f, 'paused'), then: 'paused' },
  // A Steward that ended its turn reported back; its supervisor decides whether it is done (§2.7).
  { name: 'idle agent', when: (f) => any(f, 'idle'), then: 'awaiting_closure' },
  { name: 'latest ended agent', when: () => true, then: latestEnded },
];

const TASK_DONE: ReadonlySet<WorkState> = new Set<WorkState>(['completed', 'archived', 'moved']);

/** Project rules, in precedence order. */
export const PROJECT_RULES: readonly Rule[] = [
  sticky,
  blocked,
  held,
  {
    name: 'work running',
    when: (f) =>
      any(f, 'running') ||
      // A task awaiting closure waits on the Waykeeper, not on the user, and an approved one on
      // its Steward being spawned: the project's work is still in progress.
      anyTask(f, 'approved', 'in_progress', 'blocked_on_user', 'awaiting_closure'),
    then: 'in_progress',
  },
  { name: 'work paused', when: (f) => any(f, 'paused') || anyTask(f, 'paused'), then: 'paused' },
  {
    name: 'work interrupted',
    when: (f) => any(f, 'interrupted') || anyTask(f, 'interrupted'),
    then: 'interrupted',
  },
  {
    // Every task closed: the user is asked "anything else?" (decision 11) and closes the project.
    name: 'all tasks closed',
    when: (f) =>
      (f.tasks ?? []).some((t) => t === 'completed') &&
      (f.tasks ?? []).every((t) => TASK_DONE.has(t)),
    then: 'awaiting_closure',
  },
  { name: 'otherwise', when: () => true, then: 'keep' },
];

/** Evaluates a rule table: the first matching rule's state, or the current one for `keep`. */
export function derive(rules: readonly Rule[], facts: WorkFacts): { state: WorkState; rule: string } {
  for (const rule of rules) {
    if (!rule.when(facts)) continue;
    const out = typeof rule.then === 'function' ? rule.then(facts) : rule.then;
    return { state: out === 'keep' ? facts.current : out, rule: rule.name };
  }
  return { state: facts.current, rule: 'none' };
}

export const deriveTaskState = (facts: WorkFacts) => derive(TASK_RULES, facts).state;
export const deriveProjectState = (facts: WorkFacts) => derive(PROJECT_RULES, facts).state;
