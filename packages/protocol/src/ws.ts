import { z } from 'zod';
import { Id, Timestamp } from './primitives.js';
import {
  Agent,
  Body,
  Project,
  Proposal,
  Question,
  StatusRecord,
  Task,
  TranscriptChunk,
} from './domain.js';
import { EVENT_TYPES, EventEnvelope } from './events.js';
import { RequestOrigin } from './enums.js';
import { AgentSpend } from './budget.js';
import { StorageHealth } from './storage.js';
import { Deliverable } from './deliverables.js';

// ---------------------------------------------------------------------------
// WebSocket protocol (TECHNOLOGY §6.3). Client state is derived from the stream only.
// ---------------------------------------------------------------------------

/**
 * Stands in for the token on a device the server authenticates by its Tailscale identity (P7-02):
 * sent where the token would go, ignored by the server, never stored. It can never be the real
 * token: the server refuses it in `config.json` and `GALACTIC_TOKEN`, the client in a QR fragment.
 */
export const IDENTITY_TOKEN = 'tailscale-identity';

/** WebSocket close code for a bad or missing token (private 4xxx range). */
export const CLOSE_UNAUTHORIZED = 4401;

/**
 * First frame the client sends. `lastEventId` is the last `seq` it applied, if any, and `logId`
 * the identity of the log it applied it from (from the snapshot); a replay is only possible when
 * both are given and `logId` matches the server's, otherwise the client gets a snapshot.
 */
export const HelloMessage = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  lastEventId: z.number().int().nonnegative().optional(),
  logId: z.string().min(1).optional(),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

export const PingMessage = z.object({ type: z.literal('ping') });

/**
 * Transcripts are a second, per-agent stream (TECHNOLOGY §6.2): a client subscribes to the
 * agents it is looking at and receives chunks with `seq > since` (persisted history first, then
 * live batches), always in `seq` order.
 */
export const TranscriptSubscribeMessage = z.object({
  type: z.literal('transcript.subscribe'),
  agentId: Id,
  since: z.number().int().nonnegative().optional(),
});
export type TranscriptSubscribeMessage = z.infer<typeof TranscriptSubscribeMessage>;

export const TranscriptUnsubscribeMessage = z.object({
  type: z.literal('transcript.unsubscribe'),
  agentId: Id,
});
export type TranscriptUnsubscribeMessage = z.infer<typeof TranscriptUnsubscribeMessage>;

