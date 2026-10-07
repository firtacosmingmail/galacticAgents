import { randomUUID } from 'node:crypto';
import {
  CLEARABLE_DELIVERABLE_FIELDS,
  type AddDeliverableInput,
  type DeliverableEdit,
  type DeliverableWriteOptions,
  applyChanges,
  deliverableShapeError,
  isRunLive,
  type Actor,
  type Deliverable,
  type DeliverableChanges,
  type DeliverableRun,
  type EventEnvelope,
  type Id,
  type OpenAction,
  type RunOutcome,
  type RunSummary,
} from '@galactic/protocol';
import type { Tables } from '../db/tables.js';
import { effectiveChanges } from './changes.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import type { PolicyWrite } from './permissions.js';

/**
 * Deliverable commands (P9-01; SPEC §4.7, decisions 118–134; TECHNOLOGY §9.1). Each runs inside a
 * command's transaction (the one write rule): the row and its `deliverable.*` / `run.*` event
 * together, a `DomainError` refusing both. No file-system work happens here — checking a path,
 * copying a file, starting a process are `DeliverableService`'s and `RunService`'s, done before
 * the command and recorded through it (TECHNOLOGY §9.1 "Commands"). A deliverable never deletes
 * anything (decision 122).
 */

/**
 * How a deliverable write is judged: the request's origin and the server's `autoApproveRemote`
 * (decision 131: adding, editing, removing and restoring by hand are local only unless
 * `autoApproveRemote`), and the `version` the writer saw (a changed row is refused as `stale`).
 */
export type DeliverableWrite = DeliverableWriteOptions & Pick<PolicyWrite, 'autoApproveRemote'>;

/**
 * Outer bounds for any writer. The agents' tighter limits of decision 120 (titles 120 and
 * descriptions 2 000 characters by default, settings `deliverables.declarations`) are applied by
 * `DeliverableService` (P9-04) before it calls the command; the panel's by `AddDeliverableBody`.
 */
const TITLE_MAX = 500;
const DESCRIPTION_MAX = 10_000;

/**
 * The user's own changes come from the Mac unless `autoApproveRemote` (decision 131): refused with
 * `remote_control` (REST 403, the code the routes' own `requireLocal` answers).
 */
function checkOrigin(by: Actor, write: DeliverableWrite, what: string): void {
  if (by.type !== 'user') return;
  if (write.origin === 'local' || write.autoApproveRemote) return;
  throw new DomainError(
    'remote_control',
    `${what} a deliverable works only from this machine (a remote client may view, download ` +
      'and stop a run)',
  );
}

function checkVersion(current: Deliverable, write: DeliverableWrite): void {
  if (write.expectedVersion !== undefined && write.expectedVersion !== current.version) {
    throw new DomainError(
      'stale',
      `deliverable ${current.id} changed (version ${current.version}, not ${write.expectedVersion})`,
    );
  }
}

/** An agent changes only what an agent declared; never the user's or a detected row (decision 120). */
function checkAgentReach(current: Deliverable, by: Actor, what: string): void {
  if (by.type === 'agent' && current.source !== 'agent') {
    throw new DomainError(
      'conflict',
      `deliverable ${current.id} was ${current.source === 'user' ? 'added by the user' : 'detected'}: an agent cannot ${what} it`,
    );
  }
}

/**
 * The supervision rule's second line (decision 120; the tools check it first with `maySupervise`,
 * P9-04): an agent writes only the deliverables of the work it is on — a Steward its own task's,
 * a Waykeeper its project's (the project's own and its tasks'), the Harmonizer standalone tasks'.
 * An agent the log does not know writes nothing.
 */
