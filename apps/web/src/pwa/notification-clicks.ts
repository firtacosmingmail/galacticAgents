import { NotificationTarget, PUSH_FOCUS_FRAGMENT } from '@galactic/protocol';
import { useAppStore } from '../state/store.js';
import { focusTarget } from '../panel/notifications/focus.js';

/**
 * Taps on notifications the service worker shows (P7-04): a push, or one of the page's own
 * desktop notifications shown through the worker. The worker either messages an open window
 * (`NOTIFICATION_CLICK` with the target) or opens the app at `/#focus=<kind>:<id>` (`inbox` when
 * there is no target). Either way the page selects the item as a desktop notification's click
 * does (decision 59), once the world has arrived — before the first snapshot the question or
 * project is not known yet and the click would fall back to the inbox.
 */

/** `inbox` (no target) or a target. */
type Focus = NotificationTarget | 'inbox';

function parseFocus(raw: string | null): Focus | undefined {
  if (!raw) return undefined;
  if (raw === 'inbox') return 'inbox';
  const at = raw.indexOf(':');
  if (at <= 0) return undefined;
  const parsed = NotificationTarget.safeParse({ kind: raw.slice(0, at), id: raw.slice(at + 1) });
  return parsed.success ? parsed.data : undefined;
}

/** Reads `#focus=` and removes it from the address bar (other fragment keys are kept). */
export function takeFocusFromFragment(win: Window = window): Focus | undefined {
  const hash = win.location.hash;
  if (!hash.startsWith('#')) return undefined;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has(PUSH_FOCUS_FRAGMENT)) return undefined;
  const focus = parseFocus(params.get(PUSH_FOCUS_FRAGMENT));
  params.delete(PUSH_FOCUS_FRAGMENT);
  const rest = params.toString();
  try {
    win.history.replaceState(
      win.history.state,
      '',
      win.location.pathname + win.location.search + (rest ? `#${rest}` : ''),
    );
  } catch {
    // a sandboxed frame: the fragment stays
  }
  return focus;
}

/** Selects the target once the page holds a snapshot of the world. */
export function focusWhenReady(focus: Focus): () => void {
  const go = () => focusTarget(focus === 'inbox' ? undefined : focus);
  if (useAppStore.getState().snapshots > 0) {
    go();
    return () => undefined;
  }
  const unsubscribe = useAppStore.subscribe((s) => {
    if (s.snapshots > 0) {
      unsubscribe();
      go();
    }
  });
  return unsubscribe;
}

/** Wires both paths; returns a teardown (tests). Call once, at load. */
export function wireNotificationClicks(
  win: Window = window,
  nav: Navigator = navigator,
): () => void {
  const cleanups: (() => void)[] = [];
  const initial = takeFocusFromFragment(win);
  if (initial) cleanups.push(focusWhenReady(initial));
  const sw = 'serviceWorker' in nav ? nav.serviceWorker : undefined;
  if (sw) {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; target?: unknown } | undefined;
      if (!data || data.type !== 'NOTIFICATION_CLICK') return;
      const target = NotificationTarget.safeParse(data.target);
      cleanups.push(focusWhenReady(target.success ? target.data : 'inbox'));
    };
    sw.addEventListener('message', onMessage);
    cleanups.push(() => sw.removeEventListener('message', onMessage));
  }
  return () => cleanups.forEach((c) => c());
}