export const ClientMessage = z.discriminatedUnion('type', [
  HelloMessage,
  PingMessage,
  TranscriptSubscribeMessage,
  TranscriptUnsubscribeMessage,
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Full current state, sent when the client has no usable `lastEventId`. */
export const SnapshotMessage = z.object({
  type: z.literal('snapshot'),
  /** Identity of the event log; generated when the database is created, sent back in `hello`. */
  logId: z.string().min(1),
  /** The `seq` of the last event folded into this snapshot; the stream continues from seq + 1. */
  seq: z.number().int().nonnegative(),
  agents: z.array(Agent),
  bodies: z.array(Body),
  projects: z.array(Project),
  tasks: z.array(Task),
  questions: z.array(Question),
  proposals: z.array(Proposal),
  statuses: z.array(StatusRecord),
  /**
   * Every agent's reported cost at `seq` (P8-01): the `agent_spend` projection, which the client
   * keeps folding from the stream with `foldSpend`. Absent from older servers: no spend known.
   */
  spend: z.array(AgentSpend).optional(),
  /**
   * Every deliverable at `seq`, removed ones included (P9-01; decision 132): the client keeps
   * folding them from the stream. Optional so a page of the previous build, which does not know
   * them, still reads the snapshot (zod strips the key; TECHNOLOGY §6.3 rule 5). Absent from
   * older servers: none.
   */
  deliverables: z.array(Deliverable).optional(),
  /**
   * Whether the database takes writes (P8-09): runtime state, never an event (a full disk could
   * not log it). Absent from older servers: taken as `ok`.
   */
  storage: StorageHealth.optional(),
  /**
   * The server's clock when it sent this (P4-06 review): the client's offset to it, so "is this
   * event news?" compares event times with the server's clock, not a skewed client's.
   */
  serverTime: Timestamp.optional(),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;
export type Snapshot = Omit<SnapshotMessage, 'type'>;

/** One event of the ordered stream (also used for the catch-up after `hello{lastEventId}`). */
export const EventMessage = EventEnvelope.extend({ type: z.literal('event') });
export type EventMessage = z.infer<typeof EventMessage>;

/** An `event` frame read for its envelope only: any event `type`, the rest left unchecked. */
const EventFrameEnvelope = z.object({
  type: z.literal('event'),
  seq: z.number().int().positive(),
  at: Timestamp,
  event: z.object({ type: z.string().min(1) }),
});

/**
 * Protocol evolution (TECHNOLOGY §6.3): an `event` frame whose envelope is valid but whose event
 * `type` this build does not know — a newer server added it (e.g. `body.retired`, P7-07). The
 * client skips such an event and advances its `seq` past it, instead of treating the frame as
 * unreadable (which would resume from the same `seq` and receive it again, forever). Undefined for
 * anything else, including a malformed event of a *known* type: that is a server bug, and still
 * an unreadable message.
 */
export function unknownEventFrame(data: unknown): { seq: number; eventType: string } | undefined {
  const frame = EventFrameEnvelope.safeParse(data);
  if (!frame.success) return undefined;
  const eventType = frame.data.event.type;
  if ((EVENT_TYPES as readonly string[]).includes(eventType)) return undefined;
  return { seq: frame.data.seq, eventType };
}

/** Marks the end of the catch-up replay; the client is now live. */
export const CaughtUpMessage = z.object({
  type: z.literal('caught_up'),
  seq: z.number().int().nonnegative(),
  /** The server's clock when the catch-up ended (see `SnapshotMessage.serverTime`). */
  serverTime: Timestamp.optional(),
});
export type CaughtUpMessage = z.infer<typeof CaughtUpMessage>;

export const ErrorCode = z.enum([
  'unauthorized',
  'bad_hello',
  'protocol_violation',
  'slow_consumer',
  'unsupported',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: z.string(),
});
export type ErrorMessage = z.infer<typeof ErrorMessage>;

export const PongMessage = z.object({ type: z.literal('pong') });

/**
 * A batch of status records (TECHNOLOGY §4): the server-owned projection, sent as diffs at
 * ≈10 Hz after the snapshot. A record replaces the client's copy for that agent.
 *
 * With `replace: true` the message is the complete current set (sent after a replay's
 * `caught_up`, P1-38): the client drops every record it holds that is not in it, so records
 * removed by retention while it was away do not linger. A replacing set may be empty.
 *
 * `storage` (P8-09) is the database's write health when it changed (or with a replacing set): the
 * client keeps the latest. The server sends it only on a replacing message — the complete set
 * plus `storage` — because a page built before the field fails a message with neither records,
 * removals nor `replace` (the refine below), and an unknown message kind would close its socket
 * (TECHNOLOGY §6.3). This build accepts `storage` alone, so a later server may drop the set.
 */
export const StatusMessage = z
  .object({
    type: z.literal('status'),
    statuses: z.array(StatusRecord),
    /** Agents whose ended record the server dropped (retention, P1-16): forget them. */
    removed: z.array(Id).optional(),
    /** The statuses are the whole set, not a diff. */
    replace: z.boolean().optional(),
    /** The database's write health (P8-09), when it changed. */
    storage: StorageHealth.optional(),
  })
  .refine(
    (m) =>
      m.replace === true ||
      m.statuses.length > 0 ||
      (m.removed?.length ?? 0) > 0 ||
      m.storage !== undefined,
    { message: 'a status message carries records, removals or storage, or replaces the set' },
  );
export type StatusMessage = z.infer<typeof StatusMessage>;

/** A batch of transcript chunks for one subscribed agent, in `seq` order. */
export const TranscriptMessage = z.object({
  type: z.literal('transcript'),
  agentId: Id,
  chunks: z.array(TranscriptChunk),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessage>;

export const ServerMessage = z.discriminatedUnion('type', [
  SnapshotMessage,
  EventMessage,
  CaughtUpMessage,
  ErrorMessage,
  PongMessage,
  StatusMessage,
  TranscriptMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/**
 * Response of `GET /health`. The token is only returned to a local caller (`origin: 'local'`);
 * never to a remote one, whatever credential it holds (P7-02).
 */
export const HealthResponse = z.object({
  ok: z.literal(true),
  name: z.literal('galactic-agents'),
  version: z.string(),
  protocolVersion: z.number().int(),
  logId: z.string().optional(),
  seq: z.number().int().nonnegative(),
  token: z.string().optional(),
  /** How the server classified this request (P7-02; TECHNOLOGY §8 "Remote clients"). */
  origin: RequestOrigin.optional(),
  /**
   * The Tailscale login the server accepted as this request's credential (P7-02): present only
   * when identity headers are enabled and this request passed every check. A client holding no
   * token may then connect without one; the server ignores the token it sends.
   */
  identity: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
