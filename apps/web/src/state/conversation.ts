import { create } from 'zustand';
import {
  ConversationResponse,
  questionOwner as ownerOf,
  threadShowsProposal,
  threadShowsQuestion,
  type Actor,
  type Agent,
  type ChatMessage,
  type ConversationEntry,
  type ConversationQuery,
  type Id,
  type TranscriptCompaction,
  type Proposal,
  type Question,
  type QuestionOwner,
  type ReplyTargetKind,
  type ThreadLookup,
  type TranscriptChunk,
} from '@galactic/protocol';
import type { WorldState } from './reduce.js';

/**
 * The panel's conversations with the brains (P25-03; decision 52): per agent, the history read
 * from `GET /api/agents/:id/conversation` (paged back on scroll) merged with what the stream
 * brings live — `message.sent` (the store's `messages`) and the brain's `text` transcript chunks
 * (the store's `transcripts`). Every line has the server's stable id (`m:<messageId>`,
 * `r:<agentId>:<chunkSeq>`), so the merge is a dedup by id, whatever arrives first.
 *
 * The seam: the newest page's `lastSeq` is where the live transcript starts
 * (`conversationSince`, which the session's `transcriptSince` reads), so a reply still buffered
 * when the page was read arrives on the stream and nothing is read twice. After a snapshot
 * catch-up (the messages between never came on the stream) the thread pages forward from its
 * newest history entry until it is caught up (a thread with no history reads the newest page; a
 * catch-up too long to finish restarts the thread from the newest page, see `forward`).
 *
 * Kept in its own store beside `useAppStore`: it is a REST-filled cache, not stream-derived
 * state, and it is dropped when the page switches to another log.
 */

/** A line of a conversation: a history entry, or a live one (which has no cursor). */
export type ChatEntry = Omit<ConversationEntry, 'cursor'> & { cursor?: string | undefined };

export interface Thread {
  /** History and absorbed live lines, unique by id, in conversation order. */
  entries: ChatEntry[];
  /** The cursor of the oldest history entry (paging back) and of the newest (catching up). */
  oldestCursor?: string | undefined;
  newestCursor?: string | undefined;
  /** More history before `oldestCursor`. */
  hasOlder: boolean;
  /** The first page has been read (or failed). */
  loaded: boolean;
  loadingOlder: boolean;
  /**
   * While the chat is open: the transcript `seq` the live stream starts after (the newest page's
   * `lastSeq`). Undefined when closed or when the history could not be read (then the stream
   * replays from the start, which the dedup absorbs).
   */
  liveFrom?: number | undefined;
  /**
   * What retention removed of the agent's replies (P8-02), from the latest page read: the chat
   * says so, since its messages are kept and the thread would otherwise just lack the replies.
   */
  compacted?: TranscriptCompaction | undefined;
  error?: string | undefined;
}

/**
 * What the composer replies to (P8-17): the line or card the user chose, as the chat showed it
 * (`sender`, `text` for the quote bar; the server resolves the real quote). `answerId` is the
 * idempotency key a reply to an open clarification answers it under (P7-05), one per reply.
 */
export interface ReplyDraft {
  kind: ReplyTargetKind;
  id: Id;
  sender: Actor;
  text: string;
  answerId: string;
}

export type ConversationFetch = (agentId: Id, query: ConversationQuery) => Promise<unknown>;

/** The most catch-up pages read in one go (200 entries each). */
const MAX_CATCH_UP_PAGES = 20;
const PAGE = 50;

const EMPTY: Thread = { entries: [], hasOlder: false, loaded: false, loadingOlder: false };

// --- pure helpers ----------------------------------------------------------------------------

/** The server's order (P25-01): `at`, then messages before replies, then `seq` / `chunkSeq`. */
export function compareEntries(a: ChatEntry, b: ChatEntry): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  if (a.kind !== b.kind) return a.kind === 'message' ? -1 : 1;
  const sa = (a.kind === 'message' ? a.seq : a.chunkSeq) ?? 0;
  const sb = (b.kind === 'message' ? b.seq : b.chunkSeq) ?? 0;
  return sa - sb;
}

/**
 * Merges lines into a thread's: one per id (a history entry wins over the live copy, for its
 * cursor), in conversation order. Returns `current` itself when nothing is new.
 */
