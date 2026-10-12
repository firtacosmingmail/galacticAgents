import {
  isHarnessMeta,
  type Actor,
  type Agent,
  type ControlTarget,
  type Event,
  type Id,
  type Task,
  type WorkState,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { archiveProject } from './projects.js';
import { endProjectRules } from './project-rules.js';
import { FINISHED_WORK, checkTransition, setProjectState, setTaskState } from './states.js';
import { archiveTask } from './tasks.js';

/**
 * What a control action on a task or project does beyond its `control.*` event (P2-14; SPEC
 * decision 11b, §4.3). Two halves:
 *
 *   - the **state** effect, applied here in the same transaction as the event (explicit user
 *     actions set the state; P2-15's derivation handles everything an agent causes);
 *   - the **agent** effect — pausing, resuming or stopping the agents working on the target —
 *     applied afterwards by `Commands.control` through the runtime, on `agentsOf(target)`.
 *
 * And `concernedSupervisors(event)`: the brains whose mailbox a `control.*` event belongs in
 * (P2-06 wires it into its wake rules).
 *
 * The states (proposed SPEC decision 25):
 *
 * | action | task | project |
 * |---|---|---|
 * | pause  | `paused` | `paused`; its running tasks `paused` |
 * | resume | `in_progress` if one of its agents is live, else `approved` | same; its paused tasks likewise |
 * | stop   | `paused` (unfinished: its supervisor or the user restarts it) | `paused`; running tasks `paused` |
 * | cancel | `failed` by the user (`proposed`: `archived`) | `failed` by the user, its unfinished tasks `failed` (`proposed`: `archived`, body freed now) |
 *
 * A cancelled project keeps its body for the retention period like a closed one; the archival
 * job (P2-13) archives it through `archiveProject`, which frees the body (see `retentionDue`).
 */

/** Task states in which a Steward may be running: what pausing or stopping a project halts. */
const RUNNING: ReadonlySet<WorkState> = new Set<WorkState>([
  'approved',
  'in_progress',
  'blocked_on_user',
  'awaiting_closure',
  'interrupted',
]);

export type ControlVerb = 'stop' | 'cancel' | 'pause' | 'resume';

export interface ControlStateOptions {
  /** Whether an agent has a live session (the runtime's view); default: none is live. */
  isLive?: (agentId: Id) => boolean;
}

function tasksOfProject(tables: Tables, projectId: Id): Task[] {
  return tables.tasks.all().filter((t) => t.projectId === projectId);
}

/**
 * The agents working on a target, every one ever recorded (the caller filters the live ones): a
 * task's Stewards; a project's Waykeeper(s) and the Stewards of its tasks. Sub-projects are their
 * own targets and are not included.
 */
export function agentsOf(tables: Tables, target: ControlTarget): Agent[] {
  switch (target.kind) {
    case 'agent': {
      const agent = tables.agents.get(target.id);
      return agent ? [agent] : [];
    }
    case 'task':
      return tables.agents.all().filter((a) => a.taskId === target.id);
    case 'project': {
      const taskIds = new Set(tasksOfProject(tables, target.id).map((t) => t.id));
      return tables.agents
        .all()
        .filter((a) => a.projectId === target.id || (a.taskId && taskIds.has(a.taskId)));
    }
  }
}

function resumedState(tables: Tables, target: ControlTarget, isLive: (id: Id) => boolean) {
  return agentsOf(tables, target).some((a) => isLive(a.id)) ? 'in_progress' : 'approved';
}

function haltTask(ctx: CommandContext, task: Task, by: Actor): void {
  if (RUNNING.has(task.state)) setTaskState(ctx, task.id, 'paused', by);
}

/**
 * The state effect of stop/cancel/pause/resume on a task or project, inside the command that
 * records the `control.*` event. Refused (nothing written) when the target's state does not allow
 * it: a proposal cannot be paused, finished work cannot be paused, stopped or cancelled.
 */
export function applyControlState(
  ctx: CommandContext,
  target: ControlTarget,
  verb: ControlVerb,
  by: Actor,
  opts: ControlStateOptions = {},
): void {
  const isLive = opts.isLive ?? (() => false);
  if (target.kind === 'agent')
    throw new DomainError('invalid', 'agent controls go through the runtime');

  if (target.kind === 'task') {
    const task = must(ctx.tables.tasks.get(target.id), 'task', target.id);
    switch (verb) {
      case 'pause':
      case 'stop':
        if (FINISHED_WORK.has(task.state) || task.state === 'proposed') {
          throw new DomainError('invalid_transition', `task ${task.id} is ${task.state}`);
        }
        if (task.state !== 'paused') checkTransition('task', task.id, task.state, 'paused');
        setTaskState(ctx, task.id, 'paused', by);
        return;
      case 'resume':
        if (task.state !== 'paused') {
          throw new DomainError(
            'invalid_transition',
            `task ${task.id} is ${task.state}, not paused`,
          );
        }
        setTaskState(ctx, task.id, resumedState(ctx.tables, target, isLive), by);
        return;
      case 'cancel':
        if (task.state === 'proposed') archiveTask(ctx, task.id, by);
        else {
          if (FINISHED_WORK.has(task.state)) {
            throw new DomainError('invalid_transition', `task ${task.id} is already ${task.state}`);
          }
          setTaskState(ctx, task.id, 'failed', by);
        }
        return;
    }
  }

  const project = must(ctx.tables.projects.get(target.id), 'project', target.id);
  const tasks = tasksOfProject(ctx.tables, project.id);
  switch (verb) {
    case 'pause':
    case 'stop':
      if (FINISHED_WORK.has(project.state) || project.state === 'proposed') {
        throw new DomainError('invalid_transition', `project ${project.id} is ${project.state}`);
      }
      if (project.state !== 'paused') {
        checkTransition('project', project.id, project.state, 'paused');
      }
      setProjectState(ctx, project.id, 'paused', by);
      for (const task of tasks) haltTask(ctx, task, by);
      return;
    case 'resume':
      if (project.state !== 'paused') {
        throw new DomainError(
          'invalid_transition',
          `project ${project.id} is ${project.state}, not paused`,
        );
      }
      for (const task of tasks.filter((t) => t.state === 'paused')) {
        const to = resumedState(ctx.tables, { kind: 'task', id: task.id }, isLive);
        setTaskState(ctx, task.id, to, by);
      }
      setProjectState(ctx, project.id, resumedState(ctx.tables, target, isLive), by);
      return;
    case 'cancel': {
      if (FINISHED_WORK.has(project.state)) {
        throw new DomainError(
          'invalid_transition',
          `project ${project.id} is already ${project.state}`,
        );
      }
      const subs = ctx.tables.projects
        .all()
        .filter((p) => p.parentProjectId === project.id && !FINISHED_WORK.has(p.state));
      if (subs.length > 0) {
        throw new DomainError(
          'conflict',
          `project ${project.id} has active sub-projects: ${subs.map((p) => p.name).join(', ')}; cancel them first`,
        );
      }
      for (const task of tasks) {
        if (!FINISHED_WORK.has(task.state) && task.state !== 'proposed') {
          setTaskState(ctx, task.id, 'failed', by);
        }
      }
      if (project.state === 'proposed') archiveProject(ctx, project.id, by);
      else {
        setProjectState(ctx, project.id, 'failed', by);
        // A cancelled project's "Allow similar" rules end with it (P9-17, decision 138).
        endProjectRules(ctx, project.id, 'cancelled');
      }
      return;
    }
  }
}

/**
 * The agent effect of a control action on a task or project: which runtime call each of the
 * target's live agents gets. Close also stops them (finished work keeps no agent running; for a
 * project this is the "Waykeeper stopped" of decision 11). Edit, archive, pin and reopen leave the
 * agents alone (archive is refused while anything runs; a reopened project's Waykeeper is
 * respawned by whoever handles the `control.reopen`).
 */
export function agentEffect(action: string): 'pause' | 'resume' | 'stop' | undefined {
  switch (action) {
    case 'pause':
      return 'pause';
    case 'resume':
      return 'resume';
    case 'stop':
    case 'cancel':
    case 'close':
      return 'stop';
    default:
      return undefined;
  }
}

export interface ConcernedOptions {
  /** Keep only agents that can take a mailbox event now (live brains); default: all. */
  isLive?: (agentId: Id) => boolean;
}

/**
 * The supervisors a `control.*` event concerns (TECHNOLOGY §5.2, decision 11b "supervisors are
 * informed so they adjust"): pure over the tables, for P2-06's wake rules. Never the actor itself
 * (a brain is not woken by its own action); an empty list for any other event.
 *
 *   - **agent** target: the agent's supervisor (a Steward's Waykeeper — or the Harmonizer for an
 *     asteroid's Steward —, a Waykeeper's Harmonizer);
 *   - **task** target: the supervisors of its Stewards, and the Waykeeper(s) of its project — for
 *     a standalone task, the Harmonizer;
 *   - **project** target: its Waykeeper(s), their supervisors, and the Harmonizer (who relays
 *     project-level actions to the user, decision 11b); a sub-project's parent Waykeeper too.
 *
 * None for a scene-harness target (`meta.harness`, P4-06): harness rows never wake a brain.
 */
export function concernedSupervisors(
  tables: Tables,
  event: Event,
  opts: ConcernedOptions = {},
): Id[] {
  if (!event.type.startsWith('control.')) return [];
  const { target, by } = event as { target: ControlTarget; by: Actor };
  // The scene harness's rows (P4-06) concern no brain: a fake agent's or harness work's control
  // never wakes a real supervisor (defence in depth: the harness itself logs no `control.*`).
  const row =
    target.kind === 'agent'
      ? tables.agents.get(target.id)
      : target.kind === 'task'
        ? tables.tasks.get(target.id)
        : tables.projects.get(target.id);
  if (isHarnessMeta(row?.meta)) return [];
  const out = new Set<Id>();
  const agents = tables.agents.all();
  const waykeepersOf = (projectId: Id) =>
    agents.filter((a) => a.role === 'waykeeper' && a.projectId === projectId);
  const harmonizers = () => agents.filter((a) => a.role === 'harmonizer');

  switch (target.kind) {
    case 'agent': {
      const supervisor = tables.agents.get(target.id)?.supervisorId;
      if (supervisor) out.add(supervisor);
      break;
    }
    case 'task': {
      const task = tables.tasks.get(target.id);
      for (const a of agents) if (a.taskId === target.id && a.supervisorId) out.add(a.supervisorId);
      if (task?.projectId) for (const w of waykeepersOf(task.projectId)) out.add(w.id);
      else for (const h of harmonizers()) out.add(h.id);
      break;
    }
    case 'project': {
      const project = tables.projects.get(target.id);
      for (const w of waykeepersOf(target.id)) {
        out.add(w.id);
        if (w.supervisorId) out.add(w.supervisorId);
      }
      if (project?.parentProjectId) {
        for (const w of waykeepersOf(project.parentProjectId)) out.add(w.id);
      }
      for (const h of harmonizers()) out.add(h.id);
      break;
    }
  }
  if (by.type === 'agent' && by.id) out.delete(by.id);
  const isLive = opts.isLive;
  return [...out].filter((id) => !isLive || isLive(id));
}

/**
 * Finished projects whose body is still held and that nothing pins — `completed` (closed) or
 * `failed` (cancelled) — with `updatedAt` as an approximation of when they finished. Superseded
 * by `retention.ts` (P2-13), whose `retained(log)` takes the clock from the log and also covers
 * standalone tasks; the archival job uses that one.
 */
export function retentionDue(tables: Tables): { projectId: Id; since: string }[] {
  return tables.projects
    .all()
    .filter((p) => (p.state === 'completed' || p.state === 'failed') && !p.pinned)
    .map((p) => ({ projectId: p.id, since: p.updatedAt }));
}
