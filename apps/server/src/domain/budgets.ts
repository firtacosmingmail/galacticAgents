import {
  BudgetUsd,
  budgetUsage,
  foldSpend,
  formatUsd,
  type Actor,
  type Agent,
  type AgentRole,
  type BudgetTarget,
  type BudgetUsage,
  type BudgetWorld,
  type EventEnvelope,
  type Id,
  type Project,
  type Task,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import type { PolicyWrite } from './permissions.js';
import { updateProject } from './projects.js';
import { updateTask } from './tasks.js';

/**
 * Dollar budgets (P8-01; SPEC decision 18, TECHNOLOGY §5.4). A project or task may carry a
 * `budgetUsd`; the reported cost of the agents that worked on it (`agent_spend`, folded from the
 * `agent.*` cost reports) is measured against it. At the settings' threshold the work warns
 * (`budget.warning`), at the budget it is exceeded (`budget.exceeded`): running agents go on —
 * nothing is stopped for money (SPEC decision 98) — but a new spawn for the work is refused
 * (`budget.spawn_refused` plus a `conflict` error to the caller). The Harmonizer is never refused.
 *
 * A cost a runtime does not report counts as nothing: a budget only binds what is metered, and
 * the panel says "cost not reported" for such work.
 */

const label = (t: BudgetTarget) => `${t.kind} ${t.id}`;

/** The rows of `tables` as `budgetUsage` reads them. */
export function budgetWorld(tables: Tables): BudgetWorld {
  return {
    projects: tables.projects.all(),
    tasks: tables.tasks.all(),
    agents: tables.agents.all(),
    spend: (id) => tables.spend.get(id),
  };
}

/**
 * Sets, changes or removes a budget (`usd: null`): the row's `budgetUsd` (`project.updated` /
 * `task.updated`) and `budget.set`, in the caller's transaction. Raising or removing a budget is
 * a loosening: refused for a remote or unknown origin unless `autoApproveRemote` (like decision
 * 37's floor). Setting the same value again changes nothing and logs nothing.
 */
export function setBudget(
  ctx: CommandContext,
  target: BudgetTarget,
  usd: number | null,
  by: Actor,
  write: PolicyWrite = {},
): Project | Task {
  const row: Project | Task =
    target.kind === 'project'
      ? must(ctx.tables.projects.get(target.id), 'project', target.id)
      : must(ctx.tables.tasks.get(target.id), 'task', target.id);
  if (usd !== null && !BudgetUsd.safeParse(usd).success) {
    throw new DomainError('invalid', `a budget is a positive amount of dollars, not ${usd}`);
  }
  const previous = row.budgetUsd;
  if ((usd ?? undefined) === previous) return row;
  const loosening = usd === null || (previous !== undefined && usd > previous);
  if (loosening && write.origin !== 'local' && !write.autoApproveRemote) {
    throw new DomainError(
      'invalid',
      `raising or removing the budget of ${label(target)} works only from this machine ` +
        '(a remote client or an agent may set or lower a budget)',
    );
  }
  const changes = { budgetUsd: usd };
  const next =
    target.kind === 'project'
      ? updateProject(ctx, target.id, changes, write)
      : updateTask(ctx, target.id, changes);
  ctx.emit({
    type: 'budget.set',
    target,
    ...(usd !== null ? { usd } : {}),
    ...(previous !== undefined ? { previousUsd: previous } : {}),
    by,
  });
  return next;
}

/**
 * The in-transaction projection of the budget events (P8-01), run by the event log for every
 * event it inserts: an agent's spend (`foldSpend`) and the notices already given. Pure over its
 * tables: replaying the log rebuilds the same rows.
 */
export function projectBudgetEvent(tables: Tables, envelope: EventEnvelope): void {
  const { event } = envelope;
  switch (event.type) {
    case 'agent.spawned':
    case 'agent.idle':
    case 'agent.finished':
    case 'agent.failed': {
      const next = foldSpend(tables.spend.get(event.agentId), envelope);
      if (next) tables.spend.put(next);
      return;
    }
    case 'budget.set':
      tables.budgetNotices.clear(event.target);
      return;
    case 'budget.warning':
      if (tables.budgetNotices.get(event.target)?.level !== 'exceeded') {
        tables.budgetNotices.put(event.target, 'warning', event.budgetUsd);
      }
      return;
    case 'budget.exceeded':
      tables.budgetNotices.put(event.target, 'exceeded', event.budgetUsd);
      return;
    default:
      return;
  }
}

/**
 * The budgets an agent's cost counts against, nearest first: its task, then its project and every
 * project above it (a sub-project's cost is part of its parent's, decision 10).
 */
export function budgetTargets(
  tables: Pick<Tables, 'projects' | 'tasks'>,
  at: { taskId?: Id | undefined; projectId?: Id | undefined },
): BudgetTarget[] {
  const targets: BudgetTarget[] = [];
  const task = at.taskId ? tables.tasks.get(at.taskId) : undefined;
  if (at.taskId) targets.push({ kind: 'task', id: at.taskId });
  let projectId = at.projectId ?? task?.projectId;
  const seen = new Set<Id>();
  while (projectId && !seen.has(projectId)) {
    seen.add(projectId);
    targets.push({ kind: 'project', id: projectId });
    projectId = tables.projects.get(projectId)?.parentProjectId;
  }
  return targets;
}

/** A spawn the budgets refuse: the exceeded target and the reason the caller gets. */
export interface BudgetRefusal {
  target: BudgetTarget;
  usage: BudgetUsage;
  reason: string;
}

/** What `name` a target goes by in a message: the project's name or the task's description. */
export function targetName(tables: Pick<Tables, 'projects' | 'tasks'>, t: BudgetTarget): string {
  const name =
    t.kind === 'project' ? tables.projects.get(t.id)?.name : tables.tasks.get(t.id)?.description;
  const short = name && name.length > 60 ? `${name.slice(0, 57)}…` : name;
  return short ? `${t.kind} "${short}" (${t.id})` : label(t);
}

/**
 * Whether a new agent for this work is over a budget (P8-01): the first exceeded target, nearest
 * first, or `undefined`. The Harmonizer is never refused (it is no one's work); a Waykeeper or a
 * Steward is refused when its task or any project above it has spent its budget.
 */
export function checkSpawnBudget(
  tables: Tables,
  spawn: { role: AgentRole; taskId?: Id | undefined; projectId?: Id | undefined },
  warnAtPercent?: number,
): BudgetRefusal | undefined {
  if (spawn.role === 'harmonizer') return undefined;
  const targets = budgetTargets(tables, spawn);
  const budgeted = targets.filter((t) =>
    t.kind === 'project'
      ? tables.projects.get(t.id)?.budgetUsd !== undefined
      : tables.tasks.get(t.id)?.budgetUsd !== undefined,
  );
  if (budgeted.length === 0) return undefined;
  const world = budgetWorld(tables);
  for (const target of budgeted) {
    const usage = budgetUsage(world, target, warnAtPercent);
    if (usage.level !== 'exceeded') continue;
    return {
      target,
      usage,
      reason:
        `budget exceeded: ${targetName(tables, target)} has spent ${formatUsd(usage.spentUsd)} ` +
        `of its ${formatUsd(usage.budgetUsd!)} budget, so no new ${spawn.role} is started for it; ` +
        'running agents go on. The user can raise or remove the budget (on the work card, its ' +
        'edit form or by asking the Harmonizer)',
    };
  }
  return undefined;
}

/**
 * Logs the notices `targets` are due (P8-01): `budget.exceeded` once the reported cost reached
 * the budget, else `budget.warning` once it reached `warnAtPercent` — each at most once per
 * budget value (`budget_notices`; a notice given for another budget value does not count, so a
 * budget changed in the same transaction is judged afresh).
 */
export function noticeBudgets(
  ctx: CommandContext,
  targets: BudgetTarget[],
  warnAtPercent: number,
): void {
  const budgeted = targets.filter((t) =>
    t.kind === 'project'
      ? ctx.tables.projects.get(t.id)?.budgetUsd !== undefined
      : ctx.tables.tasks.get(t.id)?.budgetUsd !== undefined,
  );
  if (budgeted.length === 0) return;
  const world = budgetWorld(ctx.tables);
  for (const target of budgeted) {
    const usage = budgetUsage(world, target, warnAtPercent);
    const budgetUsd = usage.budgetUsd!;
    const notice = ctx.tables.budgetNotices.get(target);
    const given = notice && notice.budgetUsd === budgetUsd ? notice.level : undefined;
    if (usage.level === 'exceeded' && given !== 'exceeded') {
      ctx.emit({ type: 'budget.exceeded', target, spentUsd: usage.spentUsd, budgetUsd });
    } else if (usage.level === 'warning' && given === undefined) {
      ctx.emit({
        type: 'budget.warning',
        target,
        spentUsd: usage.spentUsd,
        budgetUsd,
        warnAtPercent,
      });
    }
  }
}

/** The agent's budget targets, by its current row. */
export function agentTargets(tables: Tables, agent: Agent | undefined): BudgetTarget[] {
  if (!agent || agent.role === 'harmonizer') return [];
  return budgetTargets(tables, { taskId: agent.taskId, projectId: agent.projectId });
}
