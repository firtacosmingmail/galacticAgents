import { create } from 'zustand';
import type {
  ChatMessage,
  EventEnvelope,
  Id,
  ServerMessage,
  TranscriptChunk,
} from '@galactic/protocol';
import { applyEvent, applySnapshot, emptyWorld, type WorldState } from './reduce.js';
import type { ConnectionStatus } from '../client/client.js';
import {
  currentLocation,
  HARMONIZER,
  pathFor,
  sameSelection,
  type PageLocation,
  type Route,
  type Selection,
} from './selection.js';
import { createTranscriptViewSlice, type TranscriptViewSlice } from './transcript-view.js';

export const MAX_LOG = 200;
/** Transcript chunks kept per agent (oldest dropped). */
export const MAX_TRANSCRIPT = 2_000;
/** Chat messages kept per agent (oldest dropped). */
export const MAX_MESSAGES = 500;

/**
 * Merges chat messages into an agent's list: one entry per `messageId`, in `seq` order (P2-18).
 * Live `message.sent` events and the REST history (`GET /api/agents/:id/messages`) both land
 * here, in any order, without duplicates.
 */
export function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const known = new Set(current.map((m) => m.messageId));
  const fresh = incoming.filter((m) => !known.has(m.messageId));
  if (fresh.length === 0) return current;
  return [...current, ...fresh].sort((a, b) => a.seq - b.seq).slice(-MAX_MESSAGES);
}

export interface AppState extends TranscriptViewSlice {
  world: WorldState;
  /** The most recent events, newest first, for the event page. */
  log: EventEnvelope[];
  /** Per-agent transcript chunks in `seq` order, for the agents this page subscribed to. */
  transcripts: Record<Id, TranscriptChunk[]>;
  /**
   * The messages sent to each agent (`message.sent`), for the chat boxes (P2-18). Not part of
   * `world`: the snapshot does not carry them (the inbox is runtime state), so they are kept
   * beside it like the transcripts — folded from the stream, backfilled from the REST history,
   * and dropped when the page switches to another log.
   */
  messages: Record<Id, ChatMessage[]>;
  /** The log the state came from (the last snapshot's `logId`). */
  logId?: string | undefined;
  /**
   * How many snapshots this page took (P2-18): a snapshot catch-up skipped the events between,
   * so the chat boxes read their history again when it changes.
   */
  snapshots: number;
  status: ConnectionStatus;
  statusDetail?: string | undefined;
  lastError?: string | undefined;
  apply: (message: ServerMessage) => void;
  setStatus: (status: ConnectionStatus, detail?: string) => void;
  reset: () => void;
  /** Adds an agent's messages read from the REST history. */
  addMessages: (agentId: Id, messages: ChatMessage[]) => void;
  /**
   * The page's route and the panel's selection (P25-02). These are the only fields not derived
   * from the stream: they are the user's navigation, mirrored in the URL (history API) so a deep
   * link or a reload restores them. `reset()` leaves them alone.
   */
  route: Route;
  selection: Selection;
  /** Selects who the main area shows, on the panel; pushes a history entry when it changes. */
  select: (selection: Selection) => void;
  /** Selects an agent by id, by its role (unknown ids and roles keep the selection). */
  selectAgent: (agentId: Id) => void;
  /** Goes to a route and selection; `replace` rewrites the current history entry instead. */
  navigate: (location: PageLocation, opts?: { replace?: boolean }) => void;
  /** Reads the route and selection back from the URL (on load and on back/forward). */
  syncFromLocation: () => void;
  /** Set while a session runs: open / close the transcript stream of an agent. */
  subscribeTranscript?: ((agentId: Id) => void) | undefined;
  unsubscribeTranscript?: ((agentId: Id) => void) | undefined;
}

/** Client state is derived from the stream only: the store has no other inputs. */
export const useAppStore = create<AppState>((set, get) => ({
  ...createTranscriptViewSlice(set),
  ...currentLocation(),
  select: (selection) => get().navigate({ route: 'panel', selection }),
  selectAgent: (agentId) => {
    const agent = get().world.agents[agentId];
    if (!agent) return;
    get().select(agent.role === 'harmonizer' ? HARMONIZER : { kind: agent.role, id: agent.id });
  },
  navigate: (location, opts) => {
    const { route, selection } = get();
    const unchanged = route === location.route && sameSelection(selection, location.selection);
    if (typeof window !== 'undefined') {
      const path = pathFor(location);
      if (opts?.replace) window.history.replaceState(null, '', path);
      else if (window.location.pathname !== path) window.history.pushState(null, '', path);
    }
    if (!unchanged) set({ route: location.route, selection: location.selection });
  },
  syncFromLocation: () => {
    const location = currentLocation();
    get().navigate(location, { replace: true }); // canonicalises an unrecognised path
  },
  world: emptyWorld(),
  log: [],
  transcripts: {},
  messages: {},
  snapshots: 0,
  status: 'idle',
  apply: (message) =>
    set((s) => {
      switch (message.type) {
        case 'snapshot':
          // A snapshot from another log (a new database) invalidates the transcript seqs too:
          // keep them only when the log is the same (P1-38).
          return {
            world: applySnapshot(message),
            log: [],
            logId: message.logId,
            snapshots: s.snapshots + 1,
            ...(s.logId !== undefined && s.logId !== message.logId
              ? { transcripts: {}, messages: {}, transcriptViews: {} }
              : {}),
          };
        case 'event': {
          const { type: _type, ...envelope } = message;
          const { event } = envelope;
          return {
            world: applyEvent(s.world, envelope),
            log: [envelope, ...s.log].slice(0, MAX_LOG),
            ...(event.type === 'message.sent'
              ? {
                  messages: {
                    ...s.messages,
                    [event.agentId]: mergeMessages(s.messages[event.agentId] ?? [], [
                      {
                        messageId: event.messageId,
                        agentId: event.agentId,
                        seq: envelope.seq,
                        at: envelope.at,
                        sender: event.sender,
                        text: event.text,
                        ...(event.turn ? { turn: true as const } : {}),
                      },
                    ]),
                  },
                }
              : {}),
          };
        }
        case 'caught_up':
          return { world: { ...s.world, seq: Math.max(s.world.seq, message.seq) } };
        case 'error':
          return { lastError: `${message.code}: ${message.message}` };
        case 'pong':
          return {};
        case 'status': {
          // Server-owned records (TECHNOLOGY §4): each one replaces the copy for its agent; a
          // replacing set (after a replay, P1-38) replaces them all.
          const statuses = message.replace ? {} : { ...s.world.statuses };
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
  addMessages: (agentId, messages) =>
    set((s) => {
      const merged = mergeMessages(s.messages[agentId] ?? [], messages);
      return merged === s.messages[agentId]
        ? {}
        : { messages: { ...s.messages, [agentId]: merged } };
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
      messages: {},
      transcriptViews: {},
      logId: undefined,
      snapshots: 0,
      status: 'idle',
      statusDetail: undefined,
      lastError: undefined,
    }),
}));
