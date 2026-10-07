import { create } from 'zustand';
import {
  STORAGE_OK,
  type ChatMessage,
  type EventEnvelope,
  type Id,
  type ServerMessage,
  type StorageHealth,
  type TranscriptChunk,
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
/**
 * Transcript chunks kept per agent: live chunks past it drop the oldest — except while a Steward
 * view has paged back (`transcriptViews[id].pagedBack`), whose older pages the user asked for.
 * Paged-back history is bounded by the scrolling, and the view's next newest page resets it.
 */
export const MAX_TRANSCRIPT = 2_000;
/** Chat messages kept per agent (oldest dropped). */
export const MAX_MESSAGES = 500;

/** The offset to the server's clock a `serverTime` gives, as a state patch (none without one). */
function serverOffset(serverTime: string | undefined): { serverOffsetMs?: number } {
  const at = serverTime ? Date.parse(serverTime) : NaN;
  return Number.isFinite(at) ? { serverOffsetMs: at - Date.now() } : {};
}

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
  /**
   * The timeline scrubber's world (P4-07), set while a replay is open: the scene draws it instead
   * of `world` (`sceneWorld`), the panel keeps the live `world`, and live events keep folding into
   * `world` meanwhile. Not derived from the stream: the replay store (`replay/store.ts`) sets it.
   */
  replayWorld?: WorldState | undefined;
  /**
   * The server's clock minus this page's (ms), from the last snapshot's or catch-up's
   * `serverTime`: "now" on the server is `Date.now() + serverOffsetMs` (event toasts' freshness).
   */
  serverOffsetMs?: number | undefined;
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
  /**
   * Whether the server's database takes writes (P8-09; decision 99): the last `storage` the
   * snapshot or a `status` message carried — runtime state, not derived from events. `ok` until
   * told otherwise (an older server sends none).
   */
  storage: StorageHealth;
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
  /**
   * Goes to a route and selection; `replace` rewrites the current history entry instead, keeping
   * its query and hash (a canonical rewrite must not drop flags such as `?show_fps=true`).
   */
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
      // A rewrite in place (the canonical form of the URL) keeps the query and the hash: they
      // carry flags that are not the panel's (`?show_fps=true`, P3-11) and must outlive it.
      if (opts?.replace)
        window.history.replaceState(null, '', path + window.location.search + window.location.hash);
      else if (window.location.pathname !== path) {
        // An overlay's own entry on top (the phone's navigation sheet pushes one so that Back
        // closes it, P8-15): the navigation that dismisses it takes its place, so Back then goes
        // to the previous page rather than to a dangling "sheet open" entry.
        const overlay = (window.history.state as { navSheet?: unknown } | null)?.navSheet === true;
        if (overlay) window.history.replaceState(null, '', path);
        else window.history.pushState(null, '', path);
      }
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
  storage: STORAGE_OK,
  apply: (message) =>
    set((s) => {
      switch (message.type) {
        case 'snapshot':
          // A snapshot from another log (a new database) invalidates the transcript seqs too:
          // keep them only when the log is the same (P1-38). A replay of the old log ends.
          return {
            world: applySnapshot(message),
            log: [],
            logId: message.logId,
            snapshots: s.snapshots + 1,
            storage: message.storage ?? STORAGE_OK,
            ...serverOffset(message.serverTime),
            ...(s.logId !== undefined && s.logId !== message.logId
              ? { transcripts: {}, messages: {}, transcriptViews: {}, replayWorld: undefined }
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
          return {
            world: { ...s.world, seq: Math.max(s.world.seq, message.seq) },
            ...serverOffset(message.serverTime),
          };
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
          return {
            world: { ...s.world, statuses },
            ...(message.storage ? { storage: message.storage } : {}),
          };
        }
        case 'transcript': {
          const current = s.transcripts[message.agentId] ?? [];
          const lastSeq = current.at(-1)?.seq ?? 0;
          const fresh = message.chunks.filter((c) => c.seq > lastSeq);
          if (fresh.length === 0) return {};
          const all = [...current, ...fresh];
          // The cap never undoes a deliberate scroll back (see MAX_TRANSCRIPT).
          const merged = s.transcriptViews[message.agentId]?.pagedBack
            ? all
            : all.slice(-MAX_TRANSCRIPT);
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
      replayWorld: undefined,
      serverOffsetMs: undefined,
      log: [],
      transcripts: {},
      messages: {},
      transcriptViews: {},
      logId: undefined,
      snapshots: 0,
      status: 'idle',
      statusDetail: undefined,
      storage: STORAGE_OK,
      lastError: undefined,
    }),
}));

/**
 * The world the solar-system scene draws (P4-07): the replay's while the timeline scrubber is
 * open, the live one otherwise. Every scene component reads its rows through this one switch; the
 * panel reads `world`.
 */
export const sceneWorld = (s: Pick<AppState, 'world' | 'replayWorld'>): WorldState =>
  s.replayWorld ?? s.world;
