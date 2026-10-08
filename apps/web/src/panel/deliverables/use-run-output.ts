import { useEffect, useMemo, useState } from 'react';
import type { Id, RunOutputChunk } from '@galactic/protocol';
import { useApi } from '../../console/hierarchy/shared.js';
import { useAppStore } from '../../state/store.js';

/** Chunks per REST page (the endpoint allows 1–5000). */
export const RUN_OUTPUT_PAGE = 1_000;
/**
 * REST pages read before the stream takes over. The stream's backlog is the newest part only
 * (P9-12 review N7): a longer output shows its start and its newest part, with `gap` set.
 */
export const RUN_OUTPUT_PAGES = 8;

const NO_CHUNKS: RunOutputChunk[] = [];

export interface RunOutputState {
  chunks: RunOutputChunk[];
  status: 'loading' | 'ready' | 'error';
  error?: string | undefined;
  /** The server dropped output before this `seq` (its per-run size limit, decision 130). */
  truncatedBefore?: number | undefined;
  /** Chunks between two held ones are not shown (a long output: its start and its end are). */
  gap?: boolean;
}

/**
 * A run's output for the run view (P9-10; TECHNOLOGY §9.8): the stored output read over REST,
 * page by page from the start (`after`), then the live stream (`run.subscribe`) from the newest
 * `seq` held — so a chunk still buffered on the server arrives on the stream, none twice (the
 * store merges by `seq`). A failed page still subscribes from what is held. The output is
 * forgotten when the view closes.
 */
export function useRunOutput(runId: Id): RunOutputState {
  const api = useApi();
  const chunks = useAppStore((s) => s.runOutputs[runId] ?? NO_CHUNKS);
  const logId = useAppStore((s) => s.logId);
  const subscribe = useAppStore((s) => s.subscribeRun);
  const unsubscribe = useAppStore((s) => s.unsubscribeRun);
  const [read, setRead] = useState<Omit<RunOutputState, 'chunks'> & { for: Id }>({
    for: runId,
    status: 'loading',
  });

  useEffect(() => {
    const { addRunOutput } = useAppStore.getState();
    let cancelled = false;
    let subscribed = false;
    void (async () => {
      let truncatedBefore: number | undefined;
      try {
        let after = 0;
        for (let page = 0; page < RUN_OUTPUT_PAGES; page++) {
          const got = await api.runOutput(runId, { after, limit: RUN_OUTPUT_PAGE });
          if (cancelled) return;
          if (!Array.isArray(got?.chunks)) throw new Error('unreadable run output');
          truncatedBefore ??= got.truncatedBefore;
          addRunOutput(runId, got.chunks);
          after = got.chunks.at(-1)?.seq ?? after;
          if (!got.hasMore || got.chunks.length === 0) break;
        }
        setRead({ for: runId, status: 'ready', truncatedBefore });
      } catch (e) {
        if (cancelled) return;
        setRead({ for: runId, status: 'error', error: (e as Error).message, truncatedBefore });
      }
      subscribed = true;
      subscribe?.(runId);
    })();
    return () => {
      cancelled = true;
      if (subscribed) unsubscribe?.(runId);
      useAppStore.getState().dropRunOutput(runId);
    };
  }, [api, runId, logId, subscribe, unsubscribe]);

  const gap = useMemo(
    () => chunks.some((c, i) => i > 0 && c.seq > chunks[i - 1]!.seq + 1),
    [chunks],
  );
  if (read.for !== runId) return { chunks, status: 'loading' };
  return {
    chunks,
    ...(gap ? { gap } : {}),
    status: read.status,
    error: read.error,
    truncatedBefore: read.truncatedBefore,
  };
}
