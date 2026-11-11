import { randomUUID } from 'node:crypto';
import {
  MAX_PANELS_PER_DASHBOARD,
  NEW_JOB_ID,
  Panel,
  PanelChanges,
  PanelDraft,
  PanelLayout,
  affectedPanels,
  applyChanges,
  isLongTerm,
  type Actor,
  type Id,
  type PanelPlacement,
  type PanelSource,
  type PanelType,
  type Project,
} from '@galactic/protocol';
import type { Reader } from './catalogue.js';
import { DomainError, must } from './errors.js';
import type { CommandContext } from './event-log.js';
import { FINISHED_WORK } from './states.js';

/**
 * The project dashboard's panels (P15-03; SPEC decision 156). One dashboard per long-term project:
 * at most `MAX_PANELS_PER_DASHBOARD` panels, each reading one job of the project (or, a status
 * board, the project's own tasks). A new panel goes at the end with its type's default size; only
 * the user arranges them. Every command writes its row and its event in the caller's transaction,
 * stamped with `ctx.now`, so the protocol fold builds the same rows.
 */

/** A new panel's size by type (plan Task 3). */
const DEFAULT_SIZE: Record<PanelType, Pick<PanelLayout, 'w' | 'h'>> = {
  tile: { w: 1, h: 1 },
  line: { w: 2, h: 1 },
  bar: { w: 2, h: 1 },
  table: { w: 2, h: 1 },
  status: { w: 2, h: 1 },
  text: { w: 2, h: 1 },
  list: { w: 1, h: 2 },
  calendar: { w: 1, h: 2 },
};

const issue = (error: { issues: { message: string }[] }): string => error.issues[0]?.message ?? '';

/** A panel by id, or `not_found`. */
export function panelOf(ctx: Reader, panelId: Id): Panel {
  return must(ctx.tables.panels.get(panelId), 'panel', panelId);
}

/** The project's panels, in dashboard order. */
export function panelsOf(ctx: Reader, projectId: Id): Panel[] {
  return ctx.tables.panels
    .all()
    .filter((p) => p.projectId === projectId)
    .sort((a, b) => a.layout.order - b.layout.order);
}

/** A long-term project that is still open, or the refusal (`invalid`). */
export function dashboardProject(ctx: Reader, projectId: Id): Project {
  const project = must(ctx.tables.projects.get(projectId), 'project', projectId);
  if (!isLongTerm(project)) {
    throw new DomainError('invalid', 'a dashboard belongs to a long-term project');
  }
  if (FINISHED_WORK.has(project.state)) {
    throw new DomainError('invalid', `project ${projectId} is ${project.state}; reopen it first`);
  }
  return project;
}

/** Refuses a project whose dashboard is full. */
export function checkPanelRoom(ctx: Reader, projectId: Id): void {
  if (panelsOf(ctx, projectId).length >= MAX_PANELS_PER_DASHBOARD) {
    throw new DomainError(
      'limit',
      `a dashboard has at most ${MAX_PANELS_PER_DASHBOARD} panels: remove one first`,
    );
  }
}

/**
 * A panel's source names a job of its project (never the card placeholder `$new`, which the
 * approval resolves before the panel is written).
 */
export function checkPanelSource(ctx: Reader, projectId: Id, source: PanelSource): void {
  if (source.kind !== 'job') return;
  if (source.jobId === NEW_JOB_ID) {
    throw new DomainError('invalid', 'a panel reads an existing job, not the placeholder "$new"');
  }
  const job = ctx.tables.jobs.get(source.jobId);
  if (!job || job.projectId !== projectId) {
    throw new DomainError('invalid', `job ${source.jobId} is not a job of project ${projectId}`);
  }
}

/** A draft within the schema, or the refusal. */
export function checkedPanelDraft(draft: unknown): PanelDraft {
  const parsed = PanelDraft.safeParse(draft);
  if (!parsed.success) throw new DomainError('invalid', `invalid panel: ${issue(parsed.error)}`);
  return parsed.data;
}

/**
 * Adds a panel to a long-term project's dashboard, after its last one (`order` = the highest + 1),
 * with its type's default size. Refused for a short-term or finished project and a bad draft or
 * source (`invalid`), and on a full dashboard (`limit`).
 */
