import type { Actor, Id, WorkState } from '@galactic/protocol';
import { DEFAULT_RETENTION_MS, sweepMarkers } from './bodies.js';
import { DomainError } from './errors.js';
import type { EventLog } from './event-log.js';
import { archiveProject } from './projects.js';
import { archiveTask } from './tasks.js';

/**
 * Retention of finished work (P2-13; SPEC decision 4, §2.7, decision 15). A closed (`completed`)
 * or cancelled (`failed`) project, and a finished standalone task, keep their body for the
 * retention period; then the archival job archives them, which frees the body. Pinned work is
 * never archived by the job. "moved to …" markers are swept with the same period.
 *
 * **Since when** — derived from the event log, not from a column: the retention clock of an item
 * starts at the later of
 *   - the last time it *entered* a finished state (`*.state_changed` to `completed` or `failed`
 *     from a state that was not one of them: `failed → completed` keeps the clock), and
 *   - the last time it was *unpinned* (`*.updated` with `pinned: false`): pinning suspends the
 *     timer, and unpinning starts a full period again, so unpinning old work never archives it on
 *     the spot.
 * Edits (a rename, a policy change) do not move it, unlike `updatedAt`. Without such an event (a
 * row created finished, or a pruned log) it falls back to `updatedAt`.
 */

export const SYSTEM: Actor = { type: 'system' };

/** The finished states whose body is kept for the retention period. */
const RETAINED: ReadonlySet<WorkState> = new Set<WorkState>(['completed', 'failed']);

export interface RetentionItem {
  kind: 'project' | 'task';
  id: Id;
  name: string;
  /** When its retention clock started (see the module comment). */
  since: string;
  /** `since` + the retention period. */
  dueAt: string;
}

/** Latest clock start per item, from the log: `{[id]: at}`. */
function clockStarts(log: EventLog, kind: 'project' | 'task'): Map<Id, string> {
  const key = kind === 'project' ? '$.projectId' : '$.taskId';
  const rows = log.db
    .prepare(
      `SELECT json_extract(payload, '${key}') AS id, MAX(at) AS since FROM events
       WHERE (type = ? AND json_extract(payload, '$.to') IN ('completed', 'failed')
                        AND json_extract(payload, '$.from') NOT IN ('completed', 'failed'))
          OR (type = ? AND json_extract(payload, '$.changes.pinned') = 0)
       GROUP BY id`,
    )
    .all(`${kind}.state_changed`, `${kind}.updated`) as { id: Id; since: string }[];
  return new Map(rows.map((r) => [r.id, r.since]));
}

const plus = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();

/**
 * Everything the retention timer runs for, with its clock: finished, unpinned projects and
 * standalone tasks (a project's tasks live on its body and stay with it). Sorted by `dueAt`.
 */
export function retained(log: EventLog, retentionMs = DEFAULT_RETENTION_MS): RetentionItem[] {
  const { tables } = log;
  const projectClock = clockStarts(log, 'project');
  const taskClock = clockStarts(log, 'task');
  const items: RetentionItem[] = [];
  for (const p of tables.projects.all()) {
    if (!RETAINED.has(p.state) || p.pinned) continue;
    const since = projectClock.get(p.id) ?? p.updatedAt;
    items.push({ kind: 'project', id: p.id, name: p.name, since, dueAt: plus(since, retentionMs) });
  }
  for (const t of tables.tasks.all()) {
    if (t.projectId || !RETAINED.has(t.state) || t.pinned) continue;
    const since = taskClock.get(t.id) ?? t.updatedAt;
    items.push({
      kind: 'task',
      id: t.id,
      name: t.description,
      since,
      dueAt: plus(since, retentionMs),
    });
  }
  return items.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export interface SweepReport {
  /** Work archived by this sweep (its body freed). */
  archived: { kind: 'project' | 'task'; id: Id }[];
  /** Due work the domain refused to archive (an active sub-project, a task still running). */
  skipped: { kind: 'project' | 'task'; id: Id; reason: string }[];
  /** Bodies whose "moved to …" marker was cleared. */
  markers: Id[];
}

/**
 * One run of the archival job, by the log's clock (injectable): archives every item whose
 * retention period has run out, each in its own command (one refusal does not hold back the
 * others; it is retried on the next sweep), then sweeps the "moved to …" markers. Archiving
 * emits the usual `*.state_changed` and `body.freed`, which is what un-parks a waiting proposal.
 */
export function sweepRetention(log: EventLog, retentionMs = DEFAULT_RETENTION_MS): SweepReport {
  const report: SweepReport = { archived: [], skipped: [], markers: [] };
  const now = Date.parse(log.runCommand((ctx) => ctx.now).value);
  for (const item of retained(log, retentionMs)) {
    if (Date.parse(item.dueAt) > now) break; // sorted by dueAt
    try {
      log.runCommand((ctx) => {
        if (item.kind === 'project') archiveProject(ctx, item.id, SYSTEM);
        else archiveTask(ctx, item.id, SYSTEM);
      });
      report.archived.push({ kind: item.kind, id: item.id });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      report.skipped.push({ kind: item.kind, id: item.id, reason: error.message });
    }
  }
  report.markers = log.runCommand((ctx) => sweepMarkers(ctx, retentionMs)).value.map((b) => b.id);
  return report;
}