function checkAgentScope(
  ctx: CommandContext,
  by: Actor,
  target: { projectId?: Id | undefined; taskId?: Id | undefined },
  what: string,
): void {
  if (by.type !== 'agent') return;
  const agent = by.id ? ctx.tables.agents.get(by.id) : undefined;
  if (!agent) {
    throw new DomainError(
      'invalid',
      `no agent ${by.id ?? '(no id)'}: it cannot ${what} a deliverable`,
    );
  }
  const allowed =
    agent.role === 'steward'
      ? target.taskId !== undefined && target.taskId === agent.taskId
      : agent.role === 'waykeeper'
        ? target.projectId !== undefined && target.projectId === agent.projectId
        : agent.role === 'harmonizer'
          ? target.taskId !== undefined && target.projectId === undefined
          : false;
  if (!allowed) {
    const of = target.taskId
      ? `task ${target.taskId}`
      : target.projectId
        ? `project ${target.projectId}`
        : 'nothing';
    const reach =
      agent.role === 'steward'
        ? 'its own task'
        : agent.role === 'waykeeper'
          ? 'its own project'
          : 'standalone tasks';
    throw new DomainError(
      'invalid',
      `agent ${agent.id} cannot ${what} a deliverable of ${of}: a ${agent.role} reaches ${reach} only`,
    );
  }
}

function checkText(title: string | undefined, description: string | null | undefined): void {
  if (title !== undefined && !title.trim()) {
    throw new DomainError('invalid', 'a deliverable needs a title');
  }
  if (title !== undefined && title.length > TITLE_MAX) {
    throw new DomainError('invalid', `a title is at most ${TITLE_MAX} characters`);
  }
  if (typeof description === 'string' && !description.trim()) {
    throw new DomainError('invalid', 'an empty description is cleared with null');
  }
  if (typeof description === 'string' && description.length > DESCRIPTION_MAX) {
    throw new DomainError('invalid', `a description is at most ${DESCRIPTION_MAX} characters`);
  }
}

function checkShape(row: Deliverable): void {
  const error = deliverableShapeError(row);
  if (error) throw new DomainError('invalid', error);
}

/** Adds a deliverable (`deliverable.added`, the whole row) for a project or a task. */
export function addDeliverable(
  ctx: CommandContext,
  input: AddDeliverableInput,
  by: Actor,
  write: DeliverableWrite = {},
): Deliverable {
  checkOrigin(by, write, 'adding');
  const task = input.taskId
    ? must(ctx.tables.tasks.get(input.taskId), 'task', input.taskId)
    : undefined;
  if (task && input.projectId && task.projectId !== input.projectId) {
    throw new DomainError(
      'invalid',
      `task ${task.id} ${task.projectId ? `belongs to project ${task.projectId}` : 'is a standalone task'}`,
    );
  }
  const projectId = task ? task.projectId : input.projectId;
  if (!task && !projectId) {
    throw new DomainError('invalid', 'a deliverable belongs to a project or a task');
  }
  if (projectId) must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (input.source === 'agent' && by.type !== 'agent') {
    throw new DomainError('invalid', 'an agent-declared deliverable is added by its agent');
  }
  if (input.source === 'user' && by.type !== 'user') {
    throw new DomainError('invalid', "a user's deliverable is added by the user");
  }
  checkAgentScope(
    ctx,
    by,
    { ...(projectId ? { projectId } : {}), ...(task ? { taskId: task.id } : {}) },
    'add',
  );
  if (input.detectedKey !== undefined) {
    if (input.source !== 'detected' || !projectId || task) {
      throw new DomainError('invalid', "only a project's detected deliverable has a detected key");
    }
    const existing = ctx.tables.deliverables.detected(projectId, input.detectedKey);
    if (existing) {
      throw new DomainError(
        'conflict',
        `project ${projectId} already has ${input.detectedKey} (${existing.id})`,
      );
    }
  } else if (input.source === 'detected') {
    throw new DomainError('invalid', 'a detected deliverable has a detected key');
  }
  checkText(input.title, input.description);
  const deliverable: Deliverable = {
    id: `d-${randomUUID()}`,
    ...(projectId ? { projectId } : {}),
    ...(task ? { taskId: task.id } : {}),
    kind: input.kind,
    title: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    source: input.source,
    addedBy: by,
    ...(input.location ? { location: input.location } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.detectedKey !== undefined ? { detectedKey: input.detectedKey } : {}),
    version: 1,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(input.meta && Object.keys(input.meta).length > 0 ? { meta: input.meta } : {}),
  };
  checkShape(deliverable);
  const row = ctx.tables.deliverables.insert(deliverable);
  ctx.emit({ type: 'deliverable.added', deliverable: row });
  return row;
}

