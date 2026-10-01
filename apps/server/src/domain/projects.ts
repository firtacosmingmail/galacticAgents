import { randomUUID } from 'node:crypto';
import {
  CLEARABLE_PROJECT_FIELDS,
  PermissionPolicy,
  applyChanges,
  type Actor,
  type CreateProjectInput,
  type Host,
  type Id,
  type Project,
  type ProjectChanges,
  type ReopenInput,
} from '@galactic/protocol';
import { bodyOf, checkAssignable, checkSubProjectBody, occupy, place, release } from './bodies.js';
import { chooseBody, describeRefusal, type ChooseOptions } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { FINISHED_WORK, checkTransition, setProjectState } from './states.js';
import { effectiveChanges } from './changes.js';

/**
 * Project commands (P2-01; SPEC §2.7, §3, decision 11, 11b). A project lives on a planet or moon
 * from creation to archival. Closing is the user's call (the Waykeeper only asks for it), archive
 * frees the body, reopen brings the work back on its old body when that is still free.
 */

export type { ProjectChanges };

const hostOf = (projectId: Id): Host => ({ kind: 'project', id: projectId });

function parsePolicy(policy: unknown): PermissionPolicy {
  const parsed = PermissionPolicy.safeParse(policy);
  if (!parsed.success)
    throw new DomainError('invalid', `invalid permission policy: ${parsed.error.message}`);
  return parsed.data;
}

/** The parent must exist, still take work, and be neither the project nor one of its descendants. */
function checkParent(ctx: CommandContext, projectId: Id | undefined, parentId: Id): Project {
  const parent = must(ctx.tables.projects.get(parentId), 'project', parentId);
  if (parent.state === 'archived') {
    throw new DomainError('invalid_transition', `project ${parentId} is archived`);
  }
  for (let id: Id | undefined = parentId; id;) {
    if (id === projectId) throw new DomainError('invalid', 'a project cannot be its own ancestor');
    id = ctx.tables.projects.get(id)?.parentProjectId;
  }
  return parent;
}

/** Refuses closing or archiving while a sub-project (or, for archive, a task) still runs. */
function checkNothingActive(ctx: CommandContext, projectId: Id, tasks: boolean): void {
  const subs = ctx.tables.projects
    .all()
    .filter((p) => p.parentProjectId === projectId && !FINISHED_WORK.has(p.state));
  if (subs.length > 0) {
    throw new DomainError(
      'conflict',
      `project ${projectId} has active sub-projects: ${subs.map((p) => p.name).join(', ')}`,
    );
  }
  if (!tasks) return;
  const running = ctx.tables.tasks
    .all()
    .filter(
      (t) => t.projectId === projectId && !FINISHED_WORK.has(t.state) && t.state !== 'proposed',
    );
  if (running.length > 0) {
    throw new DomainError(
      'conflict',
      `project ${projectId} has ${running.length} unfinished task(s)`,
    );
  }
}

/**
 * The catalogue's body for a project created without one (decision 10): a sub-project gets a
 * moon of its parent's planet, an independent project a planet or (with `kind: 'moon'`) a moon.
 * Nothing free is a `conflict` naming the occupants; P2-09 parks the proposal from `chooseBody`.
 */
function pickBody(ctx: CommandContext, input: CreateProjectInput, opts: ChooseOptions) {
  if (input.kind !== undefined && input.kind !== 'planet' && input.kind !== 'moon') {
    throw new DomainError('invalid', `a project lives on a planet or a moon, not a ${input.kind}`);
  }
  const choice = input.parentProjectId
    ? chooseBody(ctx, { kind: 'moon', parentProjectId: input.parentProjectId }, opts)
    : chooseBody(ctx, input.kind === 'moon' ? { kind: 'moon' } : { kind: 'planet' }, opts);
  if (!choice.ok) throw new DomainError('conflict', describeRefusal(choice));
  return choice.body;
}

export function createProject(
  ctx: CommandContext,
  input: CreateProjectInput,
  opts: ChooseOptions = {},
): Project {
  if (!input.workspace.trim()) throw new DomainError('invalid', 'a project needs a workspace');
  const parent = input.parentProjectId
    ? checkParent(ctx, undefined, input.parentProjectId)
    : undefined;
  const id = `p-${randomUUID()}`;
  const host = hostOf(id);
  const body = input.bodyId
    ? must(ctx.tables.bodies.get(input.bodyId), 'body', input.bodyId)
    : pickBody(ctx, input, opts);
  checkAssignable(body, host);
  checkSubProjectBody(body, parent?.bodyId);
  const project: Project = {
    id,
    name: input.name,
    workspace: input.workspace,
    bodyId: body.id,
    state: input.state ?? 'approved',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(input.repoPath ? { repoPath: input.repoPath } : {}),
    ...(input.parentProjectId ? { parentProjectId: input.parentProjectId } : {}),
    ...(input.permissionPolicy ? { permissionPolicy: parsePolicy(input.permissionPolicy) } : {}),
  };
  ctx.tables.projects.insert(project);
  ctx.emit({ type: 'project.created', project });
  occupy(ctx, body, host);
  return project;
}

