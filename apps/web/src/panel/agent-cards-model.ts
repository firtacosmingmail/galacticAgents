import {
  ENDED_STATES,
  type Agent,
  type ControlBody,
  type Project,
  type Question,
  type StatusRecord,
  type Task,
  type WorkState,
} from '@galactic/protocol';
import type { WorldState } from '../state/reduce.js';

/**
 * The managed-agents cards of the side panel (P25-04, SPEC §4.2): which agents a supervisor
 * manages directly, what each card shows, and which control actions (decision 11b, §4.3) each
 * card offers. Pure, no React: the server decides every action (a refusal is shown on the card),
 * this only keeps impossible buttons off it.
 */

/** The work an agent runs: a Steward's task, a Waykeeper's project. */
export type CardWork = { kind: 'task'; item: Task } | { kind: 'project'; item: Project };

export interface AgentCardModel {
  agent: Agent;
  status: StatusRecord | undefined;
  work: CardWork | undefined;
  /** The agent's session is still running (any state but the ended ones). */
  live: boolean;
  /** "Blocked on user": its work is, or the user holds one of its open questions (SPEC §4.4). */
  blocked: boolean;
  /** Its own open questions, whoever holds them. */
  openQuestions: Question[];
}

const FINISHED: ReadonlySet<WorkState> = new Set(['completed', 'archived', 'failed', 'moved']);
const RUNNING: ReadonlySet<WorkState> = new Set([
  'approved',
  'in_progress',
  'blocked_on_user',
  'awaiting_closure',
  'interrupted',
]);

const isLive = (status: StatusRecord | undefined) =>
  status === undefined || !ENDED_STATES.has(status.state);

const byAge = (a: Agent, b: Agent) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/**
 * The work items a supervisor manages directly (decisions 6 and 32): for the Harmonizer the
 * top-level projects (their Waykeepers) and the standalone tasks (asteroid Stewards); for a
 * Waykeeper its project's tasks (Stewards) and its sub-projects (their Waykeepers). Matched by
 * role and project, never by `supervisorId`, so a replacement Waykeeper sees its predecessor's
 * Stewards (decision 32).
 */
function managedWork(world: WorldState, supervisor: Agent): CardWork[] {
  const projects = Object.values(world.projects);
  const tasks = Object.values(world.tasks);
  if (supervisor.role === 'harmonizer') {
    return [
      ...projects
        .filter((p) => !p.parentProjectId || !world.projects[p.parentProjectId])
        .map((item) => ({ kind: 'project' as const, item })),
      ...tasks.filter((t) => !t.projectId).map((item) => ({ kind: 'task' as const, item })),
    ];
  }
  if (supervisor.role === 'waykeeper' && supervisor.projectId) {
    const own = supervisor.projectId;
    return [
      ...tasks.filter((t) => t.projectId === own).map((item) => ({ kind: 'task' as const, item })),
      ...projects
        .filter((p) => p.parentProjectId === own)
        .map((item) => ({ kind: 'project' as const, item })),
    ];
  }
  return [];
}

function agentsOfWork(world: WorldState, work: CardWork): Agent[] {
  return Object.values(world.agents)
    .filter((a) =>
      work.kind === 'task'
        ? a.role === 'steward' && a.taskId === work.item.id
        : a.role === 'waykeeper' && a.projectId === work.item.id,
    )
    .sort(byAge);
}

function rank(card: AgentCardModel): number {
  if (card.blocked) return 0;
  if (card.live) return 1;
  return 2;
}

/**
 * The cards under a supervisor: every live agent of the work it manages, and for work with no
 * live agent its newest agent (so stopped, finished or failed work keeps its card and its
 * resume / close / archive / reopen actions). Archived work is left out unless asked for.
 * Ordered "blocked on user" first, then running, then ended; oldest first within a rank.
 */
