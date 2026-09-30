import { GalacticClient } from './client.js';
import { useAppStore } from '../state/store.js';

export const TOKEN_KEY = 'galactic.token';
/** Written by earlier builds; removed on start so a stale value can never be sent (P0-12). */
const LEGACY_LAST_EVENT_KEY = 'galactic.lastEventId';

const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode etc.: memory only */
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/** The saved token, or the one `/health` hands to same-machine callers, or nothing. */
export async function discoverToken(): Promise<string | undefined> {
  const saved = storage.get(TOKEN_KEY);
  if (saved) return saved;
  try {
    const res = await fetch('/health');
    if (!res.ok) return undefined;
    const body = (await res.json()) as { token?: string };
    if (body.token) {
      storage.set(TOKEN_KEY, body.token);
      return body.token;
    }
  } catch {
    /* server not reachable yet */
  }
  return undefined;
}

export function saveToken(token: string): void {
  storage.set(TOKEN_KEY, token);
}

export function forgetToken(): void {
  storage.remove(TOKEN_KEY);
}

/**
 * Starts the resumable client wired to the store. Returns a stop function.
 *
 * `lastEventId` and `logId` live in the client only (P0-12): the world is derived from the stream
 * and is not persisted, so a fresh page load must take a snapshot — resuming from a persisted seq
 * would replay only the tail onto an empty world. Reconnects within the page's life still resume
 * exactly from the last applied seq.
 */
export function startSession(token: string): () => void {
  storage.remove(LEGACY_LAST_EVENT_KEY);
  const store = useAppStore.getState();
  const client = new GalacticClient({
    url: wsUrl(),
    token,
    onMessage: (m) => useAppStore.getState().apply(m),
    onStatus: (status, detail) => useAppStore.getState().setStatus(status, detail),
  });
  store.setStatus('connecting');
  client.connect();
  return () => client.close();
}