/** Writes `changes` (already effective) as the row's next version and logs `deliverable.updated`. */
function writeChanges(
  ctx: CommandContext,
  current: Deliverable,
  changes: DeliverableChanges,
): Deliverable {
  const version = current.version + 1;
  const next = { ...applyChanges(current, changes), version, updatedAt: ctx.now };
  checkShape(next);
  const row = ctx.tables.deliverables.upsert(next);
  ctx.emit({ type: 'deliverable.updated', deliverableId: current.id, changes, version });
  return row;
}

/**
 * Edits a deliverable's own fields (`deliverable.updated`, the version bumped). A change that
 * changes nothing is no change: no event, the same version. A removed row is changed only by the
 * system (the merge hook keeps its path true); the user and agents restore it first.
 */
export function updateDeliverable(
  ctx: CommandContext,
  deliverableId: Id,
  edit: DeliverableEdit,
  by: Actor,
  write: DeliverableWrite = {},
): Deliverable {
  checkOrigin(by, write, 'editing');
  const current = must(ctx.tables.deliverables.get(deliverableId), 'deliverable', deliverableId);
  checkVersion(current, write);
  checkAgentReach(current, by, 'edit');
  checkAgentScope(ctx, by, current, 'edit');
  for (const key of ['projectId', 'taskId', 'source', 'addedBy', 'detectedKey', 'version']) {
    if (key in edit) {
      throw new DomainError('invalid', `a deliverable's ${key} is not edited`);
    }
  }
  if (current.removedAt !== undefined && by.type !== 'system') {
    throw new DomainError(
      'invalid_transition',
      `deliverable ${deliverableId} is removed; restore it first`,
    );
  }
  checkText(edit.title, edit.description);
  const { meta: metaPatch, ...fields } = edit;
  const changes: DeliverableChanges = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const old = (current as Record<string, unknown>)[key];
    if (JSON.stringify(old) === JSON.stringify(value)) continue;
    (changes as Record<string, unknown>)[key] = value;
  }
  if (metaPatch) {
    const meta: Record<string, unknown> = { ...(current.meta ?? {}) };
    for (const [key, value] of Object.entries(metaPatch)) {
      if (value === null) delete meta[key];
      else if (value !== undefined) meta[key] = value;
    }
    if (JSON.stringify(meta) !== JSON.stringify(current.meta ?? {})) {
      changes.meta = Object.keys(meta).length > 0 ? meta : null;
    }
  }
  const effective = effectiveChanges(current, changes, CLEARABLE_DELIVERABLE_FIELDS, 'deliverable');
  if (Object.keys(effective).length === 0) return current;
  return writeChanges(ctx, current, effective);
}

/**
 * Removes a deliverable from the lists (`deliverable.removed`): the row stays, marked, for the
 * history and "Show removed"; no file is ever touched (decision 122). An agent removes only what
 * an agent declared (decision 120).
 */
export function removeDeliverable(
  ctx: CommandContext,
  deliverableId: Id,
  by: Actor,
  reason?: string,
  write: DeliverableWrite = {},
): Deliverable {
  checkOrigin(by, write, 'removing');
  const current = must(ctx.tables.deliverables.get(deliverableId), 'deliverable', deliverableId);
  checkVersion(current, write);
  checkAgentReach(current, by, 'remove');
  checkAgentScope(ctx, by, current, 'remove');
  if (current.removedAt !== undefined) {
    throw new DomainError('invalid_transition', `deliverable ${deliverableId} is already removed`);
  }
  const why = reason?.trim() ? reason.trim() : undefined;
  const version = current.version + 1;
  const row = ctx.tables.deliverables.upsert({
    ...current,
    removedAt: ctx.now,
    removedBy: by,
    ...(why ? { removedReason: why } : {}),
    version,
    updatedAt: ctx.now,
  });
  ctx.emit({
    type: 'deliverable.removed',
    deliverableId,
    by,
    ...(why ? { reason: why } : {}),
    version,
  });
  return row;
}

