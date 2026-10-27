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
  type Project,
  type SetJobStateInput,
  type Task,
  type UpdateJobInput,
} from '@galactic/protocol';
import { containsSecret } from '../runtime/redact.js';
import { checkAssignable, moveAgents, occupy, release } from './bodies.js';
import { bodiesWhere, freeMoons, type Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
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
 * Makes an area of a long-term project, or returns the one already named so (names are unique per
 * project, case-insensitively). The area takes `areaMoonFor`'s moon, whose host becomes the
 * project's areas (`body.assigned`).
 */
export function createArea(ctx: CommandContext, projectId: Id, name: string): Area {
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
  if (existing) return existing;
  if (areas.length >= LONG_TERM_LIMITS.maxAreasPerProject) {
    throw new DomainError(
      'invalid',
      `a long-term project has at most ${LONG_TERM_LIMITS.maxAreasPerProject} areas`,
    );
  }
  const moon = areaMoonFor(ctx, project.bodyId);
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
function ruleTexts(rule: Pick<JobRule, 'label' | 'match' | 'tool'>): string[] {
  const m = rule.match;
  const subject =
    m.kind === 'text'
      ? m.text
      : m.kind === 'words'
        ? m.words.join(' ')
        : m.kind === 'folder'
          ? m.folder
          : '';
  return [rule.label, rule.tool, subject];
}

/**
 * A job draft within the schema and its limits, with no push rule and nothing that looks like a
 * secret (Global Constraints: credentials are never stored in a job). Rules without an id get one.
 */
function checkedDraft(draft: unknown): JobDraft {
  const parsed = JobDraft.safeParse(draft);
  if (!parsed.success) {
    throw new DomainError('invalid', `invalid job: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  const job = parsed.data;
  if (!job.name.trim()) throw new DomainError('invalid', 'a job needs a name');
  if (!job.instructions.trim()) throw new DomainError('invalid', 'a job needs instructions');
  if (job.unattendedRules.some((r) => r.categories.includes('push'))) {
    throw new DomainError('invalid', 'a job never pushes unattended: drop the push rule');
  }
  const texts = [job.name, job.instructions, ...job.unattendedRules.flatMap(ruleTexts)];
  if (texts.some((t) => containsSecret(t))) {
    throw new DomainError(
      'invalid',
      'the job contains what looks like a secret: a job never stores credentials — keep them in the environment or a file the job reads',
    );
  }
  return job;
}

const withRuleIds = (rules: JobDraft['unattendedRules']): JobRule[] =>
  rules.map((r) => ({ ...r, id: r.id ?? `r-${randomUUID()}` }));

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
  return area;
}

/**
 * Makes a recurring job of a long-term project in an existing area or a new one made by name (an
 * existing name is reused), with its hidden task on the area's moon (`approved`, `meta.jobId`).
 * Its first run is due at the schedule's next occurrence after now.
 */
export function createJob(ctx: CommandContext, input: CreateJobInput): { job: Job; area: Area } {
  const project = longTermProject(ctx, input.projectId, 'jobs');
  const draft = checkedDraft(input.draft);
  const area =
    'areaId' in input.area
      ? areaOf(ctx, project.id, input.area.areaId)
      : createArea(ctx, project.id, input.area.name);
  checkRoomIn(ctx, area.id);
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
    unattendedRules: withRuleIds(draft.unattendedRules),
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
function writeJob(ctx: CommandContext, current: Job, changes: JobChanges): Job {
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
  const current = jobOf(ctx, input.jobId);
  longTermProject(ctx, current.projectId, 'jobs');
  const { areaId, ...draftChanges } = input.changes;
  const merged = checkedDraft({
    name: current.name,
    instructions: current.instructions,
    schedule: current.schedule,
    provider: current.provider,
    unattendedRules: current.unattendedRules,
    ...Object.fromEntries(Object.entries(draftChanges).filter(([, v]) => v !== undefined)),
  });
  const changes: JobChanges = {};
  if (merged.name !== current.name) changes.name = merged.name;
  if (merged.instructions !== current.instructions) changes.instructions = merged.instructions;
  if (merged.provider !== current.provider) changes.provider = merged.provider;
  if (!same(merged.schedule, current.schedule)) {
    changes.schedule = merged.schedule;
    if (current.state !== 'stopped') changes.nextRunAt = nextRunAfter(merged, ctx.now);
  }
  if (draftChanges.unattendedRules !== undefined) {
    const rules = withRuleIds(merged.unattendedRules);
    if (!same(rules, current.unattendedRules)) changes.unattendedRules = rules;
  }
  let area: Area | undefined;
  if (areaId !== undefined && areaId !== current.areaId) {
    area = areaOf(ctx, current.projectId, areaId);
    checkRoomIn(ctx, area.id);
    changes.areaId = area.id;
  }
  const job = writeJob(ctx, current, changes);
  const bodyId = area?.bodyId ?? must(ctx.tables.tasks.get(job.taskId), 'task', job.taskId).bodyId;
  updateJobTask(ctx, job, bodyId, job.name);
  return job;
}

/**
 * Pauses, stops or resumes a job. Stopping clears its next run, drops its queued follow-ups and
 * cancels its open failure question; resuming a paused job makes it due now (a stopped one at its
 * schedule's next occurrence). The same state is a no-op.
 */
export function setJobState(ctx: CommandContext, input: SetJobStateInput): Job {
  const current = jobOf(ctx, input.jobId);
  if (current.state === input.state) return current;
  if (input.state === 'active') longTermProject(ctx, current.projectId, 'jobs');
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
 * A long-term project closes or is archived (SPEC decision 143): every job stops and every area
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