export function createPanel(
  ctx: CommandContext,
  projectId: Id,
  given: PanelDraft,
  by: Actor,
): Panel {
  const project = dashboardProject(ctx, projectId);
  const draft = checkedPanelDraft(given);
  checkPanelSource(ctx, project.id, draft.source);
  checkPanelRoom(ctx, project.id);
  const order = Math.max(-1, ...panelsOf(ctx, project.id).map((p) => p.layout.order)) + 1;
  const panel = ctx.tables.panels.insert({
    id: `pn-${randomUUID()}`,
    projectId: project.id,
    type: draft.type,
    title: draft.title,
    source: draft.source,
    display: draft.display,
    limits: draft.limits,
    layout: { order, ...DEFAULT_SIZE[draft.type] },
    createdBy: by,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  ctx.emit({ type: 'panel.created', panel });
  return panel;
}

/**
 * Changes a panel (`panel.updated`). The panel as the change leaves it is checked whole — a change
 * may not, say, point a tile at the project's tasks — and a new source must name a job of the
 * project. A `null` clears an optional field (`removalSuggestedAt`). Nothing given is a no-op.
 */
export function updatePanel(
  ctx: CommandContext,
  panelId: Id,
  given: PanelChanges,
  by: Actor,
): Panel {
  const current = panelOf(ctx, panelId);
  const parsedChanges = PanelChanges.safeParse(given);
  if (!parsedChanges.success) {
    throw new DomainError('invalid', `invalid panel change: ${issue(parsedChanges.error)}`);
  }
  const changes = Object.fromEntries(
    Object.entries(parsedChanges.data).filter(([, v]) => v !== undefined),
  ) as PanelChanges;
  if (Object.keys(changes).length === 0) return current;
  const merged = Panel.safeParse({ ...applyChanges(current, changes), updatedAt: ctx.now });
  if (!merged.success) throw new DomainError('invalid', `invalid panel: ${issue(merged.error)}`);
  if (changes.source) checkPanelSource(ctx, current.projectId, changes.source);
  const panel = ctx.tables.panels.upsert(merged.data);
  ctx.emit({ type: 'panel.updated', panelId, changes, by });
  return panel;
}

/** Removes a panel (`panel.removed`): its row is deleted, the event keeps who and why. */
export function removePanel(ctx: CommandContext, panelId: Id, by: Actor, reason: string): void {
  const panel = panelOf(ctx, panelId);
  ctx.tables.panels.delete(panel.id);
  ctx.emit({ type: 'panel.removed', panelId: panel.id, projectId: panel.projectId, by, reason });
}

/**
 * The user arranges the dashboard (`panels.arranged`, one event): every panel of the project, each
 * once, with distinct `order`s. Only the user arranges panels (Global Constraints).
 */
export function arrangePanels(
  ctx: CommandContext,
  projectId: Id,
  layouts: PanelPlacement[],
  by: Actor,
): void {
  if (by.type !== 'user') throw new DomainError('invalid', 'only the user arranges the dashboard');
  must(ctx.tables.projects.get(projectId), 'project', projectId);
  const panels = new Map(panelsOf(ctx, projectId).map((p) => [p.id, p]));
  const given = new Set(layouts.map((l) => l.panelId));
  if (given.size !== layouts.length) {
    throw new DomainError('invalid', 'each panel is placed once');
  }
  for (const id of given) {
    if (!panels.has(id)) {
      throw new DomainError('invalid', `panel ${id} is not on the dashboard of ${projectId}`);
    }
  }
  const missing = [...panels.keys()].filter((id) => !given.has(id));
  if (missing.length > 0) {
    throw new DomainError('invalid', `every panel is placed; missing ${missing.join(', ')}`);
  }
  const placed = layouts.map(({ panelId, layout }) => {
    const parsed = PanelLayout.safeParse(layout);
    if (!parsed.success) throw new DomainError('invalid', `invalid layout: ${issue(parsed.error)}`);
    return { panelId, layout: parsed.data };
  });
  if (new Set(placed.map((p) => p.layout.order)).size !== placed.length) {
    throw new DomainError('invalid', 'each panel needs its own order');
  }
  for (const { panelId, layout } of placed) {
    ctx.tables.panels.upsert({ ...panels.get(panelId)!, layout, updatedAt: ctx.now });
  }
  ctx.emit({ type: 'panels.arranged', projectId, layouts: placed, by });
}

/** The panel ignores the runs before now (`historyFrom`). Cannot be undone. */
export function clearPanelHistory(ctx: CommandContext, panelId: Id, by: Actor): Panel {
  return updatePanel(ctx, panelId, { historyFrom: ctx.now }, by);
}

/**
 * Deletes the stored values of the job's runs started up to now — their `numbers` and `data`
 * (`job.values_cleared`) — and lists the panels reading the job, which now show nothing for them.
 * Cannot be undone.
 */
export function clearJobValues(
  ctx: CommandContext,
  jobId: Id,
  by: Actor,
): { upTo: string; panels: Id[] } {
  const job = must(ctx.tables.jobs.get(jobId), 'job', jobId);
  const upTo = ctx.now;
  for (const run of ctx.tables.jobRuns.all()) {
    if (run.jobId !== job.id || run.startedAt > upTo) continue;
    if (run.numbers === undefined && run.data === undefined) continue;
    const { numbers: _numbers, data: _data, ...rest } = run;
    ctx.tables.jobRuns.upsert(rest);
  }
  ctx.emit({ type: 'job.values_cleared', jobId: job.id, upTo, by });
  const panels = affectedPanels(panelsOf(ctx, job.projectId), job.id).map((p) => p.id);
  return { upTo, panels };
}

/** The Waykeeper suggests removing a panel unchanged for long (`removalSuggestedAt`). */
export function suggestPanelRemoval(ctx: CommandContext, panelId: Id): void {
  updatePanel(ctx, panelId, { removalSuggestedAt: ctx.now }, { type: 'system' });
}
