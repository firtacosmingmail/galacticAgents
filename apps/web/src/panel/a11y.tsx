import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import { useAppStore } from '../state/store.js';
import { waitingForUserCount } from './inbox-model.js';

/**
 * The panel's keyboard and screen-reader plumbing (P5-04): the skip link, focus on page changes,
 * arrow keys through lists of cards, focus kept in a list whose focused item went away, and the
 * polite announcement of the "waiting for you" count. No three.js, no store writes.
 */

/** The main element of whatever page the panel shows (the dock, settings, history, the wizard). */
export function mainElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.pnl-body main');
}

/** Focuses an element that may not be focusable on its own (`tabindex="-1"` is added). */
export function focusElement(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  if (!el.hasAttribute('tabindex') && !isNativelyFocusable(el)) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: 'nearest' });
  return document.activeElement === el;
}

/**
 * After a control removes itself (a column's "Hide"), puts the focus on the first of `selectors`
 * that exists — the top bar's button that brings the thing back — if the focus was lost meanwhile.
 */
export function focusAfterRemoval(...selectors: string[]): void {
  setTimeout(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    for (const s of selectors) if (focusElement(document.querySelector<HTMLElement>(s))) return;
  }, 0);
}

function isNativelyFocusable(el: HTMLElement): boolean {
  return el.matches('a[href], button, input, select, textarea, summary, [contenteditable="true"]');
}

/**
 * "Skip to main content": the first stop of the page, shown only while focused. Goes to the main
 * area's heading (the selected agent's name in the dock, the page title elsewhere), so the next
 * Tab continues inside the main area.
 */
export function SkipLink() {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    const main = mainElement();
    if (!main) return;
    e.preventDefault();
    focusElement(main.querySelector<HTMLElement>('h1') ?? main);
  };
  return (
    <a className="pnl-skip" href="#main" onClick={onClick}>
      Skip to main content
    </a>
  );
}

/**
 * Moves the focus to the new page's heading when the route changes (/settings, /history, back to
 * the panel), as a screen reader user would otherwise be left on a link of the previous page or
 * on nothing. Only when the focus is lost (the old page unmounted with it) or sits in the top bar
 * that navigated; the "N waiting for you" button keeps its own behaviour (it focuses the inbox).
 * The first render never moves the focus.
 */
export function useRouteFocus(): void {
  const route = useAppStore((s) => s.route);
  const last = useRef(route);
  useEffect(() => {
    if (last.current === route) return;
    last.current = route;
    let tries = 30;
    const attempt = () => {
      const active = document.activeElement as HTMLElement | null;
      const lost = !active || active === document.body || !active.isConnected;
      const fromBar = !!active?.closest('.pnl-top') && !active.closest('.pnl-top-waiting');
      if (!lost && !fromBar) return;
      const main = mainElement();
      const heading = main?.querySelector<HTMLElement>('h1');
      // The main view may wait for the settings read (P25-08's gate): look again next frame.
      if (!heading) {
        if (tries-- > 0) requestFrame(attempt);
        return;
      }
      focusElement(heading);
    };
    attempt();
  }, [route]);
}

const requestFrame = (fn: () => void) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => fn());
  else setTimeout(fn, 16);
};

/** Fields and widgets that use the arrow keys themselves: the list keys leave them alone. */
const OWN_ARROWS =
  'textarea, select, [contenteditable="true"], [role="slider"], [role="separator"], ' +
  '[role="radiogroup"], [role="tablist"], [role="menu"], [role="listbox"], [role="tree"], ' +
  'input:not([type="checkbox"]):not([type="button"]):not([type="submit"]):not([type="reset"])';

export function usesOwnArrows(el: Element): boolean {
  return !!el.closest(OWN_ARROWS);
}

/**
 * What is open and waits for an answer: a menu or popover (`data-escape-layer`, the "More" menu)
 * and a pending confirmation. The arrows would leave it open behind the focus, so they do nothing
 * there; Escape or an answer closes it first.
 */
const OPEN_LAYER = '[data-escape-layer], .agc-confirm';

/** The items of a list that are on screen: not in a closed `<details>`, nor hidden, nor inert. */
export function listItems(container: Element, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.closest('details:not([open]) > :not(summary), [hidden], [inert]'),
  );
}