export function mergeEntries(current: ChatEntry[], incoming: ChatEntry[]): ChatEntry[] {
  const byId = new Map(current.map((e) => [e.id, e]));
  let changed = false;
  for (const e of incoming) {
    const known = byId.get(e.id);
    if (known && (known.cursor !== undefined || e.cursor === undefined)) continue;
    byId.set(e.id, known ? { ...known, cursor: e.cursor } : e);
    changed = true;
  }
  if (!changed) return current;
  return [...byId.values()].sort(compareEntries);
}

/** The id a live `message.sent` has in the history. */
export const messageEntryId = (messageId: Id) => `m:${messageId}`;
/** The id a live `text` chunk has in the history. */
export const replyEntryId = (agentId: Id, seq: number) => `r:${agentId}:${seq}`;

/** The live lines of an agent's conversation: the messages sent to it (not its turn prompts) and its non-blank text. */
export function liveEntries(
  agentId: Id,
  messages: readonly ChatMessage[],
  chunks: readonly TranscriptChunk[],
): ChatEntry[] {
  return [
    ...messages
      .filter((m) => !m.turn)
      .map((m): ChatEntry => ({
        id: messageEntryId(m.messageId),
        agentId,
        kind: 'message',
        at: m.at,
        sender: m.sender,
        text: m.text,
        messageId: m.messageId,
        seq: m.seq,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
      })),
    ...chunks
      .filter((c) => c.kind === 'text' && c.text.trim() !== '')
      .map((c): ChatEntry => ({
        id: replyEntryId(agentId, c.seq),
        agentId,
        kind: 'reply',
        at: c.at,
        sender: { type: 'agent', id: agentId },
        text: c.text,
        chunkSeq: c.seq,
      })),
  ];
}

/** A card shown in a thread (decision 52: placed by the time it was created). */
export type ThreadCardItem =
  | { kind: 'proposal'; id: Id; at: string; proposal: Proposal }
  | { kind: 'question'; id: Id; at: string; question: Question }
  /** A question set (P8-21): one card for its rows, `id` the set's id. */
  | { kind: 'questionSet'; id: Id; at: string; setId: Id };

/** The world as the protocol's thread rules read it (`ThreadLookup`). */
const lookupOf = (world: Pick<WorldState, 'agents' | 'tasks'>): ThreadLookup => ({
  agent: (id) => world.agents[id],
  task: (id) => world.tasks[id],
});

/**
 * Whose thread a question belongs to (`questionOwner` of the protocol, P8-17 moved it there so
 * the server's reply check shares it): the project's Waykeeper, or the Harmonizer.
 */
export function questionOwner(
  world: Pick<WorldState, 'agents' | 'tasks'>,
  q: Question,
): QuestionOwner | undefined {
  return ownerOf(lookupOf(world), q);
}

/**
 * The cards of a brain's thread (the protocol's `threadShowsProposal` / `threadShowsQuestion`,
 * which the server's reply check shares): for a Waykeeper, its project's plan cards and promotion
 * requests and its project's questions; for the Harmonizer, every other card — and a project's
 * clarifications that reached the user (decision 55). A question set's rows are one card.
 */