/**
 * Edits a project's fields (name, workspace, repo path, policy, pin, parent). Its body changes
 * only by `moveHost` and its state only by the state commands. An explicit `null` clears a
 * clearable field (P2-20): `parentProjectId` detaches a sub-project (its moon then hosts an
 * independent project, decision 10), `permissionPolicy` falls back to the global default.
 */
export function updateProject(
  ctx: CommandContext,
  projectId: Id,
  changes: ProjectChanges,
): Project {
  const current = must(ctx.tables.projects.get(projectId), 'project', projectId);
  const defined = effectiveChanges(current, changes, CLEARABLE_PROJECT_FIELDS, 'project');
  if ('bodyId' in defined && defined.bodyId !== current.bodyId) {
    throw new DomainError('invalid', 'a project changes body by moving, not by an update');
  }
  delete defined.bodyId;
  if (defined.workspace !== undefined && !defined.workspace.trim()) {
    throw new DomainError('invalid', 'a project needs a workspace');
  }
  if (defined.parentProjectId) {
    const parent = checkParent(ctx, projectId, defined.parentProjectId);
    const body = must(ctx.tables.bodies.get(current.bodyId), 'body', current.bodyId);
    checkSubProjectBody(body, parent.bodyId);
  }
  if (defined.permissionPolicy) defined.permissionPolicy = parsePolicy(defined.permissionPolicy);
  if (Object.keys(defined).length === 0) return current;
  const project = ctx.tables.projects.upsert({
    ...applyChanges(current, defined),
    updatedAt: ctx.now,
  });
  ctx.emit({ type: 'project.updated', projectId, changes: defined });
  return project;
}

/**
 * The user closes a project (decision 11): `completed`, the body stays occupied for the retention
 * period (P2-13 stops the Waykeeper and starts the timer). A planet with an active sub-project
 * moon cannot be closed (SPEC §3.2).
 */
export function closeProject(ctx: CommandContext, projectId: Id, by: Actor): Project {
  const current = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (current.state === 'completed') {
    throw new DomainError('invalid_transition', `project ${projectId} is already completed`);
  }
  checkTransition('project', projectId, current.state, 'completed');
  checkNothingActive(ctx, projectId, false);
  return setProjectState(ctx, projectId, 'completed', by);
}

/**
 * Archives a finished project now (decision 4, 11b) and frees its body. Only finished work is
 * archived, and never while a sub-project or a task still runs (their agents orbit the body).
 */
export function archiveProject(ctx: CommandContext, projectId: Id, by: Actor): Project {
  const current = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (current.state === 'archived') {
    throw new DomainError('invalid_transition', `project ${projectId} is already archived`);
  }
  checkTransition('project', projectId, current.state, 'archived');
  checkNothingActive(ctx, projectId, true);
  const project = setProjectState(ctx, projectId, 'archived', by);
  const body = bodyOf(ctx, hostOf(projectId));
  if (body) release(ctx, body);
  return project;
}

export function pinProject(ctx: CommandContext, projectId: Id, pinned: boolean): Project {
  return updateProject(ctx, projectId, { pinned });
}

/**
 * Reopens finished work (decision 11b) as `approved`: on its old body if that still hosts it or
 * is free, otherwise on `input.bodyId` (the history keeps the link through the events).
 */
export function reopenProject(
  ctx: CommandContext,
  projectId: Id,
  by: Actor,
  input: ReopenInput = {},
): Project {
  const current = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (!['completed', 'archived', 'failed'].includes(current.state)) {
    throw new DomainError(
      'invalid_transition',
      `project ${projectId} is ${current.state}, not finished`,
    );
  }
  const host = hostOf(projectId);
  const old = must(ctx.tables.bodies.get(current.bodyId), 'body', current.bodyId);
  const oldIsFree =
    (!old.host && !old.movedTo) || (old.host?.kind === 'project' && old.host.id === projectId);
  if (oldIsFree && (!input.bodyId || input.bodyId === old.id)) {
    occupy(ctx, old, host);
  } else {
    if (!input.bodyId) {
      throw new DomainError(
        'conflict',
        `${old.name} is taken; reopen project ${projectId} on another body`,
      );
    }
    const body = must(ctx.tables.bodies.get(input.bodyId), 'body', input.bodyId);
    checkAssignable(body, host);
    if (old.host?.kind === 'project' && old.host.id === projectId) release(ctx, old);
    place(ctx, body.id, host);
  }
  return setProjectState(ctx, projectId, 'approved', by);
}
