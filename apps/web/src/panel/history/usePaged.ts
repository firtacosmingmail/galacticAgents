import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One REST-paged list of the history view (P25-10): the newest page whenever `key` (the filters)
 * changes, older pages appended on `more()` with the last item's cursor, `reload()` to read the
 * newest page again. A reply for filters that changed meanwhile is dropped; an item already held
 * (same id) is not added twice.
 */
export interface Paged<T> {
  items: T[];
  hasMore: boolean;
  status: 'loading' | 'ready' | 'error';
  error?: string | undefined;
  /** An older page is being read. */
  loadingMore: boolean;
  more: () => void;
  reload: () => void;
}

interface Held<T> {
  /** The filters (and reload count) these items were read for. */
  forKey: string | undefined;
  items: T[];
  hasMore: boolean;
  error?: string | undefined;
  loadingMore: boolean;
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
    items: [],
    hasMore: false,
    loadingMore: false,
  });
  const latest = useRef({ load, idOf, fullKey });
  useEffect(() => {
    latest.current = { load, idOf, fullKey };
  });

  useEffect(() => {
    let cancelled = false;
    latest.current
      .load(undefined)
      .then((page) => {
        if (!cancelled) setHeld({ forKey: fullKey, ...page, loadingMore: false });
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setHeld({
            forKey: fullKey,
            items: [],
            hasMore: false,
            error: (e as Error).message,
            loadingMore: false,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [fullKey]);

  const ready = held.forKey === fullKey;
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

  return {
    items: ready ? held.items : [],
    hasMore: ready && held.hasMore,
    status: !ready ? 'loading' : held.error && held.items.length === 0 ? 'error' : 'ready',
    error: ready ? held.error : undefined,
    loadingMore: ready && held.loadingMore,
    more,
    reload,
  };
}
