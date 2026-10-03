import { useCallback, useEffect } from 'react';
import type { Id, TranscriptChunk } from '@galactic/protocol';
import { useAppStore } from '../../state/store.js';
import type { TranscriptView } from '../../state/transcript-view.js';
import { useApi } from '../../console/hierarchy/shared.js';

/** Chunks per REST page (the endpoint allows 1–200). */
export const TRANSCRIPT_PAGE = 100;

const NO_CHUNKS: TranscriptChunk[] = [];
const LOADING: TranscriptView = { status: 'loading', hasMore: false, loadingOlder: false };

/**
 * An agent's transcript for the Steward view (P25-05, TECHNOLOGY §6.3): the newest page read over
 * REST first, then the live stream subscribed from the newest `seq` held — at least the page's
 * `lastSeq`, the newest *persisted* chunk, so a chunk still buffered on the server arrives on the
 * stream and none is skipped or repeated (the store merges by `seq`). `loadOlder` reads the page
 * before the oldest held chunk (infinite scroll back).
 *
 * The subscription waits for the page: subscribed first, the stream would replay the whole
 * transcript from `seq` 0. A failed page still subscribes (from what is held), so the view goes
 * live either way.
 */
export function useStewardTranscript(agentId: Id) {
  const api = useApi();
  const chunks = useAppStore((s) => s.transcripts[agentId] ?? NO_CHUNKS);
  const view = useAppStore((s) => s.transcriptViews[agentId] ?? LOADING);
  const logId = useAppStore((s) => s.logId);
  const subscribe = useAppStore((s) => s.subscribeTranscript);
  const unsubscribe = useAppStore((s) => s.unsubscribeTranscript);

  useEffect(() => {
    const { setTranscriptView, addTranscriptPage } = useAppStore.getState();
    let cancelled = false;
    let subscribed = false;
    setTranscriptView(agentId, { status: 'loading', loadingOlder: false, error: undefined });
    void (async () => {
      try {
        const page = await api.transcript(agentId, { limit: TRANSCRIPT_PAGE });
        if (cancelled) return;
        if (!Array.isArray(page.chunks)) throw new Error('unreadable transcript page');
        addTranscriptPage(agentId, page.chunks, 'newest');
        setTranscriptView(agentId, { status: 'ready', hasMore: page.hasMore });
      } catch (e) {
        if (cancelled) return;
        setTranscriptView(agentId, { status: 'error', error: (e as Error).message });
      }
      subscribed = true;
      subscribe?.(agentId);
    })();
    return () => {
      cancelled = true;
      if (subscribed) unsubscribe?.(agentId);
    };
  }, [api, agentId, logId, subscribe, unsubscribe]);

  const loadOlder = useCallback(async () => {
    const { transcripts, transcriptViews, setTranscriptView, addTranscriptPage } =
      useAppStore.getState();
    const current = transcriptViews[agentId];
    const oldest = transcripts[agentId]?.[0]?.seq;
    if (!current || current.status !== 'ready' || !current.hasMore || current.loadingOlder) return;
    if (oldest === undefined) return;
    setTranscriptView(agentId, { loadingOlder: true, error: undefined });
    try {
      const page = await api.transcript(agentId, { before: oldest, limit: TRANSCRIPT_PAGE });
      if (!Array.isArray(page.chunks)) throw new Error('unreadable transcript page');
      addTranscriptPage(agentId, page.chunks, 'older');
      setTranscriptView(agentId, { loadingOlder: false, hasMore: page.hasMore });
    } catch (e) {
      setTranscriptView(agentId, { loadingOlder: false, error: (e as Error).message });
    }
  }, [api, agentId]);

  return { chunks, view, loadOlder };
}
