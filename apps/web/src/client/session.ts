import { IDENTITY_TOKEN } from '@galactic/protocol';
import { GalacticClient } from './client.js';
import { conversationSince } from '../state/conversation.js';
import { useAppStore } from '../state/store.js';
import { createNotifier } from '../panel/notifications/notifier.js';
import { syncPush } from '../pwa/push.js';

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

/**
 * Stands in for the token on a device the server authenticates by its Tailscale identity (P7-02):
 * sent where the token would go, ignored by the server, never stored (`@galactic/protocol`).
 */
export { IDENTITY_TOKEN };

/** The fragment key the settings page's QR code carries the token under (P7-02). */
const FRAGMENT_KEY = 'token';

/**
 * The token the fragment handed over in this page life, until a session with it goes live, and
 * the saved token it would replace (P7-02 review): a stale or mistyped QR code must not overwrite
 * a saved token that works.
 */
let unverified: { token: string; previous: string | undefined } | undefined;

/**
 * Takes a token handed over in the URL fragment (`https://<mac>.ts.net/#token=…`, the settings
 * page's QR code; P7-02) and removes it from the address bar and the history entry, so it is
 * neither bookmarked nor shared with the URL. A fragment never reaches a server or its logs, which
 * is why the QR code uses it rather than a query string. The token is not saved yet: `confirmToken`
 * saves it once a session with it goes live, `refuseToken` falls back to the saved one. The
 * identity stand-in is never taken. Returns the token, if there was one.
 */
export function takeTokenFromFragment(): string | undefined {
  let hash: string;
  try {
    hash = window.location.hash;
  } catch {
    return undefined;
  }
  if (!hash.startsWith('#')) return undefined;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has(FRAGMENT_KEY)) return undefined;
  const token = params.get(FRAGMENT_KEY)?.trim();
  params.delete(FRAGMENT_KEY);
  const rest = params.toString();
  try {
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search + (rest ? `#${rest}` : ''),
    );
  } catch {
    /* a sandboxed frame: the fragment stays, the token is still not sent anywhere */
  }
  if (!token || token === IDENTITY_TOKEN) return undefined;
  const previous = storage.get(TOKEN_KEY) ?? undefined;
  unverified = previous === token ? undefined : { token, previous };
  return token;
}

/**
 * The token a page load starts with: one handed over in the fragment (not yet saved), else the
 * saved one. Safe to call twice (React's strict mode): the second call finds the fragment gone and
 * returns the same unverified token.
 */
export function initialToken(): string | undefined {
  return takeTokenFromFragment() ?? unverified?.token ?? storage.get(TOKEN_KEY) ?? undefined;
}

/** A session with `token` went live: a token from the fragment is saved now. */
export function confirmToken(token: string): void {
  if (unverified?.token !== token) return;
  unverified = undefined;
  saveToken(token);
}

/**
 * The server refused `token`. A fragment token was never saved: the saved token it would have
 * replaced, if any, is returned to fall back to. Any other token is forgotten.
 */
export function refuseToken(token: string): string | undefined {
  if (unverified?.token === token) {
    const { previous } = unverified;
    unverified = undefined;
    return previous;
  }
  forgetToken();
  return undefined;
}

/**
 * The saved token, or the one `/health` hands to the same machine's browser page, or — on a
 * device the server accepts by its Tailscale identity (P7-02) — `IDENTITY_TOKEN`, or nothing.
 */
export async function discoverToken(): Promise<string | undefined> {
  const handed = takeTokenFromFragment();
  if (handed) return handed;
  const saved = storage.get(TOKEN_KEY);
  if (saved) return saved;
  try {
    const res = await fetch('/health');
    if (!res.ok) return undefined;
    const body = (await res.json()) as { token?: string; identity?: string };
    if (body.token && body.token !== IDENTITY_TOKEN) {
      storage.set(TOKEN_KEY, body.token);
      return body.token;
    }
    if (body.identity) return IDENTITY_TOKEN;
  } catch {
    /* server not reachable yet */
  }
  return undefined;
}

export function saveToken(token: string): void {
  if (token === IDENTITY_TOKEN) return;
  storage.set(TOKEN_KEY, token);
}

export function forgetToken(): void {
  unverified = undefined;
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
  // Desktop notifications fold the same messages, after the store applied them (P25-07).
  const notifier = createNotifier({ token });
  const client = new GalacticClient({
    url: wsUrl(),
    token,
    onMessage: (m) => {
      useAppStore.getState().apply(m);
      notifier.onMessage(m);
    },
    onStatus: (status, detail) => useAppStore.getState().setStatus(status, detail),
    // An open chat starts the live transcript where its history page ended (P25-03).
    transcriptSince: (agentId) =>
      Math.max(
        useAppStore.getState().transcripts[agentId]?.at(-1)?.seq ?? 0,
        conversationSince(agentId),
      ),
  });
  store.setStatus('connecting');
  useAppStore.setState({
    subscribeTranscript: (agentId) => client.subscribeTranscript(agentId),
    unsubscribeTranscript: (agentId) => client.unsubscribeTranscript(agentId),
  });
  client.connect();
  // A push subscription the browser rotated is handed to the server again (P7-04; best effort).
  void syncPush(token);
  return () => {
    useAppStore.setState({ subscribeTranscript: undefined, unsubscribeTranscript: undefined });
    notifier.stop();
    client.close();
  };
}
