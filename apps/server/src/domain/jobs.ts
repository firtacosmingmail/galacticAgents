import { randomUUID } from 'node:crypto';
import {
  JobDraft,
  LONG_TERM_LIMITS,
  applyChanges,
  isLongTerm,
  nextOccurrence,
  type Actor,
  type Area,
  type Body,
  type CreateJobInput,
  type Host,
  type Id,
  type Job,
  type JobChanges,
  type JobRule,
  type PermissionRule,
  type Project,
  type RequestOrigin,
  type SetJobStateInput,
  type Task,
  type UpdateJobInput,
} from '@galactic/protocol';
import { containsSecret } from '../runtime/redact.js';
import { checkAssignable, moveAgents, occupy, release } from './bodies.js';
import { bodiesWhere, freeMoons, type Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { unattendedRuleLabel, unattendedRuleRefusal } from './permission-rules.js';
import { cancelQuestion } from './questions.js';
import { FINISHED_WORK } from './states.js';

/**
 * Areas and recurring jobs (P10-03; SPEC decisions 143, 144). A long-term project's business
 * areas live on the moons of its planet: a free moon first, else the project's area moon with the
 * fewest areas (they share it); the moon's host is `{kind: 'areas', id: projectId}`. A job belongs
 * to one area and owns a hidden task on that area's moon (`task.meta.jobId`, ledger ruling R2)
 * whose Stewards are its runs. Every command here runs in the caller's transaction and stamps its
 * rows with `ctx.now`, so the protocol fold builds the same rows.
 */

const areasHost = (projectId: Id): Host => ({ kind: 'areas', id: projectId });

/**
 * Refuses an area whose moon its project no longer holds (closing freed it, P10-03 review): its
 * jobs would run on a moon that may host other work.
 */
function checkAreaHeld(ctx: Reader, area: Area): Area {
  const host = ctx.tables.bodies.get(area.bodyId)?.host;
  if (host?.kind !== 'areas' || host.id !== area.projectId) {
    throw new DomainError(
      'invalid',
      `area ${area.name} has no moon of its project any more; reopen the project to give it one`,
    );
  }
  return area;
}

const sameName = (a: string, b: string): boolean =>
  a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

/** A job by id, or `not_found`. */
export function jobOf(ctx: Reader, jobId: Id): Job {
  return must(ctx.tables.jobs.get(jobId), 'job', jobId);
}

/** An unfinished long-term project, or the refusal. */
function longTermProject(ctx: Reader, projectId: Id, what: string): Project {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (!isLongTerm(project)) throw new DomainError('invalid', `${what} live on long-term projects`);
  if (FINISHED_WORK.has(project.state)) {
    throw new DomainError(
      'invalid_transition',
      `project ${projectId} is ${project.state}; reopen it first`,
    );
  }
  return project;
}

/**
 * The moon a new area of the project on `planetId` takes: the first free moon of the planet, else
 * the planet's project's area moon holding the fewest areas (catalogue order on ties). A moon
 * hosting other work — a sub-project, an independent small project, a "moved to …" marker — is
 * never taken.
 */
export function areaMoonFor(ctx: Reader, planetId: Id): Body {
  const planet = must(ctx.tables.bodies.get(planetId), 'body', planetId);
  const free = freeMoons(ctx, planetId)[0];
  if (free) return free;
  const projectId = planet.host?.kind === 'project' ? planet.host.id : undefined;
  const shared = projectId
    ? bodiesWhere(
        ctx,
        (b) =>
          b.kind === 'moon' &&
          b.parentId === planetId &&
          b.host?.kind === 'areas' &&
          b.host.id === projectId,
      )
    : [];
  if (shared.length === 0) {
    throw new DomainError('conflict', `no moon of ${planet.name} is free for an area`);
  }
  const areas = ctx.tables.areas.all();
  const count = (moon: Body) =>
    areas.filter((a) => a.projectId === projectId && a.bodyId === moon.id).length;
  let best = shared[0]!;
  for (const moon of shared) if (count(moon) < count(best)) best = moon;
  return best;
}

/**
 * The area of the project named `name` (case-insensitively), or — when there is none — what a new
 * one would take: its trimmed name and `areaMoonFor`'s moon. Refuses a bad name, a project at its
 * area limit, a moon-less planet and an existing area whose moon the project no longer holds.
 */
function areaByName(
  ctx: Reader,
  projectId: Id,
  name: string,
): { existing: Area } | { existing?: undefined; moon: Body; trimmed: string } {
  const project = longTermProject(ctx, projectId, 'areas');
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > LONG_TERM_LIMITS.maxAreaName) {
    throw new DomainError(
      'invalid',
      `an area name is 1–${LONG_TERM_LIMITS.maxAreaName} characters`,
    );
  }
  const areas = ctx.tables.areas.all().filter((a) => a.projectId === projectId);
  const existing = areas.find((a) => sameName(a.name, trimmed));
  if (existing) return { existing: checkAreaHeld(ctx, existing) };
  if (areas.length >= LONG_TERM_LIMITS.maxAreasPerProject) {
    throw new DomainError(
      'invalid',
      `a long-term project has at most ${LONG_TERM_LIMITS.maxAreasPerProject} areas`,
    );
  }
  return { moon: areaMoonFor(ctx, project.bodyId), trimmed };
}

