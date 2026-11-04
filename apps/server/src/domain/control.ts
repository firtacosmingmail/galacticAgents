import type {
  Actor,
  ControlAction,
  ControlTarget,
  Event,
  Id,
  PermissionPolicy,
  TaskEdit,
  TaskPriority,
} from '@galactic/protocol';
import { TaskPriority as TaskPrioritySchema, WORK_NAME_MAX } from '@galactic/protocol';
import { applyControlState, type ControlStateOptions } from './cascade.js';
import { setBudget } from './budgets.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import type { PolicyWrite } from './permissions.js';
import {
  archiveProject,
  closeProject,
  parsePolicy,
  pinProject,
  reopenProject,
  updateProject,
} from './projects.js';
import { archiveTask, closeTask, pinTask, reopenTask, updateTask } from './tasks.js';

/**
 * Panel actions on tasks and projects (P2-01; SPEC decision 11b, §4.3). Each one is recorded as a
 * `control.*` event — what supervisors' mailboxes pick up (P2-06) — in the same transaction as
 * its domain effect: edit, close, archive, pin and reopen change the rows here; stop, cancel,
 * pause and resume set the target's state (`cascade.ts`, P2-14). Their effect on the agents is
 * applied afterwards by `Commands.control` through the runtime. Actions on an agent go through
 * the runtime, which records them itself, so they are not handled here.
 */

export interface RecordControlOptions extends ControlStateOptions {
  /** The request's origin, for an edit's permission policy (P2-21); unknown counts as remote. */
  write?: PolicyWrite;
}

export function recordControl(
  ctx: CommandContext,
  target: ControlTarget,
  action: ControlAction,
  by: Actor,
  opts: RecordControlOptions = {},
): void {
  if (target.kind === 'agent') {
    throw new DomainError('invalid', 'agent controls go through the runtime');
  }
  const isProject = target.kind === 'project';
  if (isProject) must(ctx.tables.projects.get(target.id), 'project', target.id);
  else must(ctx.tables.tasks.get(target.id), 'task', target.id);
  const base = { target, by };
  // An edit is checked (and its policy floored, P2-21) before anything is recorded, so
  // `control.edit` carries what is applied, not what was asked.
  const edit = action.action === 'edit' ? action.changes : undefined;
  // The budget (P8-01) is set by `setBudget` (its own event and remote rule), not by the row edit.
  const budget = edit && 'budgetUsd' in edit ? budgetEdit(edit['budgetUsd']) : undefined;
  const rest = edit && budget !== undefined ? withoutBudget(edit) : edit;
  const projectChanges = rest && isProject ? projectEdit(rest, opts.write ?? {}) : undefined;
  const taskChanges = rest && !isProject ? taskEdit(rest) : undefined;

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
        return {
          type: 'control.edit',
          ...base,
          changes: {
            ...(projectChanges ?? taskChanges)!,
            ...(budget !== undefined ? { budgetUsd: budget } : {}),
          },
        };
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
      if (projectChanges) updateProject(ctx, target.id, projectChanges, opts.write);
      else {
        const { title, ...rest } = taskChanges!;
        updateTask(
          ctx,
          target.id,
          title === undefined ? rest : withTitle(ctx, target.id, rest, title),
        );
      }
      if (budget !== undefined) {
        setBudget(
          ctx,
          { kind: isProject ? 'project' : 'task', id: target.id },
          budget,
          by,
          opts.write,
        );
      }
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
    case 'stop':
    case 'cancel':
    case 'pause':
    case 'resume':
      applyControlState(ctx, target, action.action, by, opts);
      return;
  }
}

/** An edit's budget (P8-01): a positive number of dollars, or `null` to remove it. */
function budgetEdit(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  throw new DomainError(
    'invalid',
    `a budget is a positive amount of dollars, not ${String(value)}`,
  );
}

function withoutBudget(changes: Record<string, unknown>): Record<string, unknown> {
  const { budgetUsd: _budget, ...rest } = changes;
  return rest;
}

interface TaskEditChanges {
  description?: string;
  priority?: TaskPriority;
  /** The display title (P8-24); `null` returns the task to its description. */
  title?: string | null;
}

/**
 * What the panel may edit (SPEC §4.3): a task's description, priority and title (P8-24, decision
 * 150: trimmed, at most `WORK_NAME_MAX` characters; blank or `null` clears it).
 */
function taskEdit(changes: Record<string, unknown>): TaskEditChanges {
  const out: TaskEditChanges = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'description' && typeof value === 'string') out.description = value;
    else if (key === 'priority' && TaskPrioritySchema.safeParse(value).success) {
      out.priority = value as TaskPriority;
    } else if (key === 'title' && (value === null || typeof value === 'string')) {
      out.title = workName(value, 'title') ?? null;
    } else throw new DomainError('invalid', `a task's ${key} cannot be edited that way`);
  }
  return out;
}

/** A rename (P8-24): trimmed, `undefined` when blank, refused beyond `WORK_NAME_MAX`. */
function workName(value: string | null, what: string): string | undefined {
  const name = value?.trim();
  if (!name) return undefined;
  if (name.length > WORK_NAME_MAX) {
    throw new DomainError('invalid', `a ${what} is at most ${WORK_NAME_MAX} characters`);
  }
  return name;
}

/** The task's changes with its `meta.title` set or removed; the rest of `meta` is kept. */
function withTitle(
  ctx: CommandContext,
  taskId: Id,
  changes: Omit<TaskEditChanges, 'title'>,
  title: string | null,
): TaskEdit {
  const current = ctx.tables.tasks.get(taskId)!.meta ?? {};
  if ((current['title'] ?? null) === title) return changes;
  const { title: _old, ...meta } = current;
  return { ...changes, meta: title === null ? meta : { ...meta, title } };
}

/**
 * What the panel may edit on a project: its name and its permission policy (P2-21: floored at the
 * global default unless `write` is local; `null` returns it to the global default).
 */
function projectEdit(
  changes: Record<string, unknown>,
  write: PolicyWrite,
): { name?: string; permissionPolicy?: PermissionPolicy | null } {
  const out: { name?: string; permissionPolicy?: PermissionPolicy | null } = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === 'name' && typeof value === 'string' && value.trim()) {
      out.name = workName(value, 'name')!;
    } else if (key === 'permissionPolicy') {
      out.permissionPolicy = value === null ? null : parsePolicy(value, write);
    } else throw new DomainError('invalid', `a project's ${key} cannot be edited that way`);
  }
  return out;
}