/**
 * Lists a removed deliverable again (`deliverable.restored`; "Show removed" → Restore). An agent
 * restores only what an agent removed (never a row the user removed).
 */
export function restoreDeliverable(
  ctx: CommandContext,
  deliverableId: Id,
  by: Actor,
  write: DeliverableWrite = {},
): Deliverable {
  checkOrigin(by, write, 'restoring');
  const current = must(ctx.tables.deliverables.get(deliverableId), 'deliverable', deliverableId);
  checkVersion(current, write);
  checkAgentReach(current, by, 'restore');
  checkAgentScope(ctx, by, current, 'restore');
  if (current.removedAt === undefined) {
    throw new DomainError('invalid_transition', `deliverable ${deliverableId} is not removed`);
  }
  // What the user removed stays removed until the user restores it (decision 120).
  if (by.type === 'agent' && current.removedBy?.type === 'user') {
    throw new DomainError(
      'conflict',
      `deliverable ${deliverableId} was removed by the user: an agent cannot restore it`,
    );
  }
  const { removedAt: _at, removedBy: _by, removedReason: _reason, ...rest } = current;
  const version = current.version + 1;
  const row = ctx.tables.deliverables.upsert({ ...rest, version, updatedAt: ctx.now });
  ctx.emit({ type: 'deliverable.restored', deliverableId, by, version });
  return row;
}

/** The audit of an open on the Mac (decision 127): `deliverable.opened`, nothing else changes. */
export function recordOpened(
  ctx: CommandContext,
  deliverableId: Id,
  action: OpenAction,
  by: Actor,
): Deliverable {
  const current = must(ctx.tables.deliverables.get(deliverableId), 'deliverable', deliverableId);
  if (current.removedAt !== undefined) {
    throw new DomainError('invalid_transition', `deliverable ${deliverableId} is removed`);
  }
  ctx.emit({ type: 'deliverable.opened', deliverableId, action, by });
  return current;
}

/**
 * A task's deliverables follow it to another project (decision 124): every row of the task,
 * removed ones included, gets the new `projectId` in the moving command's own transaction
 * (`moveTask`, `transferTask` — which a promotion's flow uses after `createPromotedProject`).
 */
export function carryTaskDeliverables(ctx: CommandContext, taskId: Id, toProjectId: Id): void {
  for (const d of ctx.tables.deliverables.of({ taskId })) {
    if (d.projectId === toProjectId) continue;
    writeChanges(ctx, d, { projectId: toProjectId });
  }
}

// -- runs ------------------------------------------------------------------------------------

export interface RunStartInput {
  /** The run's id, chosen by the run service before the fork (its PID row and marker use it). */
  runId?: Id;
  deliverableId: Id;
  /** The line as the user confirmed (or edited) it. */
  line: string;
  cwd: string;
  /** Whatever the run service keeps with the run (`launchId`, `pgid`). */
  meta?: Record<string, unknown>;
}

/**
 * A command's run started (`run.started`, decision 130): logged by the run service after the
 * fork. Refused for a deliverable that is not a live command or already has a live run (one run
 * per deliverable), and to an agent (decision 129: the user starts runs). The run history row (`deliverable_runs`) is the event's projection
 * (`projectRunEvent`); the deliverable's `lastRun` is written here.
 */