export function threadCards(
  world: Pick<WorldState, 'agents' | 'tasks' | 'proposals' | 'questions'>,
  agent: Agent | undefined,
): ThreadCardItem[] {
  if (!agent || agent.role === 'steward') return [];
  const look = lookupOf(world);
  const cards: ThreadCardItem[] = [];
  for (const p of Object.values(world.proposals)) {
    if (threadShowsProposal(agent, p))
      cards.push({ kind: 'proposal', id: p.id, at: p.createdAt, proposal: p });
  }
  const sets = new Map<Id, ThreadCardItem & { kind: 'questionSet' }>();
  for (const q of Object.values(world.questions)) {
    if (!threadShowsQuestion(look, agent, q)) continue;
    const set = q.context.set;
    if (!set) {
      cards.push({ kind: 'question', id: q.id, at: q.createdAt, question: q });
      continue;
    }
    // A set is one card (P8-21), shown when the thread shows any of its rows, at its first row.
    const card = sets.get(set.id);
    if (!card)
      sets.set(set.id, { kind: 'questionSet', id: set.id, at: q.createdAt, setId: set.id });
    else if (q.createdAt < card.at) card.at = q.createdAt;
  }
  cards.push(...sets.values());
  return cards.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

export type ThreadItem =
  | { kind: 'entry'; key: string; entry: ChatEntry }
  | { kind: 'card'; key: string; card: ThreadCardItem };

/**
 * The thread as shown: the lines, with each card after the lines up to its creation time. While
 * older history is still unread, a card older than the oldest line waits until it is paged in.
 */
export function threadItems(entries: ChatEntry[], cards: ThreadCardItem[], hasOlder: boolean) {
  const first = entries[0]?.at;
  const shown = hasOlder && first !== undefined ? cards.filter((c) => c.at >= first) : cards;
  const items: ThreadItem[] = [];
  let c = 0;
  for (const entry of entries) {
    while (c < shown.length && shown[c]!.at < entry.at) {
      const card = shown[c++]!;
      items.push({ kind: 'card', key: `card-${card.id}`, card });
    }
    items.push({ kind: 'entry', key: entry.id, entry });
  }
  for (; c < shown.length; c++) {
    const card = shown[c]!;
    items.push({ kind: 'card', key: `card-${card.id}`, card });
  }
  return items;
}

/** A page read from the server, or undefined when the reply is not one. */
function asPage(reply: unknown): ConversationResponse | undefined {
  const parsed = ConversationResponse.safeParse(reply);
  return parsed.success ? parsed.data : undefined;
}

// --- the store -------------------------------------------------------------------------------

export interface ConversationState {
  threads: Record<Id, Thread>;
  /** The log the threads were read from; another log drops them all. */
  logId?: string | undefined;
  /** Drops every thread when `logId` is a different log than the one they came from. */
  forLog: (logId: string | undefined) => void;
  /**
   * Opens a thread: reads the newest page (or, for a thread read before, catches up from its
   * newest entry) and records where the live transcript starts. Resolves when done.
   */
  open: (agentId: Id, fetch: ConversationFetch) => Promise<void>;
  /** Brings the thread up to date after a snapshot catch-up (see `forward`). */
  catchUp: (agentId: Id, fetch: ConversationFetch) => Promise<void>;
  /** Pages one page back (scrolling up). */
  loadOlder: (agentId: Id, fetch: ConversationFetch) => Promise<void>;
  /** Adds live lines, so the stream's capped buffers never lose a line the thread showed. */
  absorb: (agentId: Id, entries: ChatEntry[]) => void;
  /** The chat closed: the live transcript no longer starts at its `liveFrom`. */
  close: (agentId: Id) => void;
  /**
   * The composer's unsent text per agent (P4-10), so it outlives the composer: switching agents,
   * or crossing the stacked layout's breakpoint (which remounts the chat), keeps each draft. Kept
   * across logs (it is what the user typed, not history); cleared when sent, and by `reset`.
   */
  drafts: Record<Id, string>;
  setDraft: (agentId: Id, text: string) => void;
  /** The line each composer replies to (P8-17), kept like the drafts; cleared when sent. */
  replies: Record<Id, ReplyDraft>;
  setReply: (agentId: Id, reply: ReplyDraft | undefined) => void;
  reset: () => void;
}

export const useConversationStore = create<ConversationState>((set, get) => {
  const thread = (agentId: Id): Thread => get().threads[agentId] ?? EMPTY;
  const patch = (agentId: Id, change: (t: Thread) => Partial<Thread>) =>
    set((s) => {
      const t = s.threads[agentId] ?? EMPTY;
      return { threads: { ...s.threads, [agentId]: { ...t, ...change(t) } } };
    });
  const failed = (agentId: Id, error: unknown) =>
    patch(agentId, () => ({
      loaded: true,
      loadingOlder: false,
      error: error instanceof Error ? error.message : 'the history could not be read',
    }));

  /**
   * Reads the newest page. `restart`: the thread's held history may not reach it (the catch-up
   * gave up), so held lines older than the page are dropped — the thread is then the newest page
   * plus what pages back from it, with no hole — and its cursors are the page's.
   */
  const newest = async (
    agentId: Id,
    fetch: ConversationFetch,
    restart: boolean,
  ): Promise<number> => {
    const page = asPage(await fetch(agentId, { limit: PAGE }));
    if (!page) throw new Error('the history reply was not understood');
    patch(agentId, (t) => {
      const first = page.entries[0];
      const held =
        restart && first ? t.entries.filter((e) => compareEntries(e, first) >= 0) : t.entries;
      return {
        entries: mergeEntries(held, page.entries),
        oldestCursor: first?.cursor ?? (restart ? undefined : t.oldestCursor),
        newestCursor: page.entries.at(-1)?.cursor ?? (restart ? undefined : t.newestCursor),
        hasOlder: page.hasMore,
        compacted: page.compacted ?? t.compacted,
      };
    });
    return page.lastSeq;
  };

  /**
   * Brings the thread up to date and returns the newest persisted transcript `seq` (the live
   * seam): pages forward from the newest history entry; a thread with no history yet (none read,
   * or only live lines, which have no cursor) reads the newest page instead. When the catch-up
   * cap is hit there is still history between the last page read and now, so the thread restarts
   * from the newest page rather than leave a hole before the live stream.
   */
  const forward = async (agentId: Id, fetch: ConversationFetch): Promise<number> => {
    if (thread(agentId).newestCursor === undefined) return newest(agentId, fetch, false);
    for (let i = 0; i < MAX_CATCH_UP_PAGES; i++) {
      const after = thread(agentId).newestCursor!;
      const page = asPage(await fetch(agentId, { after, limit: 200 }));
      if (!page) throw new Error('the history reply was not understood');
      patch(agentId, (t) => ({
        entries: mergeEntries(t.entries, page.entries),
        newestCursor: page.entries.at(-1)?.cursor ?? t.newestCursor,
        oldestCursor: t.oldestCursor ?? page.entries[0]?.cursor,
        compacted: page.compacted ?? t.compacted,
      }));
      if (!page.hasMore) return page.lastSeq;
    }
    return newest(agentId, fetch, true);
  };

  return {
    threads: {},
    drafts: {},
    replies: {},
    forLog: (logId) => {
      const current = get().logId;
      if (logId === undefined || logId === current) return;
      set(current === undefined ? { logId } : { logId, threads: {} });
    },
    open: async (agentId, fetch) => {
      try {
        const lastSeq = await forward(agentId, fetch);
        patch(agentId, () => ({ loaded: true, error: undefined, liveFrom: lastSeq }));
      } catch (error) {
        failed(agentId, error);
      }
    },
    catchUp: async (agentId, fetch) => {
      try {
        await forward(agentId, fetch);
      } catch (error) {
        failed(agentId, error);
      }
    },
    loadOlder: async (agentId, fetch) => {
      const t = thread(agentId);
      if (!t.hasOlder || t.loadingOlder || t.oldestCursor === undefined) return;
      patch(agentId, () => ({ loadingOlder: true }));
      try {
        const page = asPage(await fetch(agentId, { before: t.oldestCursor, limit: PAGE }));
        if (!page) throw new Error('the history reply was not understood');
        patch(agentId, (cur) => ({
          entries: mergeEntries(cur.entries, page.entries),
          oldestCursor: page.entries[0]?.cursor ?? cur.oldestCursor,
          hasOlder: page.hasMore,
          loadingOlder: false,
          compacted: page.compacted ?? cur.compacted,
        }));
      } catch (error) {
        failed(agentId, error);
      }
    },
    absorb: (agentId, entries) => {
      const t = thread(agentId);
      const merged = mergeEntries(t.entries, entries);
      if (merged !== t.entries) patch(agentId, () => ({ entries: merged }));
    },
    close: (agentId) => {
      if (get().threads[agentId]) patch(agentId, () => ({ liveFrom: undefined }));
    },
    setDraft: (agentId, text) =>
      set((s) => {
        if ((s.drafts[agentId] ?? '') === text) return {};
        if (text !== '') return { drafts: { ...s.drafts, [agentId]: text } };
        const { [agentId]: _sent, ...rest } = s.drafts;
        return { drafts: rest };
      }),
    setReply: (agentId, reply) =>
      set((s) => {
        if (reply) return { replies: { ...s.replies, [agentId]: reply } };
        if (!(agentId in s.replies)) return {};
        const { [agentId]: _sent, ...rest } = s.replies;
        return { replies: rest };
      }),
    reset: () => set({ threads: {}, drafts: {}, replies: {}, logId: undefined }),
  };
});

/**
 * Where the live transcript of an agent should start, as far as an open chat knows (0: from the
 * start). The session's `transcriptSince` takes the larger of this and the store's last chunk.
 */
export function conversationSince(agentId: Id): number {
  return useConversationStore.getState().threads[agentId]?.liveFrom ?? 0;
}
