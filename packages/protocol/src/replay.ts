import { z } from 'zod';
import { EventEnvelope, type EventType } from './events.js';
import { Id, Timestamp } from './primitives.js';

// --- the timeline scrubber (P4-07) ---------------------------------------------------------------

/**
 * `GET /api/history/events?projectId=&from=&to=&after=&limit=` (P4-07; TECHNOLOGY §6.3 "Timeline
 * replay"): the log's events that touch one project — the project and its sub-projects, their
 * tasks, the bodies they lived on, their agents, their questions and their plan cards — oldest
 * first, paged forward by `seq`. A client replays them from the log's start (no `after`, no
 * `from`) and folds them with its ordinary reducer; `from` / `to` only narrow what is returned
 * (by the events' `at`), they never add a starting snapshot.
 */
export const HistoryEventsQuery = z.object({
  projectId: Id,
  from: Timestamp.optional(),
  to: Timestamp.optional(),
  /** Continue after this `seq` (the previous page's `seq`). */
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(2_000).default(500),
});
export type HistoryEventsQuery = z.input<typeof HistoryEventsQuery>;
export type HistoryEventsParams = z.output<typeof HistoryEventsQuery>;

export const HistoryEventsResponse = z.object({
  projectId: Id,
  /** Oldest first, exactly as the stream carried them (the log's rows, redacted when written). */
  events: z.array(EventEnvelope),
  /** The last `seq` looked at: the next page's `after`. */
  seq: z.number().int().nonnegative(),
  /** More of the log is left to read after `seq`. */
  hasMore: z.boolean(),
});
export type HistoryEventsResponse = z.infer<typeof HistoryEventsResponse>;

/**
 * Event types the replay never returns: they change nothing the scene draws. The chat
 * (`message.*`) has its own endpoint, panel actions (`control.*`) arrive as their domain events,
 * and the rest are notifications or process bookkeeping.
 */
export const REPLAY_SKIPPED_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'agent.output',
  'message.sent',
  'message.delivered',
  'permission.decided',
  'recovery.needs_attention',
  'agent.processes_stopped',
  'control.stop',
  'control.cancel',
  'control.pause',
  'control.resume',
  'control.edit',
  'control.close',
  'control.archive',
  'control.pin',
  'control.reopen',
]);

/**
 * A tool call as a status record's `currentActivity` (`"<Tool>: <detail>"` or `"<Tool>"`): the
 * server's status store and the client's replay word activities alike, so the satellites'
 * archetypes (decision 73) read a replayed activity as they read a live one.
 */
export function describeTool(toolName: string, input: unknown): string {
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    const detail = i['command'] ?? i['file_path'] ?? i['pattern'] ?? i['path'] ?? i['url'];
    // Events reach the log redacted (AgentRuntime); every reader sees the same redacted text.
    if (typeof detail === 'string') return `${toolName}: ${detail.slice(0, 120)}`;
  }
  return toolName;
}
