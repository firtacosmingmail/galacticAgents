import { showInbox } from './inbox-visibility.js';
import { openPhoneView } from './phone-view.js';
import { COMPACT_TOP_BAR_QUERY } from './use-media-query.js';
import { prefersReducedMotion } from '../scene/motion.js';

/**
 * Bringing the inbox — or one question's card in it — into view (P3-12's "N waiting for you"
 * button; P4-05's question beacons). No React, no three.js. A hidden inbox (P4-12) is shown
 * first: both look for it over a few frames, while it mounts.
 */

/** The inbox section's id (`Panel.tsx`). */
export const INBOX_ID = 'pnl-inbox';

/** How long a revealed card keeps its highlight, in milliseconds. */
export const REVEAL_HIGHLIGHT_MS = 1600;
/** The class a revealed card carries meanwhile. */
export const REVEALED_CLASS = 'is-revealed';

/**
 * Makes the inbox mountable: on a phone it opens full screen (P8-18), leaving this browser's
 * wide-screen "hidden" choice alone; elsewhere a hidden inbox is shown (P4-12).
 */
function bringInbox(): void {
  if (openPhoneView('inbox') || isPhone()) return; // a phone panel still mounting: try again
  showInbox();
}

/** A phone's width (`COMPACT_TOP_BAR_QUERY`), where the inbox is a full view (P8-18). */
export function isPhone(): boolean {
  try {
    return (
      typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_TOP_BAR_QUERY).matches
    );
  } catch {
    return false;
  }
}

/** Smooth scrolling, unless the user asked for reduced motion (P5-04): then it jumps. */
export const scrollBehavior = (): ScrollBehavior => (prefersReducedMotion() ? 'auto' : 'smooth');

const nextFrame = (fn: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
};

/**
 * Scrolls the inbox into view and focuses it, once it is mounted: from the settings or history
 * page the panel first navigates back to the main view, whose columns may wait for the settings
 * read (P25-08's gate), so this looks for the inbox over a few frames. While the first-run wizard
 * shows, the inbox never mounts: it gives up after about a second, having still navigated home.
 */
export function revealInbox(triesLeft = 60): void {
  bringInbox();
  const inbox = document.getElementById(INBOX_ID);
  if (inbox) {
    inbox.scrollIntoView?.({ block: 'start', behavior: scrollBehavior() });
    inbox.focus({ preventScroll: true });
    return;
  }
  if (triesLeft > 0) nextFrame(() => revealInbox(triesLeft - 1));
}

/** A question's card in the inbox (`QuestionCard`'s `data-question-id`), if it is shown. */
export function inboxCard(questionId: string): HTMLElement | null {
  const inbox = document.getElementById(INBOX_ID);
  if (!inbox) return null;
  for (const el of inbox.querySelectorAll<HTMLElement>('[data-question-id]')) {
    if (el.dataset['questionId'] === questionId) return el;
  }
  return null;
}

/**
 * Opens one question in the inbox: scrolls its card into view (the inbox column scrolls on its
 * own, decision 71; on narrow screens the column scrolls with the scene), focuses it (made
 * focusable for that: `tabindex="-1"`, so the keyboard continues from there without the focus
 * landing on "allow") and highlights it briefly. Waits a few frames for the inbox to mount; when
 * the card cannot be found (answered meanwhile, the inbox not mounted) it reveals the inbox
 * itself. `true` when the card was found at once.
 */
export function revealQuestion(questionId: string, triesLeft = 30): boolean {
  bringInbox();
  const card = inboxCard(questionId);
  if (card) {
    if (!card.hasAttribute('tabindex')) card.setAttribute('tabindex', '-1');
    card.scrollIntoView?.({ block: 'nearest', behavior: scrollBehavior() });
    card.focus({ preventScroll: true });
    card.classList.add(REVEALED_CLASS);
    setTimeout(() => card.classList.remove(REVEALED_CLASS), REVEAL_HIGHLIGHT_MS);
    return true;
  }
  if (triesLeft > 0) nextFrame(() => void revealQuestion(questionId, triesLeft - 1));
  else revealInbox(0);
  return false;
}
