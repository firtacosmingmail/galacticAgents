import { GalacticClient } from './client.js';
import { useAppStore } from '../state/store.js';

export const TOKEN_KEY = 'galactic.token';
export const LAST_EVENT_KEY = 'galactic.lastEventId';

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

export function savedLastEventId(): number | undefined {
  const raw = storage.get(LAST_EVENT_KEY);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Starts the resumable client wired to the store. Returns a stop function. */
export function startSession(token: string): () => void {
  const store = useAppStore.getState();
  const client = new GalacticClient({
    url: wsUrl(),
    token,
    ...(savedLastEventId() !== undefined ? { lastEventId: savedLastEventId() } : {}),
    onMessage: (m) => useAppStore.getState().apply(m),
    onStatus: (status, detail) => useAppStore.getState().setStatus(status, detail),
    onLastEventId: (seq) => storage.set(LAST_EVENT_KEY, String(seq)),
  });
  store.setStatus('connecting');
  client.connect();
  return () => client.close();
}
