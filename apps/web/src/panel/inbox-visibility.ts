import { useMemo, useSyncExternalStore } from 'react';

/**
 * Per browser: whether the inbox section of the panel's side column is shown (P4-12), like the
 * managed agents (P4-09, decision 69). A device preference, so it lives in localStorage.
 *
 * Unlike the managed agents' choice this one is a small module store, not component state: the
 * top bar's "N waiting for you" and the scene's question beacons (`revealInbox`,
 * `revealQuestion`, which are not React) must be able to show the inbox again before revealing a
 * card. The value is read from storage when the first component subscribes and forgotten when the
 * last one leaves, so a fresh mount (a reload) reads it again.
 */
export const INBOX_VISIBLE_KEY = 'galactic.panel.inbox.visible';

export function readInboxVisible(): boolean {
  try {
    return localStorage.getItem(INBOX_VISIBLE_KEY) !== '0';
  } catch {
    return true;
  }
}

function write(visible: boolean): void {
  try {
    localStorage.setItem(INBOX_VISIBLE_KEY, visible ? '1' : '0');
  } catch {
    // No storage (private mode): the choice lasts while the panel is mounted.
  }
}

let current: boolean | undefined;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) current = undefined;
  };
}

function snapshot(): boolean {
  // Cached only while mounted: with nobody subscribed, storage is the truth.
  if (current !== undefined) return current;
  const visible = readInboxVisible();
  if (listeners.size > 0) current = visible;
  return visible;
}

/** Shows or hides the inbox, remembered in this browser. */
export function setInboxVisible(visible: boolean): void {
  write(visible);
  if (listeners.size === 0 || current === visible) return;
  current = visible;
  for (const l of [...listeners]) l();
}

/** Shows the inbox if it is hidden (the "N waiting" button, a beacon's click). */
export function showInbox(): void {
  if (!snapshot()) setInboxVisible(true);
}

export interface InboxControl {
  /** Shown (the default) or hidden; remembered in this browser. */
  visible: boolean;
  setVisible: (visible: boolean) => void;
}

export function useInboxVisibility(): InboxControl {
  const visible = useSyncExternalStore(subscribe, snapshot, () => true);
  // Stable while nothing changes, so the memoised side column skips unrelated renders.
  return useMemo(() => ({ visible, setVisible: setInboxVisible }), [visible]);
}