/**
 * Arrow keys through a list of cards or rows (P5-04): Down / Up move the focus to the next or
 * previous item (the item itself, made focusable with `tabindex="-1"`, so a screen reader reads
 * its name), Home / End to the first and the last. From a button inside a card they move to the
 * neighbouring card too. Tab is untouched: it still walks every control in order, so the arrows
 * are a shortcut, not the only way. Ignored in fields and widgets that use the arrows themselves,
 * and in an open menu or a pending confirmation (they would be left open behind the focus).
 */
export function listKeys(selector: string) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const target = e.target as HTMLElement;
    if (usesOwnArrows(target) || target.closest(OPEN_LAYER)) return;
    const items = listItems(e.currentTarget, selector);
    // The innermost item holding the focus (an answered question's card sits in a card view).
    let current = -1;
    items.forEach((item, i) => {
      if (item === target || item.contains(target)) current = i;
    });
    if (current < 0) return;
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? Math.min(items.length - 1, current + 1)
            : Math.max(0, current - 1);
    e.preventDefault();
    if (next !== current || items[next] !== target) focusElement(items[next]);
  };
}

/**
 * Keeps the keyboard in a list whose focused item went away (P5-04): a question answered, a card
 * approved, a row archived, a confirmation done — React removes the element and the focus would
 * fall back to the page. The focus goes to the item now at the same place (the next one), else the
 * last, else `fallback` (the list's heading or the region). A user who moves the focus elsewhere
 * on purpose (a click outside, Tab away) is left alone.
 */
export function useFocusRescue(
  ref: RefObject<HTMLElement | null>,
  {
    items,
    target,
    fallback,
  }: {
    /** The list's items; the focus goes to the one now at the lost item's place. */
    items?: string;
    /** What to focus in an item (default: the item itself). */
    target?: (item: HTMLElement) => HTMLElement;
    /** Where the focus goes when no item is left (or the list has no items). */
    fallback: (container: HTMLElement) => HTMLElement | null;
  },
): void {
  const callbacks = useRef({ target, fallback });
  useEffect(() => {
    callbacks.current = { target, fallback };
  });
  useEffect(() => {
    const container = ref.current;
    if (!container || typeof MutationObserver === 'undefined') return;
    let held: { target: HTMLElement; index: number } | undefined;
    // The innermost item holding the element (items may nest: a project's row and its tasks').
    const indexOf = (el: Element) => {
      let index = -1;
      if (items)
        listItems(container, items).forEach((item, i) => {
          if (item === el || item.contains(el)) index = i;
        });
      return index;
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement;
      held = { target, index: indexOf(target) };
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !container.contains(next)) held = undefined;
      else if (!next) {
        // Focus left for nothing: a click on the page (keep it so) or the element went away.
        const target = e.target as HTMLElement;
        queueMicrotask(() => {
          if (held?.target === target && target.isConnected) held = undefined;
        });
      }
    };
    const rescue = () => {
      if (!held || held.target.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && active.isConnected) {
        held = undefined;
        return;
      }
      const list = items ? listItems(container, items) : [];
      const index = held.index;
      held = undefined;
      const item = index >= 0 ? list[Math.min(index, list.length - 1)] : undefined;
      const { target: pick, fallback: last } = callbacks.current;
      focusElement(item ? (pick ? pick(item) : item) : last(container));
    };
    const observer = new MutationObserver(rescue);
    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', onFocusOut);
    return () => {
      observer.disconnect();
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('focusout', onFocusOut);
    };
  }, [ref, items]);
}

/**
 * The polite announcement of the "waiting for you" count (decision 58) for screen readers: said
 * when it changes, never on the first load, and once per change (not for every event the stream
 * brings). Visually hidden; the top bar and the inbox show the same number.
 */
export function WaitingAnnouncer() {
  const live = useAppStore((s) => s.status === 'live');
  const count = useAppStore((s) => waitingForUserCount(s.world));
  const [message, setMessage] = useState('');
  const last = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!live) return;
    const before = last.current;
    last.current = count;
    if (before === undefined || before === count) return;
    setMessage(
      count === 0
        ? 'Nothing waits for you any more.'
        : count > before
          ? `New in the inbox: ${count} waiting for you.`
          : `${count} waiting for you.`,
    );
  }, [live, count]);
  return (
    <div className="pnl-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
