import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One REST-paged list of the history view (P25-10): the newest page whenever `key` (the filters)
 * changes, older pages appended on `more()` with the last item's cursor, `reload()` to read the
 * newest page again. A reply for filters that changed meanwhile is dropped; an item already held
 * (same id) is not added twice.
 *
 * A reload keeps the list it has on screen until the new first page arrives (no flash to
 * "Loading…"); only new filters start from an empty list. `markStale()` records that the stream
 * saw an item enter the history after this list was read (`stale`, cleared by the next first
 * page): the page offers a refresh rather than splicing the item in.
 */
export interface Paged<T> {
  items: T[];
  hasMore: boolean;
  status: 'loading' | 'ready' | 'error';
  error?: string | undefined;
  /** An older page is being read. */
  loadingMore: boolean;
  /** The newest page is being read again; `items` are the previous read's meanwhile. */
  refreshing: boolean;
  /** Something entered the history since the newest page was read. */
  stale: boolean;
  more: () => void;
  reload: () => void;
  markStale: () => void;
}

interface Held<T> {
  /** The filters and reload count these items were read for. */
  forKey: string | undefined;
  /** The filters alone. */
  filters: string | undefined;
  items: T[];
  hasMore: boolean;
  error?: string | undefined;
  loadingMore: boolean;
  stale: boolean;
}

export function usePaged<T extends { cursor: string }>(
  key: string,
  load: (before: string | undefined) => Promise<{ items: T[]; hasMore: boolean }>,
  idOf: (item: T) => string,
): Paged<T> {
  const [generation, setGeneration] = useState(0);
  const fullKey = `${generation}:${key}`;
  const [held, setHeld] = useState<Held<T>>({
    forKey: undefined,
    filters: undefined,
    items: [],
    hasMore: false,
    loadingMore: false,
    stale: false,
  });
  const latest = useRef({ load, idOf, fullKey });
  useEffect(() => {
    latest.current = { load, idOf, fullKey };
  });

  useEffect(() => {
    let cancelled = false;
    const filters = fullKey.slice(fullKey.indexOf(':') + 1);
    latest.current
      .load(undefined)
      .then((page) => {
        if (!cancelled)
          setHeld({ forKey: fullKey, filters, ...page, loadingMore: false, stale: false });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const error = (e as Error).message;
        setHeld((s) =>
          // A failed refresh keeps what is on screen, with the error under it.
          s.filters === filters
            ? { ...s, forKey: fullKey, error, loadingMore: false }
            : {
                forKey: fullKey,
                filters,
                items: [],
                hasMore: false,
                error,
                loadingMore: false,
                stale: false,
              },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [fullKey]);

  const ready = held.forKey === fullKey;
  // A reload of the same filters: the previous read stays on screen until the new one arrives.
  const refreshing = !ready && held.forKey !== undefined && held.filters === key;
  const shown = ready || refreshing;
  const more = useCallback(() => {
    const last = held.items.at(-1);
    if (!last || held.loadingMore || held.forKey !== latest.current.fullKey) return;
    const forKey = held.forKey;
    setHeld((s) => ({ ...s, loadingMore: true }));
    latest.current
      .load(last.cursor)
      .then((page) =>
        setHeld((s) => {
          if (s.forKey !== forKey) return s;
          const idOf = latest.current.idOf;
          const known = new Set(s.items.map(idOf));
          return {
            ...s,
            items: [...s.items, ...page.items.filter((i) => !known.has(idOf(i)))],
            hasMore: page.hasMore,
            error: undefined,
            loadingMore: false,
          };
        }),
      )
      .catch((e: unknown) =>
        setHeld((s) =>
          s.forKey === forKey ? { ...s, loadingMore: false, error: (e as Error).message } : s,
        ),
      );
  }, [held]);
  const reload = useCallback(() => setGeneration((g) => g + 1), []);
  const markStale = useCallback(() => setHeld((s) => (s.stale ? s : { ...s, stale: true })), []);

  return {
    items: shown ? held.items : [],
    hasMore: ready && held.hasMore,
    status: !shown ? 'loading' : held.error && held.items.length === 0 ? 'error' : 'ready',
    error: shown ? held.error : undefined,
    loadingMore: ready && held.loadingMore,
    refreshing,
    stale: shown && held.stale,
    more,
    reload,
    markStale,
  };
}
