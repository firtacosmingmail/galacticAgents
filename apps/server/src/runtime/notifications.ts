import {
  NOTIFYING_EVENT_TYPES,
  notificationOf,
  type Event,
  type NotificationLookup,
  type NotificationsResponse,
  type PanelNotification,
} from '@galactic/protocol';
import type { EventLog } from '../domain/event-log.js';

/**
 * The notification feed (P25-01; SPEC §4.5): the events worth a desktop notification, read from
 * the log with `notificationOf` — the same pure function a client folds the live stream with, so
 * the REST backfill and the stream give the same ids and a client deduping by id never notifies
 * twice. Only the notifying shapes are read (an indexed `type` filter plus the payload fields that
 * decide), never the whole log. Without `after`, the newest page (what a fresh page shows);
 * with `after`, everything since — the next `after` is the returned `seq`.
 */

const TYPES = NOTIFYING_EVENT_TYPES.map((t) => `'${t}'`).join(', ');
/** The payload conditions under which those types notify (kept in step with `notificationOf`). */
const NOTIFYING = `type IN (${TYPES}) AND (
  (type = 'question.opened' AND json_extract(payload, '$.question.holder.type') = 'user') OR
  (type IN ('question.escalated', 'question.reassigned')
    AND json_extract(payload, '$.to.type') = 'user') OR
  (type IN ('task.state_changed', 'project.state_changed')
    AND json_extract(payload, '$.to') IN ('completed', 'failed')) OR
  type = 'recovery.needs_attention' OR
  (type = 'proposal.parked' AND json_extract(payload, '$.waitingFor') IS NOT NULL)
)`;

export function notificationLookup(log: EventLog): NotificationLookup {
  const t = log.tables;
  return {
    task: (id) => t.tasks.get(id),
    project: (id) => t.projects.get(id),
    question: (id) => t.questions.get(id),
    agent: (id) => t.agents.get(id),
  };
}

export function notificationFeed(
  log: EventLog,
  q: { after?: number | undefined; limit: number },
): NotificationsResponse {
  const head = log.currentSeq();
  const forward = q.after !== undefined;
  const rows = log.db
    .prepare(
      `SELECT id, at, payload FROM events
        WHERE id > ? AND id <= ? AND ${NOTIFYING}
        ORDER BY id ${forward ? 'ASC' : 'DESC'} LIMIT ?`,
    )
    .all(q.after ?? 0, head, q.limit + 1) as { id: number; at: string; payload: string }[];
  const hasMore = forward && rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  if (!forward) page.reverse();
  const lookup = notificationLookup(log);
  const notifications: PanelNotification[] = [];
  const seen = new Set<string>();
  for (const row of page) {
    const n = notificationOf(
      { seq: row.id, at: row.at, event: JSON.parse(row.payload) as Event },
      lookup,
    );
    // A question escalated to the user twice keeps its first notification.
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      notifications.push(n);
    }
  }
  return { notifications, seq: hasMore ? page.at(-1)!.id : head, hasMore };
}
