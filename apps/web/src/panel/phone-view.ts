import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

/**
 * The phone's one main screen (P8-18, SPEC decision 140). Below the compact width
 * (`COMPACT_TOP_BAR_QUERY`) the panel shows one screen at a time: the chat with the selected brain
 * (the default), the inbox, or the managed agents — the last two full screen, opened from the top
 * bar and closed with their ✕ or Back.
 *
 * A small module store, not component state: the top bar's buttons, `revealInbox` /
 * `revealQuestion` (the scene's beacons) and a notification's click — the last ones not React —
 * all open the inbox. Never persisted: every load starts on the chat.
 *
 * Back closes it, as it closes the navigation sheet (P8-15): opening pushes a history entry of its
 * own (`{phoneView: true}`, same URL), so the system's Back pops that entry and closes the view
 * instead of changing the selection or leaving the installed app. Closed any other way, the view
 * takes its entry back (`history.back()`); switching from one full view to the other keeps the one
 * entry.
 */

export type PhoneView = 'chat' | 'inbox' | 'agents';
export type FullPhoneView = Exclude<PhoneView, 'chat'>;

export interface PhoneViewControl {
  view: PhoneView;
  open: (view: FullPhoneView) => void;
  close: () => void;
}

/** The full view's region id (`PhoneFullView`). */
export const PHONE_VIEW_ID = 'pnl-phone-view';

let view: PhoneView = 'chat';
/** How many mounted phone panels there are (one in practice): opening needs one. */
let active = 0;
/** A `history.back()` of ours whose `popstate` has not arrived yet. */
let backPending = false;
const listeners = new Set<() => void>();

const onViewEntry = (): boolean =>
  typeof window !== 'undefined' &&
  (window.history.state as { phoneView?: unknown } | null)?.phoneView === true;

function enterEntry(): void {
  if (onViewEntry()) return;
  window.history.pushState({ phoneView: true }, '', window.location.href);
}

/** Closed other than by Back: the view's entry goes (once). */
function leaveEntry(): void {
  if (backPending || !onViewEntry()) return;
  backPending = true;
  window.history.back();
}

function set(next: PhoneView): void {
  if (view === next) return;
  view = next;
  for (const l of [...listeners]) l();
}

function onPop(): void {
  if (backPending) {
    // Our own `back()`: the view is already closed — unless it was opened again meanwhile.
    backPending = false;
    if (view !== 'chat') enterEntry();
    return;
  }
  // Back (or the system's back gesture) while open: its entry is gone; close it.
  set('chat');
}

/**
 * Installed once and kept: a panel unmounting while its `back()` is under way must still see that
 * `popstate`, or `backPending` would stay set and swallow the next real Back.
 */
let listening = false;
function listen(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('popstate', onPop);
}

function subscribe(listener: () => void): () => void {
  listen();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a phone panel is mounted, so a full view can open. */
export function phoneViewActive(): boolean {
  return active > 0;
}

/**
 * Opens the inbox or the managed agents full screen; `false` (and nothing happens) when no phone
 * panel is mounted — the caller falls back to the wide layout's behaviour.
 */
export function openPhoneView(next: FullPhoneView): boolean {
  if (active === 0) return false;
  enterEntry();
  set(next);
  return true;
}

/** Back to the chat. */
export function closePhoneView(): void {
  if (view === 'chat') return;
  leaveEntry();
  set('chat');
}

/** The panel's phone view; `active` is the phone layout (compact width, the panel route). */
export function usePhoneView(isActive: boolean): PhoneViewControl {
  const current = useSyncExternalStore(
    subscribe,
    () => view,
    () => 'chat' as const,
  );
  useEffect(() => {
    // A view entry left over from before a reload is not a view any more.
    if (onViewEntry() && !backPending) window.history.replaceState(null, '', window.location.href);
  }, []);
  useEffect(() => {
    if (!isActive) return;
    active++;
    return () => {
      active--;
      // Leaving the phone layout (a rotation, a wider window, another page): back to the chat.
      if (active === 0) closePhoneView();
    };
  }, [isActive]);
  const open = useCallback((next: FullPhoneView) => void openPhoneView(next), []);
  const shown = isActive ? current : 'chat';
  return useMemo(() => ({ view: shown, open, close: closePhoneView }), [shown, open]);
}
