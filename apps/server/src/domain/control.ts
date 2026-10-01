import type { Actor, ControlAction, ControlTarget, Event, TaskPriority } from '@galactic/protocol';
import { TaskPriority as TaskPrioritySchema } from '@galactic/protocol';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import {
  archiveProject,
  closeProject,
  pinProject,
  reopenProject,
  updateProject,
} from './projects.js';
import { archiveTask, closeTask, pinTask, reopenTask, updateTask } from './tasks.js';

/**
 * Panel actions on tasks and projects (P2-01; SPEC decision 11b, §4.3). Each one is recorded as a
 * `control.*` event — what supervisors' mailboxes pick up (P2-06) — in the same transaction as
 * its domain effect: edit, close, archive, pin and reopen change the rows here. Stop, cancel,
 * pause and resume of a task or project are recorded only; their effect on the agents (and the
 * cascade to supervisors) is P2-14. Actions on an agent go through the runtime, which records them
 * itself, so they are not handled here.
 */

export function recordControl(
  ctx: CommandContext,
  target: ControlTarget,
  action: ControlAction,
  by: Actor,
): void {
  if (target.kind === 'agent') {
    throw new DomainError('invalid', 'agent controls go through the runtime');
  }
  const isProject = target.kind === 'project';
  if (isProject) must(ctx.tables.projects.get(target.id), 'project', target.id);
  else must(ctx.tables.tasks.get(target.id), 'task', target.id);
  const base = { target, by };

  const event = ((): Event => {
    switch (action.action) {
      case 'stop':
        return { type: 'control.stop', ...base };
      case 'cancel':
        return { type: 'control.cancel', ...base };
      case 'pause':
        return { type: 'control.pause', ...base };
      case 'resume':
        return { type: 'control.resume', ...base };
      case 'edit':
        return { type: 'control.edit', ...base, changes: action.changes };
      case 'close':
        return { type: 'control.close', ...base };
      case 'archive':
        return { type: 'control.archive', ...base };
      case 'pin':
        return { type: 'control.pin', ...base, pinned: action.pinned };
      case 'reopen':
        return { type: 'control.reopen', ...base };
    }
  })();
  ctx.emit(event);

  switch (action.action) {
    case 'edit':
      if (isProject) updateProject(ctx, target.id, projectEdit(action.changes));
      else updateTask(ctx, target.id, taskEdit(action.changes));
      return;
    case 'close':
      if (isProject) closeProject(ctx, target.id, by);
      else closeTask(ctx, target.id, by);
      return;
    case 'archive':
      if (isProject) archiveProject(ctx, target.id, by);
      else archiveTask(ctx, target.id, by);
      return;
    case 'pin':
      if (isProject) pinProject(ctx, target.id, action.pinned);
      else pinTask(ctx, target.id, action.pinned);
      return;
    case 'reopen':
      if (isProject) reopenProject(ctx, target.id, by);
      else reopenTask(ctx, target.id, by);
      return;
    default:
      return;
  }
}

/** What the panel may edit (SPEC §4.3): a task's description and priority, a project's name. */
function taskEdit(changes: Record<string, unknown>): {
  description?: string;
  priority?: TaskPriority;
} {
  const out: { description?: string; priority?: TaskPriority } = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'description' && typeof value === 'string') out.description = value;
    else if (key === 'priority' && TaskPrioritySchema.safeParse(value).success) {
      out.priority = value as TaskPriority;
    } else throw new DomainError('invalid', `a task's ${key} cannot be edited that way`);
  }
  return out;
}

function projectEdit(changes: Record<string, unknown>): { name?: string } {
  const out: { name?: string } = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name' && typeof value === 'string' && value.trim()) out.name = value;
    else throw new DomainError('invalid', `a project's ${key} cannot be edited that way`);
  }
  return out;
}
