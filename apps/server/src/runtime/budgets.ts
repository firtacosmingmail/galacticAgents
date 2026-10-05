import {
  DEFAULT_BUDGET_WARN_PERCENT,
  formatUsd,
  type BudgetTarget,
  type Event,
  type EventOfType,
  type Id,
} from '@galactic/protocol';
import { agentTargets, noticeBudgets, targetName } from '../domain/budgets.js';
import type { EventLog } from '../domain/event-log.js';

/**
 * The budget watcher (P8-01; SPEC decision 18). Folds nothing itself — the spend is the log's
 * projection (`agent_spend`) — but reacts to it: after every cost report, budget change or move
 * of an agent it logs the notices a budgeted project or task is due (`budget.warning` at the
 * settings' threshold, `budget.exceeded` at the budget, each once per budget value), and it posts
 * every notice and every refused spawn in the running Harmonizer's chat as a system line, which
 * the user sees there (a system message never wakes the Harmonizer; the Waykeeper that runs the
 * work is woken by the wake table's `budget.*` rules).
 */

export interface BudgetWatcherOptions {
  log: EventLog;
  /** The running Harmonizer, if any: whose chat gets the notices. */
  harmonizer: () => Id | undefined;
  /** Posts a system line in an agent's chat (the runtime's `send`). */
  post: (agentId: Id, text: string) => void;
  /** The warning threshold, as a percentage of the budget (default 80). */
  warnAtPercent?: number;
  onError?: (error: unknown, context: string) => void;
}

export class BudgetWatcher {
  private warnAt: number;
  private unsubscribe: (() => void) | undefined;
  /** Refused spawns already posted, per target and budget: one chat line until the budget changes. */
  private readonly posted = new Set<string>();

  constructor(private readonly opts: BudgetWatcherOptions) {
    this.warnAt = opts.warnAtPercent ?? DEFAULT_BUDGET_WARN_PERCENT;
  }

  get warnAtPercent(): number {
    return this.warnAt;
  }

  /** A new threshold applies at once: every budgeted target is judged again. */
  set warnAtPercent(value: number) {
    this.warnAt = value;
    this.checkAll();
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.opts.log.subscribe(({ event }) => {
      try {
        this.react(event);
      } catch (error) {
        this.opts.onError?.(error, 'budget watcher');
      }
    });
    this.checkAll();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Logs the notices every budgeted project and task is due (startup, a new threshold). */
  checkAll(): void {
    const { tables } = this.opts.log;
    const targets: BudgetTarget[] = [
      ...tables.projects
        .all()
        .filter((p) => p.budgetUsd !== undefined)
        .map((p) => ({ kind: 'project' as const, id: p.id })),
      ...tables.tasks
        .all()
        .filter((t) => t.budgetUsd !== undefined)
        .map((t) => ({ kind: 'task' as const, id: t.id })),
    ];
    this.notice(targets);
  }

  private notice(targets: BudgetTarget[]): void {
    if (targets.length === 0) return;
    this.opts.log.runCommand((ctx) => noticeBudgets(ctx, targets, this.warnAt));
  }

  private react(event: Event): void {
    const { tables } = this.opts.log;
    switch (event.type) {
      case 'agent.idle':
      case 'agent.finished':
      case 'agent.failed':
        if (event.cost?.usd === undefined) return;
        this.notice(agentTargets(tables, tables.agents.get(event.agentId)));
        return;
      case 'agent.updated':
        // A Steward handed over to another task or project now counts there.
        this.notice(agentTargets(tables, tables.agents.get(event.agentId)));
        return;
      case 'budget.set':
        for (const key of [...this.posted]) {
          if (key.startsWith(`${event.target.kind}:${event.target.id}:`)) this.posted.delete(key);
        }
        this.notice([event.target]);
        return;
      case 'budget.warning':
      case 'budget.exceeded':
      case 'budget.spawn_refused':
        this.post(event);
        return;
      default:
        return;
    }
  }

  private post(
    event: EventOfType<'budget.warning' | 'budget.exceeded' | 'budget.spawn_refused'>,
  ): void {
    const hq = this.opts.harmonizer();
    if (!hq) return;
    const { tables } = this.opts.log;
    const name = targetName(tables, event.target);
    const spent = `${formatUsd(event.spentUsd)} of its ${formatUsd(event.budgetUsd)} budget`;
    let text: string;
    switch (event.type) {
      case 'budget.warning':
        text =
          `Budget warning: ${name} has spent ${spent} ` +
          `(${Math.round((event.spentUsd / event.budgetUsd) * 100)}%; the warning is at ` +
          `${event.warnAtPercent}%). At the budget, new agents for it are refused.`;
        break;
      case 'budget.exceeded':
        text =
          `Budget exceeded: ${name} has spent ${spent}. Its running agents go on, but no new ` +
          'Waykeeper or Steward is started for it until the budget is raised or removed (on its ' +
          'edit form or card).';
        break;
      case 'budget.spawn_refused': {
        const key = `${event.target.kind}:${event.target.id}:${event.budgetUsd}`;
        if (this.posted.has(key)) return;
        this.posted.add(key);
        text =
          `Spawn refused: a new ${event.role}` +
          (event.taskId ? ` for task ${event.taskId}` : event.projectId ? ` for project ${event.projectId}` : '') +
          ` — ${name} has spent ${spent}. Raise or remove the budget to let it start.`;
        break;
      }
    }
    try {
      this.opts.post(hq, text);
    } catch (error) {
      this.opts.onError?.(error, 'budget watcher: post');
    }
  }
}
