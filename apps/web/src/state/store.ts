import { create } from 'zustand';
import type { EventEnvelope, ServerMessage } from '@galactic/protocol';
import { applyEvent, applySnapshot, emptyWorld, type WorldState } from './reduce.js';
import type { ConnectionStatus } from '../client/client.js';

export const MAX_LOG = 200;

export interface AppState {
  world: WorldState;
  /** The most recent events, newest first, for the event page. */
  log: EventEnvelope[];
  status: ConnectionStatus;
  statusDetail?: string;
  lastError?: string;
  apply: (message: ServerMessage) => void;
  setStatus: (status: ConnectionStatus, detail?: string) => void;
  reset: () => void;
}

/** Client state is derived from the stream only: the store has no other inputs. */
export const useAppStore = create<AppState>((set) => ({
  world: emptyWorld(),
  log: [],
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
      status: 'idle',
      statusDetail: undefined,
      lastError: undefined,
    }),
}));
