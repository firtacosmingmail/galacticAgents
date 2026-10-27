import { randomUUID } from 'node:crypto';
import {
  CLEARABLE_PROJECT_FIELDS,
  LONG_TERM_LIMITS,
  PermissionPolicy,
  applyChanges,
  isLongTerm,
  isDemoBody,
  isRetiredBody,
  type Actor,
  isJobTask,
  type Body,
  type CreateProjectInput,
  type Host,
  type Id,
  type Project,
  type ProjectChanges,
  type ReopenInput,
  type SetLongTermInput,
} from '@galactic/protocol';
import {
  bodyOf,
  checkAssignable,
  checkSubProjectBody,
  moveHost,
  occupy,
  place,
  release,
  retireBody,
} from './bodies.js';
import { unparkWaiting } from './parking.js';
import {
  chooseBody,
  describeRefusal,
  freeBigPlanets,
  hasMoons,
  isBigPlanet,
  longTermPlanet,
  type ChooseOptions,
} from './catalogue.js';
import { withdrawClosureQuestion } from './closure.js';
import { endProjectAreas } from './jobs.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { FINISHED_WORK, checkTransition, setProjectState } from './states.js';
import { effectiveChanges } from './changes.js';
import { policyForWrite, type PolicyWrite } from './permissions.js';
import { handOverProject, type HandOverOptions } from './handover.js';

/**
 * Project commands (P2-01; SPEC §2.7, §3, decision 11, 11b). A project lives on a planet or moon
 * from creation to archival. Closing is the user's call (the Waykeeper only asks for it), archive
 * frees the body, reopen brings the work back on its old body when that is still free.
 */

export type { ProjectChanges };

const hostOf = (projectId: Id): Host => ({ kind: 'project', id: projectId });

/**
 * A policy being written: validated, then floored at the global default unless the write is
 * local or the server sets `autoApproveRemote` (P2-21, `policyForWrite`).
 */
export function parsePolicy(policy: unknown, write: PolicyWrite): PermissionPolicy {
  const parsed = PermissionPolicy.safeParse(policy);
  if (!parsed.success)
    throw new DomainError('invalid', `invalid permission policy: ${parsed.error.message}`);
  return policyForWrite(parsed.data, write);
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

/**
 * Refuses closing or archiving while a sub-project (or, for archive, a task) still runs. A job's
 * hidden task is never finished (P10-03): its job stops with the project instead.
 */
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
      (t) =>
        t.projectId === projectId &&
        !FINISHED_WORK.has(t.state) &&
        t.state !== 'proposed' &&
        !isJobTask(t),
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
    : input.longTerm
      ? chooseBody(ctx, { kind: 'planet', longTerm: true }, opts)
      : chooseBody(ctx, input.kind === 'moon' ? { kind: 'moon' } : { kind: 'planet' }, opts);
  if (!choice.ok) throw new DomainError('conflict', describeRefusal(choice));
  return choice.body;
}

/** A purpose and goals within `LONG_TERM_LIMITS` (Global Constraints), or `invalid`. */
function checkPurposeAndGoals(purpose: string, goals: readonly string[]): void {
  const L = LONG_TERM_LIMITS;
  if (purpose.trim().length === 0 || purpose.length > L.maxPurpose) {
    throw new DomainError('invalid', `a purpose is 1–${L.maxPurpose} characters`);
  }
  if (goals.length > L.maxGoals) {
    throw new DomainError('invalid', `a long-term project has at most ${L.maxGoals} goals`);
  }
  if (goals.some((g) => g.trim().length === 0 || g.length > L.maxGoal)) {
    throw new DomainError('invalid', `each goal is 1–${L.maxGoal} characters`);
  }
}

/** A long-term project is an independent project on a planet (SPEC decision 142). */
function checkLongTermCreate(input: CreateProjectInput): void {
  const longTerm = input.longTerm!;
  checkPurposeAndGoals(longTerm.purpose, longTerm.goals);
  if (input.parentProjectId) {
    throw new DomainError('invalid', 'a sub-project cannot become long-term on its own');
  }
  if (input.kind === 'moon') {
    throw new DomainError('invalid', 'a long-term project lives on a planet, not on a moon');
  }
}