/**
 * Makes an area of a long-term project, or returns the one already named so (names are unique per
 * project, case-insensitively). The area takes `areaMoonFor`'s moon, whose host becomes the
 * project's areas (`body.assigned`).
 */
export function createArea(ctx: CommandContext, projectId: Id, name: string): Area {
  const found = areaByName(ctx, projectId, name);
  if (found.existing) return found.existing;
  const { moon, trimmed } = found;
  const host = areasHost(projectId);
  checkAssignable(moon, host);
  const area: Area = {
    id: `ar-${randomUUID()}`,
    projectId,
    name: trimmed,
    bodyId: moon.id,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tables.areas.insert(area);
  ctx.emit({ type: 'area.created', area });
  occupy(ctx, moon, host);
  return area;
}

/** The text of a rule a person or a brain wrote (what the secret check reads). */
function ruleTexts(rule: {
  match: JobRule['match'];
  tool: string;
  label?: string | undefined;
}): string[] {
  const m = rule.match;
  const subject =
    m.kind === 'text'
      ? m.text
      : m.kind === 'words'
        ? m.words.join(' ')
        : m.kind === 'folder'
          ? m.folder
          : '';
  return [rule.label ?? '', rule.tool, subject];
}

/**
 * A job draft within the schema and its limits, with nothing that looks like a secret (Global
 * Constraints: credentials are never stored in a job) and only rule shapes "Allow similar" makes
 * (`unattendedRuleRefusal`: no push, no root or home folder, no prefix or category outside the
 * workspace, …), each rule labelled by the server from what it matches (`unattendedRuleLabel`).
 */
function checkedDraft(draft: unknown): JobDraft {
  const parsed = JobDraft.safeParse(draft);
  if (!parsed.success) {
    throw new DomainError('invalid', `invalid job: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  const job = parsed.data;
  if (!job.name.trim()) throw new DomainError('invalid', 'a job needs a name');
  if (!job.instructions.trim()) throw new DomainError('invalid', 'a job needs instructions');
  job.unattendedRules.forEach((rule, i) => {
    const refusal = unattendedRuleRefusal(rule);
    if (refusal) throw new DomainError('invalid', `unattended rule ${i + 1}: ${refusal}`);
  });
  const texts = [job.name, job.instructions, ...job.unattendedRules.flatMap(ruleTexts)];
  if (texts.some((t) => containsSecret(t))) {
    throw new DomainError(
      'invalid',
      'the job contains what looks like a secret: a job never stores credentials — keep them in the environment or a file the job reads',
    );
  }
  // The card shows what each rule allows in the server's words, never the proposer's (I2).
  return {
    ...job,
    unattendedRules: job.unattendedRules.map((r) => ({ ...r, label: unattendedRuleLabel(r) })),
  };
}

/** The part of a rule that says what it allows: two rules alike in it are the same grant. */
const ruleShape = (r: Pick<JobRule, 'scope' | 'tool' | 'match' | 'categories'>) =>
  JSON.stringify([r.scope, r.tool, r.match, [...r.categories].sort()]);

/**
 * A draft's rules as the job stores them (labelled by `checkedDraft`). A rule alike in what it
 * allows to one the job has (`kept`) is that rule — its id and origin stay; any other is a new
 * grant, with a new id (unless the draft names one the job does not have) and the approval's
 * `origin`.
 */
function storedRules(
  drafts: JobDraft['unattendedRules'],
  kept: readonly JobRule[] = [],
  origin?: RequestOrigin,
): JobRule[] {
  const free = [...kept];
  return drafts.map((d) => {
    const at = free.findIndex((k) => ruleShape(k) === ruleShape(d));
    const same = at >= 0 ? free.splice(at, 1)[0] : undefined;
    const { id: _id, label, ...shape } = d;
    const id = same?.id ?? (d.id && !kept.some((k) => k.id === d.id) ? d.id : `r-${randomUUID()}`);
    const from = same ? same.origin : origin;
    return { ...shape, id, label: label ?? '', ...(from ? { origin: from } : {}) };
  });
}

/** Whether `drafts` grant anything `current` does not: a new rule, or one widened or changed. */
export function grantsNewRules(
  drafts: JobDraft['unattendedRules'],
  current: readonly JobRule[] = [],
): boolean {
  const have = new Set(current.map(ruleShape));
  return drafts.some((d) => !have.has(ruleShape(d)));
}

/**
 * A job's unattended rules as the permission gate takes them (P10-04, decision 144): rule-shaped,
 * so the gate never lets one override a deny or allow a push; each with the origin of the approval
 * that granted it (a rule granted before origins were kept reads as local, as it did).
 */
export function unattendedPermissionRules(job: Job, projectId: Id): PermissionRule[] {
  return job.unattendedRules.map(({ origin, ...r }) => ({
    ...r,
    projectId,
    createdBy: { type: 'user' },
    createdAt: job.createdAt,
    origin: origin ?? 'local',
  }));
}

const taskDescription = (name: string) => `Recurring job: ${name}`;

const nextRunAfter = (job: Pick<Job, 'schedule'>, now: string): string =>
  nextOccurrence(job.schedule, new Date(now)).toISOString();

function checkRoomIn(ctx: Reader, areaId: Id): void {
  const jobs = ctx.tables.jobs.all().filter((j) => j.areaId === areaId).length;
  if (jobs >= LONG_TERM_LIMITS.maxJobsPerArea) {
    throw new DomainError('invalid', `an area has at most ${LONG_TERM_LIMITS.maxJobsPerArea} jobs`);
  }
}

/** An area of the project, or the refusal. */
function areaOf(ctx: Reader, projectId: Id, areaId: Id): Area {
  const area = must(ctx.tables.areas.get(areaId), 'area', areaId);
  if (area.projectId !== projectId) {
    throw new DomainError('invalid', `area ${areaId} is not an area of project ${projectId}`);
  }
  return checkAreaHeld(ctx, area);
}

/**
 * Where a new job of the project would go, without writing (a job card's moon line, P10-06): an
 * area given by id, or by the name of an existing area (case-insensitively), is that area on its
 * moon; a new name gets the moon `areaMoonFor` picks now. Refused like `createArea`.
 */
export function previewJobArea(
  ctx: Reader,
  projectId: Id,
  area: { areaId: Id } | { name: string },
): { area: { areaId: Id } | { name: string }; moonId: Id } {
  longTermProject(ctx, projectId, 'jobs');
  if ('areaId' in area) {
    const found = areaOf(ctx, projectId, area.areaId);
    return { area: { areaId: found.id }, moonId: found.bodyId };
  }
  const found = areaByName(ctx, projectId, area.name);
  return found.existing
    ? { area: { areaId: found.existing.id }, moonId: found.existing.bodyId }
    : { area: { name: found.trimmed }, moonId: found.moon.id };
}

/**
 * Every check `createJob` makes, without writing (a job card is checked before it exists, P10-06):
 * a long-term project, a valid draft (no push rule, no secret), and an area with room — an
 * existing one, or a new name within the limits with a moon to take. Returns the parsed draft.
 */
export function checkJobCreate(
  ctx: Reader,
  input: Pick<CreateJobInput, 'projectId' | 'area' | 'draft'>,
): JobDraft {
  const project = longTermProject(ctx, input.projectId, 'jobs');
  const draft = checkedDraft(input.draft);
  if ('areaId' in input.area) {
    checkRoomIn(ctx, areaOf(ctx, project.id, input.area.areaId).id);
  } else {
    const found = areaByName(ctx, project.id, input.area.name);
    if (found.existing) checkRoomIn(ctx, found.existing.id);
  }
  return draft;
}

/**
 * Makes a recurring job of a long-term project in an existing area or a new one made by name (an
 * existing name is reused), with its hidden task on the area's moon (`approved`, `meta.jobId`).
 * Its first run is due at the schedule's next occurrence after now.
 */
export function createJob(ctx: CommandContext, input: CreateJobInput): { job: Job; area: Area } {
  const draft = checkJobCreate(ctx, input);
  const project = longTermProject(ctx, input.projectId, 'jobs');
  const area =
    'areaId' in input.area
      ? areaOf(ctx, project.id, input.area.areaId)
      : createArea(ctx, project.id, input.area.name);
  const jobId = `j-${randomUUID()}`;
  const task: Task = {
    id: `t-${randomUUID()}`,
    projectId: project.id,
    bodyId: area.bodyId,
    description: taskDescription(draft.name),
    priority: 'normal',
    blockedBy: [],
    state: 'approved',
    createdAt: ctx.now,
    updatedAt: ctx.now,
    meta: { jobId },
  };
  ctx.tables.tasks.insert(task);
  ctx.emit({ type: 'task.created', task });
  const job: Job = {
    id: jobId,
    projectId: project.id,
    areaId: area.id,
    taskId: task.id,
    name: draft.name,
    instructions: draft.instructions,
    schedule: draft.schedule,
    provider: draft.provider,
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.followUpProvider ? { followUpProvider: draft.followUpProvider } : {}),
    ...(draft.followUpModel ? { followUpModel: draft.followUpModel } : {}),
    unattendedRules: storedRules(draft.unattendedRules, [], input.origin),
    state: 'active',
    nextRunAt: nextRunAfter(draft, ctx.now),
    followUps: [],
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tables.jobs.insert(job);
  ctx.emit({ type: 'job.created', job });
  return { job, area };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Writes the job's changes (`job.updated`); nothing changed is a no-op. */
export function writeJob(ctx: CommandContext, current: Job, changes: JobChanges): Job {
  if (Object.keys(changes).length === 0) return current;
  const job = ctx.tables.jobs.upsert({ ...applyChanges(current, changes), updatedAt: ctx.now });
  ctx.emit({ type: 'job.updated', jobId: current.id, changes });
  return job;
}

/** Points the job's hidden task (and its Steward, if one runs) at another moon or name. */
function updateJobTask(ctx: CommandContext, job: Job, bodyId: Id, name: string): void {
  const task = must(ctx.tables.tasks.get(job.taskId), 'task', job.taskId);
  const changes = {
    ...(task.bodyId !== bodyId ? { bodyId } : {}),
    ...(task.description !== taskDescription(name) ? { description: taskDescription(name) } : {}),
  };
  if (Object.keys(changes).length === 0) return;
  ctx.tables.tasks.upsert({ ...task, ...changes, updatedAt: ctx.now });
  ctx.emit({ type: 'task.updated', taskId: task.id, changes });
  if (changes.bodyId) moveAgents(ctx, { kind: 'task', id: task.id }, task.bodyId, bodyId);
}

/**
 * Edits a job: its name, instructions, schedule, provider or unattended rules (checked like a new
 * job's), or its area (`areaId`: its task moves to that area's moon). A new schedule recomputes
 * the next run unless the job is stopped.
 */
export function updateJob(ctx: CommandContext, input: UpdateJobInput): Job {
  const { current, changes, area } = planJobUpdate(ctx, input);
  const job = writeJob(ctx, current, changes);
  const bodyId = area?.bodyId ?? must(ctx.tables.tasks.get(job.taskId), 'task', job.taskId).bodyId;
  updateJobTask(ctx, job, bodyId, job.name);
  return job;
}

/** A job's editable fields, as a draft (what a change card shows as "before"). */
export function draftOf(job: Job): JobDraft {
  return {
    name: job.name,
    instructions: job.instructions,
    schedule: job.schedule,
    provider: job.provider,
    ...(job.model !== undefined ? { model: job.model } : {}),
    ...(job.followUpProvider !== undefined ? { followUpProvider: job.followUpProvider } : {}),
    ...(job.followUpModel !== undefined ? { followUpModel: job.followUpModel } : {}),
    unattendedRules: job.unattendedRules,
  };
}

/**
 * What `updateJob` would write, without writing (also how a change card is checked, P10-06): the
 * job, the job as the change leaves it (`merged`, checked like a new job), the changed fields and
 * the area it moves to.
 */
export function planJobUpdate(
  ctx: Pick<CommandContext, 'tables' | 'now'>,
  input: Pick<UpdateJobInput, 'jobId' | 'changes' | 'origin'>,
): { current: Job; merged: JobDraft; changes: JobChanges; area?: Area } {
  const current = jobOf(ctx, input.jobId);
  longTermProject(ctx, current.projectId, 'jobs');
  const { areaId, ...draftChanges } = input.changes;
  const base = draftOf(current);
  // A model belongs to its provider: another provider without a new model leaves the default.
  if (draftChanges.provider !== undefined && draftChanges.provider !== current.provider) {
    if (draftChanges.model === undefined) delete base.model;
  }
  if (
    draftChanges.followUpProvider !== undefined &&
    draftChanges.followUpProvider !== (current.followUpProvider ?? current.provider)
  ) {
    if (draftChanges.followUpModel === undefined) delete base.followUpModel;
  }
  const merged = checkedDraft({
    ...base,
    ...Object.fromEntries(Object.entries(draftChanges).filter(([, v]) => v !== undefined)),
  });
  const changes: JobChanges = {};
  if (merged.name !== current.name) changes.name = merged.name;
  if (merged.instructions !== current.instructions) changes.instructions = merged.instructions;
  if (merged.provider !== current.provider) changes.provider = merged.provider;
  if (merged.model !== current.model) changes.model = merged.model ?? null;
  if (merged.followUpProvider !== current.followUpProvider) {
    changes.followUpProvider = merged.followUpProvider ?? null;
  }
  if (merged.followUpModel !== current.followUpModel) {
    changes.followUpModel = merged.followUpModel ?? null;
  }
  if (!same(merged.schedule, current.schedule)) {
    changes.schedule = merged.schedule;
    if (current.state !== 'stopped') changes.nextRunAt = nextRunAfter(merged, ctx.now);
  }
  if (draftChanges.unattendedRules !== undefined) {
    const rules = storedRules(merged.unattendedRules, current.unattendedRules, input.origin);
    if (!same(rules, current.unattendedRules)) changes.unattendedRules = rules;
  }
  let area: Area | undefined;
  if (areaId !== undefined && areaId !== current.areaId) {
    area = areaOf(ctx, current.projectId, areaId);
    checkRoomIn(ctx, area.id);
    changes.areaId = area.id;
  }
  return { current, merged, changes, ...(area ? { area } : {}) };
}

/**
 * Pauses, stops or resumes a job. Stopping clears its next run, drops its queued follow-ups and
 * cancels its open failure question and its open usage-limit question; resuming a paused job
 * makes it due now (a stopped one at its schedule's next occurrence). The same state is a no-op.
 */
export function setJobState(ctx: CommandContext, input: SetJobStateInput): Job {
  const current = jobOf(ctx, input.jobId);
  if (current.state === input.state) return current;
  if (input.state === 'active') {
    longTermProject(ctx, current.projectId, 'jobs');
    checkAreaHeld(ctx, must(ctx.tables.areas.get(current.areaId), 'area', current.areaId));
  }
  const changes: JobChanges = { state: input.state };
  const dropFailureQuestion = () => {
    if (!current.failureQuestionId) return;
    cancelQuestion(
      ctx,
      current.failureQuestionId,
      input.state === 'stopped' ? 'the job was stopped' : 'the job was resumed',
    );
    changes.failureQuestionId = null;
  };
  switch (input.state) {
    case 'stopped':
      if (current.nextRunAt !== undefined) changes.nextRunAt = null;
      if (current.followUps.length > 0) changes.followUps = [];
      if (input.reason) changes.pausedReason = input.reason;
      else if (current.pausedReason !== undefined) changes.pausedReason = null;
      dropFailureQuestion();
      // Its usage-limit question is moot (P11-13): withdrawn if open, a pending wait or switch
      // dropped. A paused job keeps it.
      if (current.limitQuestionId) {
        cancelQuestion(ctx, current.limitQuestionId, 'the job was stopped');
        changes.limitQuestionId = null;
      }
      break;
    case 'paused':
      if (input.reason) changes.pausedReason = input.reason;
      break;
    case 'active':
      changes.nextRunAt = current.state === 'paused' ? ctx.now : nextRunAfter(current, ctx.now);
      if (current.pausedReason !== undefined) changes.pausedReason = null;
      dropFailureQuestion();
      break;
  }
  return writeJob(ctx, current, changes);
}

/**
 * A long-term project closes, is cancelled or is archived (SPEC decision 143): every job stops and every area
 * moon is freed (`body.freed`). Its area rows stay, as the history of where they lived.
 */
export function endProjectAreas(
  ctx: CommandContext,
  projectId: Id,
  by: Actor,
  reason: string,
): void {
  for (const job of ctx.tables.jobs.all()) {
    if (job.projectId === projectId && job.state !== 'stopped') {
      setJobState(ctx, { jobId: job.id, state: 'stopped', by, reason });
    }
  }
  for (const body of ctx.tables.bodies.all()) {
    if (body.host?.kind === 'areas' && body.host.id === projectId) release(ctx, body);
  }
}

/**
 * A long-term project reopens (P10-03 review): every area whose moon it no longer holds takes one
 * again by `areaMoonFor` on the project's (possibly new) planet (one still held on a moon of
 * another planet is freed first) — `area.updated {bodyId}` and
 * `body.assigned` — and its jobs' hidden tasks (and any Steward on them) follow, in the caller's
 * transaction. Areas are taken in creation order; nothing left for one refuses the reopen.
 */
export function retakeAreaMoons(ctx: CommandContext, projectId: Id): void {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  const host = areasHost(projectId);
  const areas = ctx.tables.areas
    .all()
    .filter((a) => a.projectId === projectId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const area of areas) {
    const held = ctx.tables.bodies.get(area.bodyId);
    if (held?.host?.kind === 'areas' && held.host.id === projectId) {
      if (held.parentId === project.bodyId) continue;
      // Still held on a moon of a planet the project left (a project cancelled before cancel
      // freed its areas): the moon is freed and the area takes one of its planet's.
      release(ctx, held, false);
    }
    const moon = areaMoonFor(ctx, project.bodyId);
    checkAssignable(moon, host);
    ctx.tables.areas.upsert({ ...area, bodyId: moon.id, updatedAt: ctx.now });
    ctx.emit({ type: 'area.updated', areaId: area.id, changes: { bodyId: moon.id } });
    occupy(ctx, moon, host);
    for (const job of ctx.tables.jobs.all()) {
      if (job.areaId === area.id) updateJobTask(ctx, job, moon.id, job.name);
    }
  }
}
