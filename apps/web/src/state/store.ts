import { create } from 'zustand';
import type { EventEnvelope, Id, ServerMessage, TranscriptChunk } from '@galactic/protocol';
import { applyEvent, applySnapshot, emptyWorld, type WorldState } from './reduce.js';
import type { ConnectionStatus } from '../client/client.js';

export const MAX_LOG = 200;
/** Transcript chunks kept per agent (oldest dropped). */
export const MAX_TRANSCRIPT = 2_000;

export interface AppState {
  world: WorldState;
  /** The most recent events, newest first, for the event page. */
  log: EventEnvelope[];
  /** Per-agent transcript chunks in `seq` order, for the agents this page subscribed to. */
  transcripts: Record<Id, TranscriptChunk[]>;
  status: ConnectionStatus;
  statusDetail?: string | undefined;
  lastError?: string | undefined;
  apply: (message: ServerMessage) => void;
  setStatus: (status: ConnectionStatus, detail?: string) => void;
  reset: () => void;
}

/** Client state is derived from the stream only: the store has no other inputs. */
export const useAppStore = create<AppState>((set) => ({
  world: emptyWorld(),
  log: [],
  transcripts: {},
  status: 'idle',
  apply: (message) =>
    set((s) => {
      switch (message.type) {
        case 'snapshot':
          return { world: applySnapshot(message), log: [] };
        case 'event': {
          const { type: _type, ...envelope } = message;
          return {
            world: applyEvent(s.world, envelope),
            log: [envelope, ...s.log].slice(0, MAX_LOG),
          };
        }
        case 'caught_up':
          return { world: { ...s.world, seq: Math.max(s.world.seq, message.seq) } };
        case 'error':
          return { lastError: `${message.code}: ${message.message}` };
        case 'pong':
          return {};
        case 'status': {
          // Server-owned records (TECHNOLOGY §4): each one replaces the copy for its agent.
          const statuses = { ...s.world.statuses };
          for (const record of message.statuses) statuses[record.agentId] = record;
          for (const id of message.removed ?? []) delete statuses[id];
          return { world: { ...s.world, statuses } };
        }
        case 'transcript': {
          const current = s.transcripts[message.agentId] ?? [];
          const lastSeq = current.at(-1)?.seq ?? 0;
          const fresh = message.chunks.filter((c) => c.seq > lastSeq);
          if (fresh.length === 0) return {};
          const merged = [...current, ...fresh].slice(-MAX_TRANSCRIPT);
          return { transcripts: { ...s.transcripts, [message.agentId]: merged } };
        }
      }
    }),
  setStatus: (status, detail) =>
    set(
      detail === undefined ? { status, statusDetail: undefined } : { status, statusDetail: detail },
    ),
  reset: () =>
    set({
      world: emptyWorld(),
      log: [],
      transcripts: {},
      status: 'idle',
      statusDetail: undefined,
      lastError: undefined,
    }),
}));