export function recordRunStarted(
  ctx: CommandContext,
  input: RunStartInput,
  by: Actor,
): DeliverableRun {
  // Only the user starts a run, after a confirmation on the Mac (decision 129); never an agent.
  if (by.type === 'agent') {
    throw new DomainError('invalid', 'an agent cannot start a run: the user starts it on the Mac');
  }
  const current = must(
    ctx.tables.deliverables.get(input.deliverableId),
    'deliverable',
    input.deliverableId,
  );
  if (current.kind !== 'command') {
    throw new DomainError(
      'invalid',
      `deliverable ${current.id} is a ${current.kind}, not a command`,
    );
  }
  if (current.removedAt !== undefined) {
    throw new DomainError('invalid_transition', `deliverable ${current.id} is removed`);
  }
  if (isRunLive(current)) {
    throw new DomainError(
      'conflict',
      `deliverable ${current.id} is already running (${current.lastRun!.runId})`,
    );
  }
  if (!input.line.trim()) throw new DomainError('invalid', 'a run needs a command line');
  if (!input.cwd.startsWith('/')) throw new DomainError('invalid', "a run's folder is absolute");
  const id = input.runId ?? `r-${randomUUID()}`;
  if (ctx.tables.runs.get(id)) throw new DomainError('conflict', `run ${id} exists`);
  const run: DeliverableRun = {
    id,
    deliverableId: current.id,
    line: input.line,
    cwd: input.cwd,
    state: 'running',
    startedAt: ctx.now,
    ports: [],
    startedBy: by,
    ...(input.meta && Object.keys(input.meta).length > 0 ? { meta: input.meta } : {}),
  };
  const lastRun: RunSummary = { runId: id, state: 'running', startedAt: ctx.now, ports: [] };
  ctx.tables.deliverables.upsert({ ...current, lastRun });
  ctx.emit({ type: 'run.started', run });
  return run;
}

/** The ports a run listens on changed (`run.ports`); the same set again logs nothing. */
export function recordRunPorts(ctx: CommandContext, runId: Id, ports: number[]): DeliverableRun {
  const run = must(ctx.tables.runs.get(runId), 'run', runId);
  if (run.state === 'ended') throw new DomainError('invalid_transition', `run ${runId} has ended`);
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  if (JSON.stringify(sorted) === JSON.stringify(run.ports)) return run;
  const current = ctx.tables.deliverables.get(run.deliverableId);
  if (current?.lastRun?.runId === runId) {
    ctx.tables.deliverables.upsert({ ...current, lastRun: { ...current.lastRun, ports: sorted } });
  }
  ctx.emit({ type: 'run.ports', runId, deliverableId: run.deliverableId, ports: sorted });
  return { ...run, ports: sorted };
}

export interface RunEndInput {
  outcome: RunOutcome;
  exitCode?: number;
  signal?: string;
  /** Why the server ended it (`RUN_END_REASONS`). */
  reason?: string;
  /** Who stopped it (a `stopped` run). */
  by?: Actor;
}

/** A run ended (`run.ended`). A run that already ended is returned unchanged (idempotent). */
export function recordRunEnded(ctx: CommandContext, runId: Id, input: RunEndInput): DeliverableRun {
  const run = must(ctx.tables.runs.get(runId), 'run', runId);
  if (run.state === 'ended') return run;
  const current = ctx.tables.deliverables.get(run.deliverableId);
  if (current?.lastRun?.runId === runId) {
    const lastRun: RunSummary = {
      ...current.lastRun,
      state: 'ended',
      endedAt: ctx.now,
      outcome: input.outcome,
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    };
    ctx.tables.deliverables.upsert({ ...current, lastRun });
  }
  ctx.emit({
    type: 'run.ended',
    runId,
    deliverableId: run.deliverableId,
    outcome: input.outcome,
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.by ? { by: input.by } : {}),
  });
  return ctx.tables.runs.get(runId)!;
}

/**
 * The run history projection (`deliverable_runs`), folded from `run.*` events in the transaction
 * that writes them (`EventLog`), and once from an existing log (an import, the first start after
 * migration 0014). Every other event changes nothing here.
 */
export function projectRunEvent(tables: Tables, envelope: EventEnvelope): void {
  const { event, at } = envelope;
  switch (event.type) {
    case 'run.started':
      if (!tables.runs.get(event.run.id)) tables.runs.insert(event.run);
      return;
    case 'run.ports': {
      const run = tables.runs.get(event.runId);
      if (run) tables.runs.upsert({ ...run, ports: event.ports });
      return;
    }
    case 'run.ended': {
      const run = tables.runs.get(event.runId);
      if (!run) return;
      tables.runs.upsert({
        ...run,
        state: 'ended',
        endedAt: at,
        outcome: event.outcome,
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
        ...(event.signal !== undefined ? { signal: event.signal } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        ...(event.by && event.outcome === 'stopped' ? { stoppedBy: event.by } : {}),
      });
      return;
    }
    default:
      return;
  }
}