export function managedCards(
  world: WorldState,
  supervisor: Agent | undefined,
  opts: { showArchived?: boolean } = {},
): AgentCardModel[] {
  if (!supervisor || supervisor.role === 'steward') return [];
  const open = Object.values(world.questions).filter((q) => q.status === 'open');
  const cards: AgentCardModel[] = [];
  for (const work of managedWork(world, supervisor)) {
    if (work.item.state === 'archived' && !opts.showArchived) continue;
    const agents = agentsOfWork(world, work);
    const live = agents.filter((a) => isLive(world.statuses[a.id]));
    const shown = live.length > 0 ? live : agents.slice(-1);
    for (const agent of shown) {
      const status = world.statuses[agent.id];
      const mine = open.filter((q) => q.originAgentId === agent.id);
      cards.push({
        agent,
        status,
        work,
        live: isLive(status),
        blocked:
          work.item.state === 'blocked_on_user' || mine.some((q) => q.holder.type === 'user'),
        openQuestions: mine,
      });
    }
  }
  return cards.sort((a, b) => rank(a) - rank(b) || byAge(a.agent, b.agent));
}

/** The running wall clock: extrapolated from `startedAt` while the agent works (TECHNOLOGY §4). */
export function wallClockUsed(status: StatusRecord, now: number): number {
  const ticking = !ENDED_STATES.has(status.state) && status.state !== 'paused';
  if (!ticking) return status.caps.wallClockMs.used;
  const since = now - Date.parse(status.startedAt);
  return Math.max(status.caps.wallClockMs.used, Number.isFinite(since) ? since : 0);
}

/** "42 s", "12 min", "1 h", "1 h 05". */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${String(m % 60).padStart(2, '0')}`;
}

/** Cost so far: dollars when the runtime reports them, else tokens, else nothing yet. */
export function formatCost(status: StatusRecord | undefined): string {
  const cost = status?.costSoFar;
  if (cost?.usd !== undefined) return `$${cost.usd.toFixed(cost.usd < 1 ? 4 : 2)}`;
  const tokens = (cost?.inputTokens ?? 0) + (cost?.outputTokens ?? 0);
  return tokens > 0 ? `${tokens.toLocaleString('en-US')} tokens` : '—';
}

export type ControlAction = ControlBody['action']['action'];

/** One button a card offers; `confirm` asks inline first (the destructive ones). */
export interface CardAction {
  action: ControlAction;
  label: string;
  confirm?: string;
}

/**
 * What the agent itself can be given (`/api/control` on the agent): pause or resume, and stop.
 * Cancelling an agent is the same as stopping it on the server; the card offers cancel on the
 * agent's work instead, where it means something different (decision 28).
 */
export function agentActions(status: StatusRecord | undefined): CardAction[] {
  if (!isLive(status)) return [];
  return [
    status?.state === 'paused'
      ? { action: 'resume', label: 'Resume' }
      : { action: 'pause', label: 'Pause' },
    { action: 'stop', label: 'Stop', confirm: 'Stop this agent? Its work stays unfinished.' },
  ];
}

/**
 * What the agent's task or project can be given, as its state allows (decisions 11b, 28, 41):
 * the same rules as the ops console's controls (P2-18). Pin is always there; edit only while the
 * work is unfinished.
 */
export function workActions(work: CardWork): CardAction[] {
  const { state, pinned } = work.item;
  const what = work.kind;
  const finished = FINISHED.has(state);
  const out: CardAction[] = [];
  if (state === 'paused') out.push({ action: 'resume', label: 'Resume' });
  else if (RUNNING.has(state)) out.push({ action: 'pause', label: 'Pause' });
  if (!finished && state !== 'proposed')
    out.push({
      action: 'stop',
      label: 'Stop',
      confirm: `Stop the ${what}? Its agents are stopped; it stays unfinished.`,
    });
  if (!finished)
    out.push({
      action: 'cancel',
      label: 'Cancel',
      confirm: `Cancel the ${what}? Its agents are stopped and it is marked failed.`,
    });
  if (!finished && state !== 'proposed')
    out.push({
      action: 'close',
      label: 'Close',
      confirm: `Close the ${what} now? Its agents are stopped.`,
    });
  if (state === 'completed' || state === 'failed')
    out.push({
      action: 'archive',
      label: 'Archive now',
      confirm: `Archive the ${what} now? It leaves the panel and frees its body.`,
    });
  out.push({ action: 'pin', label: pinned ? 'Unpin' : 'Pin' });
  if (finished && state !== 'moved') out.push({ action: 'reopen', label: 'Reopen' });
  if (!finished) out.push({ action: 'edit', label: 'Edit' });
  return out;
}
