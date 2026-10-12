import { useContext, useEffect, useState } from 'react';
import { REMOTE_REASON_SHORT, RemoteStatus } from '@galactic/protocol';
import { ApiContext } from '../../console/hierarchy/shared.js';
import { ApiError, type Api } from '../../console/api.js';

/**
 * Phone access as the panel shows it (P9-16; SPEC decision 137): the top bar's indicator and
 * Settings → Access read one shared poll of `GET /api/remote/status` per API — every 10 s while
 * the page is visible, at once when it becomes visible again, and right after a start or stop.
 */

export const PHONE_POLL_MS = 10_000;

export interface PhoneState {
  /** `undefined` until the first answer. */
  status?: RemoteStatus;
  /** The server has no phone routes (an older or a test server): nothing is shown. */
  unavailable?: boolean;
  error?: string;
}

type Listener = (state: PhoneState) => void;

interface Poller {
  state: PhoneState;
  listeners: Set<Listener>;
  timer?: ReturnType<typeof setInterval> | undefined;
  onVisible?: (() => void) | undefined;
  refresh: () => Promise<void>;
}

const pollers = new WeakMap<Api, Poller>();

function visible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function pollerFor(api: Api): Poller {
  let poller = pollers.get(api);
  if (poller) return poller;
  const p: Poller = {
    state: {},
    listeners: new Set(),
    refresh: async () => {
      if (typeof api.remoteStatus !== 'function') {
        set({ unavailable: true });
        return;
      }
      try {
        // A server without the routes may answer the page itself (a stand-in, an older build).
        const parsed = RemoteStatus.safeParse(await api.remoteStatus());
        set(parsed.success ? { status: parsed.data } : { unavailable: true });
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) set({ unavailable: true });
        else set({ ...p.state, error: (error as Error).message });
      }
    },
  };
  const set = (state: PhoneState) => {
    p.state = state;
    for (const l of p.listeners) l(state);
  };
  pollers.set(api, p);
  poller = p;
  return poller;
}

/** Puts a start's or stop's answer in the shared state at once. */
export function publishPhoneStatus(api: Api, status: RemoteStatus): void {
  const p = pollerFor(api);
  p.state = { status };
  for (const l of p.listeners) l(p.state);
}

function subscribe(api: Api, listener: Listener): () => void {
  const p = pollerFor(api);
  p.listeners.add(listener);
  if (p.listeners.size === 1) {
    void p.refresh();
    p.timer = setInterval(() => {
      if (visible()) void p.refresh();
    }, PHONE_POLL_MS);
    p.onVisible = () => {
      if (visible()) void p.refresh();
    };
    document.addEventListener('visibilitychange', p.onVisible);
  }
  return () => {
    p.listeners.delete(listener);
    if (p.listeners.size === 0) {
      if (p.timer) clearInterval(p.timer);
      if (p.onVisible) document.removeEventListener('visibilitychange', p.onVisible);
      p.timer = undefined;
      p.onVisible = undefined;
    }
  };
}

/** The shared phone status; `undefined` outside a panel (no API in context). */
export function usePhoneStatus(): (PhoneState & { api: Api }) | undefined {
  const api = useContext(ApiContext);
  const [state, setState] = useState<PhoneState>(() => (api ? pollerFor(api).state : {}));
  useEffect(() => {
    if (!api) return;
    return subscribe(api, setState);
  }, [api]);
  return api ? { ...state, api } : undefined;
}

/**
 * The top bar's words: "Phone: online", "Phone: restart needed", "Phone: off" — or, loudly,
 * "Funnel ON: public internet" while Tailscale Funnel is on (whatever else is true).
 */
export function phoneIndicator(status: RemoteStatus): {
  kind: 'online' | 'restart' | 'off' | 'warning';
  label: string;
  tooltip: string;
} {
  if (status.funnel) {
    return {
      kind: 'warning',
      label: 'Funnel ON: public internet',
      tooltip: status.message ?? REMOTE_REASON_SHORT.funnel_on,
    };
  }
  if (status.ready) {
    const n = status.remoteClients.connected;
    return {
      kind: 'online',
      label: 'Phone: online',
      tooltip: `${status.url ?? ''} — ${n === 1 ? '1 phone connected' : `${n} phones connected`}`,
    };
  }
  if (status.reason === 'restart_needed') {
    return {
      kind: 'restart',
      label: 'Phone: restart needed',
      tooltip: status.message ?? 'Restart Mission Control to finish turning on phone access.',
    };
  }
  const reason = status.reason ?? 'error';
  return {
    kind: 'off',
    label: 'Phone: off',
    tooltip: `${REMOTE_REASON_SHORT[reason]}${status.message ? ` — ${status.message}` : ''}`,
  };
}
