import { z } from 'zod';
import { Agent, Body, Project, Proposal, Question, StatusRecord, Task } from './domain.js';
import { EventEnvelope } from './events.js';

// ---------------------------------------------------------------------------
// WebSocket protocol (TECHNOLOGY §6.3). Client state is derived from the stream only.
// ---------------------------------------------------------------------------

/** First frame the client sends. `lastEventId` is the last `seq` it applied, if any. */
export const HelloMessage = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  lastEventId: z.number().int().nonnegative().optional(),
});
export type HelloMessage = z.infer<typeof HelloMessage>;

export const PingMessage = z.object({ type: z.literal('ping') });

export const ClientMessage = z.discriminatedUnion('type', [HelloMessage, PingMessage]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Full current state, sent when the client has no usable `lastEventId`. */
export const SnapshotMessage = z.object({
  type: z.literal('snapshot'),
  /** The `seq` of the last event folded into this snapshot; the stream continues from seq + 1. */
  seq: z.number().int().nonnegative(),
  agents: z.array(Agent),
  bodies: z.array(Body),
  projects: z.array(Project),
  tasks: z.array(Task),
  questions: z.array(Question),
  proposals: z.array(Proposal),
  statuses: z.array(StatusRecord),
});
export type SnapshotMessage = z.infer<typeof SnapshotMessage>;
export type Snapshot = Omit<SnapshotMessage, 'type'>;

/** One event of the ordered stream (also used for the catch-up after `hello{lastEventId}`). */
export const EventMessage = EventEnvelope.extend({ type: z.literal('event') });
export type EventMessage = z.infer<typeof EventMessage>;

/** Marks the end of the catch-up replay; the client is now live. */
export const CaughtUpMessage = z.object({
  type: z.literal('caught_up'),
  seq: z.number().int().nonnegative(),
});
export type CaughtUpMessage = z.infer<typeof CaughtUpMessage>;

export const ErrorCode = z.enum([
  'unauthorized',
  'bad_hello',
  'protocol_violation',
  'slow_consumer',
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

export const ServerMessage = z.discriminatedUnion('type', [
  SnapshotMessage,
  EventMessage,
  CaughtUpMessage,
  ErrorMessage,
  PongMessage,
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** Response of `GET /health`. The token is only returned to loopback callers. */
export const HealthResponse = z.object({
  ok: z.literal(true),
  name: z.literal('galactic-agents'),
  version: z.string(),
  protocolVersion: z.number().int(),
  seq: z.number().int().nonnegative(),
  token: z.string().optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