/** `write`: the request's origin, for the policy floor (P2-21); unknown counts as remote. */
export function createProject(
  ctx: CommandContext,
  input: CreateProjectInput,
  opts: ChooseOptions = {},
  write: PolicyWrite = {},
): Project {
  if (!input.workspace.trim()) throw new DomainError('invalid', 'a project needs a workspace');
  if (input.longTerm) checkLongTermCreate(input);
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
  if (input.longTerm && !hasMoons(ctx, body)) {
    throw new DomainError(
      'invalid',
      `a long-term project lives on a planet with moons for its areas, not on ${body.name}`,
    );
  }
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
    ...(input.permissionPolicy
      ? { permissionPolicy: parsePolicy(input.permissionPolicy, write) }
      : {}),
    ...(input.meta ? { meta: input.meta } : {}),
    ...(input.longTerm
      ? { longTerm: true, purpose: input.longTerm.purpose, goals: [...input.longTerm.goals] }
      : {}),
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
 * independent project, decision 10), `permissionPolicy` falls back to the global default. A new
 * policy is floored at the global default unless `write` is local (P2-21). A new parent (or none)
 * hands the project's Waykeeper over in the same command (P2-12, decision 32).
 */
export function updateProject(
  ctx: CommandContext,
  projectId: Id,
  changes: ProjectChanges,
  write: PolicyWrite = {},
  handOver: HandOverOptions = {},
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
  if (defined.permissionPolicy) {
    defined.permissionPolicy = parsePolicy(defined.permissionPolicy, write);
  }
  if (Object.keys(defined).length === 0) return current;
  const project = ctx.tables.projects.upsert({
    ...applyChanges(current, defined),
    updatedAt: ctx.now,
  });
  ctx.emit({ type: 'project.updated', projectId, changes: defined });
  if ('parentProjectId' in defined) handOverProject(ctx, projectId, handOver);
  return project;
}

/**
 * The user closes a project (decision 11): `completed`, the body stays occupied for the retention
 * period (its clock starts now, `retention.ts`; `control.close` also stops the Waykeeper). A
 * planet with an active sub-project moon cannot be closed (SPEC §3.2). An open "anything else?"
 * question of the closure relay is withdrawn (P2-13). A long-term project's jobs stop and its area
 * moons are freed (P10-03).
 */
export function closeProject(ctx: CommandContext, projectId: Id, by: Actor): Project {
  const current = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (current.state === 'completed') {
    throw new DomainError('invalid_transition', `project ${projectId} is already completed`);
  }
  checkTransition('project', projectId, current.state, 'completed');
  checkNothingActive(ctx, projectId, false);
  const project = setProjectState(ctx, projectId, 'completed', by);
  withdrawClosureQuestion(ctx, projectId, 'the project was closed');
  endProjectAreas(ctx, projectId, by, 'the project was closed');
  return project;
}

/**
 * Archives a finished project now (decision 4, 11b) and frees its body (and a long-term
 * project's area moons, its jobs stopped: P10-03). Only finished work is archived, and never while
 * a sub-project or a task still runs (their agents orbit the body).
 */
export function archiveProject(ctx: CommandContext, projectId: Id, by: Actor): Project {
  const current = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (current.state === 'archived') {
    throw new DomainError('invalid_transition', `project ${projectId} is already archived`);
  }
  checkTransition('project', projectId, current.state, 'archived');
  checkNothingActive(ctx, projectId, true);
  const project = setProjectState(ctx, projectId, 'archived', by);
  endProjectAreas(ctx, projectId, by, 'the project was archived');
  const body = bodyOf(ctx, hostOf(projectId));
  if (body) {
    const freed = release(ctx, body);
    // A demo planet goes away with its project (P7-07): retired, never reused.
    if (isDemoBody(freed)) retireBody(ctx, freed);
  }
  return project;
}

export function pinProject(ctx: CommandContext, projectId: Id, pinned: boolean): Project {
  return updateProject(ctx, projectId, { pinned });
}

/** A new body for a reopened project whose old one is taken: the catalogue's choice for its kind. */
function reopenBody(ctx: CommandContext, project: Project, old: Body, opts: ChooseOptions) {
  const choice = project.parentProjectId
    ? chooseBody(ctx, { kind: 'moon', parentProjectId: project.parentProjectId }, opts)
    : chooseBody(ctx, { kind: old.kind === 'moon' ? 'moon' : 'planet' }, opts);
  if (!choice.ok) {
    throw new DomainError(
      'conflict',
      `${old.name} is taken and ${describeRefusal(choice)}; reopen project ${project.id} later`,
    );
  }
  return choice.body;
}

/**
 * Reopens finished work (decision 11b) as `approved`: on its old body if that still hosts it or
 * is free, otherwise on `input.bodyId` or — without one — the catalogue's choice for its kind (a
 * sub-project: a moon of its parent's planet), P2-13. A project that changes body keeps the link
 * in `meta.previousBodyIds` (and the history in the events).
 */
