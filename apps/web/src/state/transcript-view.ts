import type { Id, TranscriptChunk } from '@galactic/protocol';

/**
 * The Steward view's transcript state (P25-05): how far back the REST history has been read for
 * each agent, and whether more is there. The chunks themselves stay in the store's `transcripts`
 * (the live stream lands there, and the session resumes `transcript.subscribe` from its newest
 * `seq`), so the backfill and the live stream share one list, ordered and deduplicated by `seq`.
 */

export interface TranscriptView {
  /** `loading` until the newest page arrived (or failed); the live stream starts after it. */
  status: 'loading' | 'ready' | 'error';
  /** The REST history has older chunks than the oldest one held. */
  hasMore: boolean;
  /** An older page is being read (scrolling back). */
  loadingOlder: boolean;
  error?: string | undefined;
}

export interface TranscriptViewSlice {
  transcriptViews: Record<Id, TranscriptView>;
  /** Updates an agent's view state (created on first use). */
  setTranscriptView: (agentId: Id, patch: Partial<TranscriptView>) => void;
  /**
   * Merges a REST page into the agent's chunks. `newest` is the first page of a view: held chunks
   * older than it are dropped, because there may be a hole between them and the page (they came
   * from an earlier visit); `older` is a page read by scrolling back, before the oldest held.
   */
  addTranscriptPage: (agentId: Id, chunks: TranscriptChunk[], mode: 'newest' | 'older') => void;
}

const NEW_VIEW: TranscriptView = { status: 'loading', hasMore: false, loadingOlder: false };

/** The union of two chunk lists, one entry per `seq`, in `seq` order (held entries win). */
export function mergeChunks(
  held: TranscriptChunk[],
  page: TranscriptChunk[],
  mode: 'newest' | 'older',
): TranscriptChunk[] {
  if (page.length === 0) return held;
  const first = page[0]!.seq;
  const kept = mode === 'newest' ? held.filter((c) => c.seq >= first) : held;
  const bySeq = new Map<number, TranscriptChunk>();
  for (const c of page) bySeq.set(c.seq, c);
  for (const c of kept) bySeq.set(c.seq, c);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

type SliceState = TranscriptViewSlice & { transcripts: Record<Id, TranscriptChunk[]> };
type Set = (fn: (s: SliceState) => Partial<SliceState>) => void;

export function createTranscriptViewSlice(set: Set): TranscriptViewSlice {
  return {
    transcriptViews: {},
    setTranscriptView: (agentId, patch) =>
      set((s) => ({
        transcriptViews: {
          ...s.transcriptViews,
          [agentId]: { ...(s.transcriptViews[agentId] ?? NEW_VIEW), ...patch },
        },
      })),
    addTranscriptPage: (agentId, chunks, mode) =>
      set((s) => {
        const held = s.transcripts[agentId] ?? [];
        const merged = mergeChunks(held, chunks, mode);
        return merged === held ? {} : { transcripts: { ...s.transcripts, [agentId]: merged } };
      }),
  };
}
