import { useCallback, useSyncExternalStore } from 'react';

/**
 * Below this width the panel's top bar is the compact one (P3-12): the brand, the "waiting for
 * you" count and a menu button. Above it the full bar fits in one row, or two at worst.
 */
export const COMPACT_TOP_BAR_QUERY = '(max-width: 760px)';

function mediaQuery(query: string): MediaQueryList | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
  try {
    return window.matchMedia(query);
  } catch {
    return undefined;
  }
}

/**
 * Whether a CSS media query matches, kept current as the window changes. Without `matchMedia`
 * (jsdom, old browsers) nothing matches, so the wide layout is the default.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = mediaQuery(query);
      if (!list) return () => {};
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => mediaQuery(query)?.matches ?? false,
    () => false,
  );
}