export function reopenProject(
  ctx: CommandContext,
  projectId: Id,
  by: Actor,
  input: ReopenInput = {},
  opts: ChooseOptions = {},
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
  // A retired demo planet is gone (P7-07): the reopened project takes a catalogue body.
  const oldIsFree =
    !isRetiredBody(old) &&
    ((!old.host && !old.movedTo) || (old.host?.kind === 'project' && old.host.id === projectId));
  if (oldIsFree && (!input.bodyId || input.bodyId === old.id)) {
    occupy(ctx, old, host);
  } else {
    const body = input.bodyId
      ? must(ctx.tables.bodies.get(input.bodyId), 'body', input.bodyId)
      : reopenBody(ctx, current, old, opts);
    checkAssignable(body, host);
    // The old body is freed first (the project leaves it), but cards are un-parked only once the
    // project holds its new one: no card is told a body is free that this reopen takes.
    const freesOld = old.host?.kind === 'project' && old.host.id === projectId;
    if (freesOld) release(ctx, old, false);
    place(ctx, body.id, host);
    const previous = current.meta?.['previousBodyIds'];
    const ids = Array.isArray(previous) ? (previous as Id[]) : [];
    updateProject(ctx, projectId, {
      meta: { ...ctx.tables.projects.get(projectId)!.meta, previousBodyIds: [...ids, old.id] },
    });
    if (freesOld) unparkWaiting(ctx, { ...ctx.choose, ...opts });
  }
  return setProjectState(ctx, projectId, 'approved', by);
}

/**
 * The planet a project being made long-term moves to, or `undefined` when it stays (P10-02; SPEC
 * decision 142): on a big planet it stays; else a free big planet; else it stays on a planet with
 * moons (its areas share them); a project on a moon or a moonless planet takes the first free
 * planet with moons, and with none it is refused. A planet whose moons host the project's
 * sub-projects keeps it (they live on its moons, SPEC §3.2).
 */
function longTermMove(ctx: CommandContext, project: Project): Body | undefined {
  const body = must(ctx.tables.bodies.get(project.bodyId), 'body', project.bodyId);
  if (isBigPlanet(ctx, body)) return undefined;
  const onPlanetWithMoons = body.kind === 'planet' && hasMoons(ctx, body);
  const hasSubProjects = ctx.tables.projects
    .all()
    .some((p) => p.parentProjectId === project.id && p.state !== 'archived');
  if (onPlanetWithMoons && hasSubProjects) return undefined;
  const big = freeBigPlanets(ctx)[0];
  if (big) return big;
  if (onPlanetWithMoons) return undefined;
  const planet = longTermPlanet(ctx);
  if (planet) return planet;
  throw new DomainError(
    'conflict',
    `No planet with moons is free; ${project.name} stays as it is until one is.`,
  );
}

/**
 * Makes a project long-term, or edits a long-term project's purpose and goals (P10-02; SPEC
 * decision 142). Refused for a sub-project (it is part of its parent) and for finished work. The
 * three fields are set by one `project.updated` (which also drops a pending closure request, its
 * open "Anything else?" question withdrawn first); a project not on a big planet moves (`moveHost`:
 * its tasks and satellites follow) by `longTermMove`'s rule, all in the caller's transaction. An
 * already long-term project only gets its purpose and goals.
 */
export function setLongTerm(ctx: CommandContext, input: SetLongTermInput): Project {
  const current = must(ctx.tables.projects.get(input.projectId), 'project', input.projectId);
  if (current.parentProjectId) {
    const parent = ctx.tables.projects.get(current.parentProjectId);
    throw new DomainError(
      'invalid',
      `a part of ${parent?.name ?? current.parentProjectId} cannot become long-term on its own`,
    );
  }
  if (FINISHED_WORK.has(current.state)) {
    throw new DomainError(
      'invalid_transition',
      `project ${current.id} is ${current.state}; reopen it first`,
    );
  }
  checkPurposeAndGoals(input.purpose, input.goals);
  const to = isLongTerm(current) ? undefined : longTermMove(ctx, current);
  // A long-term project never starts the "anything else?" flow: one already under way ends here
  // (its open question withdrawn, the Waykeeper's recorded request dropped), in this transaction.
  const converting = !isLongTerm(current);
  if (converting) withdrawClosureQuestion(ctx, current.id, 'the project became long-term');
  const { closureRequest, ...restMeta } = current.meta ?? {};
  // Never `longTerm: false` (a stored 0 reads back as absent): converting only ever sets true.
  const changes = {
    ...(converting ? { longTerm: true as const } : {}),
    purpose: input.purpose,
    goals: [...input.goals],
    ...(converting && closureRequest !== undefined ? { meta: restMeta } : {}),
  } satisfies ProjectChanges;
  const project = ctx.tables.projects.upsert({ ...current, ...changes, updatedAt: ctx.now });
  ctx.emit({ type: 'project.updated', projectId: current.id, changes });
  if (!to) return project;
  moveHost(ctx, hostOf(current.id), to.id);
  return ctx.tables.projects.get(current.id)!;
}
