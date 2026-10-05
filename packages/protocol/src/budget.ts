import { z } from 'zod';
import { Id } from './primitives.js';
import type { Agent, BudgetTarget, Project, Task } from './domain.js';
import type { EventEnvelope } from './events.js';

/**
 * Dollar budgets (P8-01; SPEC decision 18, TECHNOLOGY §5.4): how much an agent has cost, folded
 * from the cost its runtime reports, and how a budgeted project or task stands against its
 * budget. One implementation for the server's projection and every client's fold.
 */

/** The warning threshold when the settings do not say (P8-01). */
export const DEFAULT_BUDGET_WARN_PERCENT = 80;

/**
 * One agent's reported cost (P8-01). Runtimes report a **cumulative** cost per session (P1-08:
 * every SDK turn's result carries the running `total_cost_usd` of the session, and a resumed
 * session continues from its saved total), so the fold keeps the highest figure reported per
 * session — a repeated or resumed report never counts twice — and adds up the sessions: a fresh
 * session (a brain's reset, a fallback after a lost resume) starts its meter at zero.
 */
export const AgentSpend = z.object({
  agentId: Id,
  /** The agent's total: the sum of `sessions`. */
  usd: z.number().nonnegative(),
  /** Whether any report carried a dollar figure; `false`: "cost not reported". */
  reported: z.boolean(),
  /** The session the next report belongs to: the last `agent.spawned`'s `sessionRef`. */
  session: z.string(),
  /** The highest cumulative figure reported per session. */
  sessions: z.record(z.string(), z.number().nonnegative()),
});
export type AgentSpend = z.infer<typeof AgentSpend>;

/** The session key of an `agent.spawned` without a ref: the spawn itself (a meter of its own). */
const sessionKey = (ref: string | undefined, seq: number) => ref ?? `#${seq}`;

/**
 * Folds one event into the agent's spend. Returns the new record, or `undefined` when the event
 * does not change it (another agent's, or no cost). Pure: the server's `agent_spend` table and
 * the web's world use it alike, so a replayed log gives the snapshot's records.
 */
export function foldSpend(
  current: AgentSpend | undefined,
  { seq, event }: Pick<EventEnvelope, 'seq' | 'event'>,
): AgentSpend | undefined {
  switch (event.type) {
    case 'agent.spawned': {
      // A resume of the same session keeps its meter; a new session (or one without a ref, which
      // cannot be a resume) opens a new one.
      const session = sessionKey(event.sessionRef, seq);
      if (current?.session === session) return undefined;
      return current
        ? { ...current, session }
        : { agentId: event.agentId, usd: 0, reported: false, session, sessions: {} };
    }
    case 'agent.idle':
    case 'agent.finished':
    case 'agent.failed': {
      const usd = event.cost?.usd;
      if (usd === undefined || !Number.isFinite(usd)) return undefined;
      const base: AgentSpend = current ?? {
        agentId: event.agentId,
        usd: 0,
        reported: false,
        session: sessionKey(undefined, seq),
        sessions: {},
      };
      const before = base.sessions[base.session];
      if (base.reported && before !== undefined && before >= usd) return undefined;
      const sessions = { ...base.sessions, [base.session]: Math.max(before ?? 0, usd) };
      const total = Object.values(sessions).reduce((a, b) => a + b, 0);
      return { ...base, usd: total, reported: true, sessions };
    }
    default:
      return undefined;
  }
}

export type BudgetLevel = 'none' | 'ok' | 'warning' | 'exceeded';

/** How a project or task stands against its budget (P8-01), as the panel and the server see it. */
export interface BudgetUsage {
  target: BudgetTarget;
  /** Absent: no budget (level `none`). */
  budgetUsd?: number;
  /** The reported cost of every agent that worked on it (a project: its tasks and sub-projects too). */
  spentUsd: number;
  /** How many agents worked on it, and how many of them never reported a dollar figure. */
  agents: number;
  unreported: number;
  /** `false` when agents worked on it but none reported a cost: shown as "cost not reported". */
  reported: boolean;
  level: BudgetLevel;
  /** `spentUsd / budgetUsd`, when there is a budget. */
  fraction?: number;
}

/** What `budgetUsage` reads: the rows (any iterable) and the agents' spend. */
export interface BudgetWorld {
  projects: Iterable<Project>;
  tasks: Iterable<Task>;
  agents: Iterable<Agent>;
  spend: (agentId: Id) => AgentSpend | undefined;
}

/** A project and every sub-project below it (decision 10: a sub-project is part of its parent's project). */
export function projectFamily(projects: Iterable<Project>, projectId: Id): Set<Id> {
  const list = [...projects];
  const family = new Set<Id>([projectId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of list) {
      if (p.parentProjectId && family.has(p.parentProjectId) && !family.has(p.id)) {
        family.add(p.id);
        grew = true;
      }
    }
  }
  return family;
}

/** The agents whose cost counts against `target`: by their current row (a moved task's Steward follows it). */
export function budgetAgents(world: Omit<BudgetWorld, 'spend'>, target: BudgetTarget): Agent[] {
  const agents = [...world.agents];
  if (target.kind === 'task') return agents.filter((a) => a.taskId === target.id);
  const family = projectFamily(world.projects, target.id);
  const taskProject = new Map<Id, Id | undefined>();
  for (const t of world.tasks) taskProject.set(t.id, t.projectId);
  return agents.filter((a) => {
    if (a.projectId !== undefined && family.has(a.projectId)) return true;
    const p = a.taskId !== undefined ? taskProject.get(a.taskId) : undefined;
    return p !== undefined && family.has(p);
  });
}

/** The level of `spentUsd` against `budgetUsd` with the warning at `warnAtPercent`. */
export function budgetLevel(
  spentUsd: number,
  budgetUsd: number | undefined,
  warnAtPercent: number = DEFAULT_BUDGET_WARN_PERCENT,
): BudgetLevel {
  if (budgetUsd === undefined) return 'none';
  if (spentUsd >= budgetUsd) return 'exceeded';
  if (spentUsd >= (budgetUsd * warnAtPercent) / 100) return 'warning';
  return 'ok';
}

/** How `target` stands against its budget (P8-01). An unknown target has no budget and no spend. */
export function budgetUsage(
  world: BudgetWorld,
  target: BudgetTarget,
  warnAtPercent: number = DEFAULT_BUDGET_WARN_PERCENT,
): BudgetUsage {
  const row =
    target.kind === 'project'
      ? [...world.projects].find((p) => p.id === target.id)
      : [...world.tasks].find((t) => t.id === target.id);
  const agents = row ? budgetAgents(world, target) : [];
  let spentUsd = 0;
  let unreported = 0;
  for (const a of agents) {
    const s = world.spend(a.id);
    if (s?.reported) spentUsd += s.usd;
    else unreported++;
  }
  const budgetUsd = row?.budgetUsd;
  return {
    target,
    ...(budgetUsd !== undefined ? { budgetUsd, fraction: spentUsd / budgetUsd } : {}),
    spentUsd,
    agents: agents.length,
    unreported,
    reported: agents.length === 0 || unreported < agents.length,
    level: budgetLevel(spentUsd, budgetUsd, warnAtPercent),
  };
}

/** Dollars as the panel and the notices show them: cents, or four decimals for a smaller amount. */
export function formatUsd(usd: number): string {
  const cents = usd.toFixed(2);
  return `$${usd > 0 && usd < 1 && Math.abs(Number(cents) - usd) > 1e-9 ? usd.toFixed(4) : cents}`;
}
